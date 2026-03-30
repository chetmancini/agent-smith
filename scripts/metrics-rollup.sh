#!/bin/bash
# Metrics rollup: process JSONL events into SQLite for querying
# Usage: metrics-rollup.sh [--rotate-at-mb N]
# Supports incremental ingestion — only processes new lines since last run

set -euo pipefail

METRICS_DIR="${METRICS_DIR:-${HOME}/.config/agent-smith}"
EVENTS_FILE="${METRICS_DIR}/events.jsonl"
DB_FILE="${METRICS_DIR}/rollup.db"
ROTATE_AT_BYTES=$((10 * 1024 * 1024)) # 10MB default

ensure_private_dir() {
	local path="$1"
	local old_umask
	old_umask=$(umask)
	umask 077
	mkdir -p "$path" 2>/dev/null || true
	umask "$old_umask"
	chmod 700 "$path" 2>/dev/null || true
}

harden_private_file() {
	local path="$1"
	[ -e "$path" ] || return 0
	chmod 600 "$path" 2>/dev/null || true
}

# Parse args
while [ $# -gt 0 ]; do
	case "$1" in
	--rotate-at-mb)
		ROTATE_AT_BYTES=$(($2 * 1024 * 1024))
		shift 2
		;;
	*)
		shift
		;;
	esac
done

if ! command -v sqlite3 >/dev/null 2>&1; then
	echo "Error: sqlite3 not found (ships with macOS)" >&2
	exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
	echo "Error: jq not found" >&2
	exit 1
fi

if [ ! -f "$EVENTS_FILE" ]; then
	exit 0
fi

ensure_private_dir "$METRICS_DIR"

# Initialize DB schema
sqlite3 "$DB_FILE" <<'SCHEMA'
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    tool TEXT NOT NULL,
    session_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    metadata TEXT NOT NULL,
    ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool);
CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

CREATE TABLE IF NOT EXISTS daily_rollup (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    tool TEXT NOT NULL,
    event_type TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0,
    sample_metadata TEXT,
    UNIQUE(date, tool, event_type)
);

CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_rollup(date);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    tool TEXT NOT NULL,
    started_at TEXT,
    stopped_at TEXT,
    duration_seconds INTEGER,
    stop_reason TEXT,
    event_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    test_loop_count INTEGER NOT NULL DEFAULT 0,
    clarification_count INTEGER NOT NULL DEFAULT 0,
    denial_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_tool ON sessions(tool);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

CREATE TABLE IF NOT EXISTS ingestion_state (
    file_path TEXT PRIMARY KEY,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    last_ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
SCHEMA

# Idempotent column additions for session cost and compression tracking
for col_def in \
	"input_tokens INTEGER DEFAULT 0" \
	"output_tokens INTEGER DEFAULT 0" \
	"cache_read_tokens INTEGER DEFAULT 0" \
	"cache_create_tokens INTEGER DEFAULT 0" \
	"estimated_cost_usd REAL DEFAULT 0.0" \
	"model TEXT" \
	"assistant_turns INTEGER DEFAULT 0" \
	"compression_count INTEGER DEFAULT 0"; do
	sqlite3 "$DB_FILE" "ALTER TABLE sessions ADD COLUMN $col_def;" 2>/dev/null || true
done

# Get last ingested byte offset
OFFSET=$(sqlite3 "$DB_FILE" "SELECT COALESCE(byte_offset, 0) FROM ingestion_state WHERE file_path = '${EVENTS_FILE}';" 2>/dev/null || echo "0")
OFFSET="${OFFSET:-0}"

# Get current file size (macOS stat syntax)
FILE_SIZE=$(stat -f%z "$EVENTS_FILE" 2>/dev/null || stat -c%s "$EVENTS_FILE" 2>/dev/null || echo "0")
FILE_SIZE="${FILE_SIZE:-0}"

HAVE_NEW_EVENTS=1
if [ "$OFFSET" -ge "$FILE_SIZE" ]; then
	HAVE_NEW_EVENTS=0
fi

# Extract new lines and transform to SQL in a single jq pass, wrapped in a transaction
if [ "$HAVE_NEW_EVENTS" -eq 1 ]; then
	{
		echo "BEGIN TRANSACTION;"

		tail -c +"$((OFFSET + 1))" "$EVENTS_FILE" | jq -r '
        # Skip malformed lines
        select(.ts != null and .tool != null and .event_type != null) |

        # Escape single quotes for SQL
        def sq: gsub("'\''"; "'\'''\''");

        # Generate INSERT for events table
        "INSERT INTO events (ts, tool, session_id, event_type, metadata) VALUES ('\''" + (.ts | sq) + "'\'', '\''" + (.tool | sq) + "'\'', '\''" + (.session_id | sq) + "'\'', '\''" + (.event_type | sq) + "'\'', '\''" + (.metadata | tostring | sq) + "'\'');",

        # Generate UPSERT for daily_rollup
        "INSERT INTO daily_rollup (date, tool, event_type, count, session_count, sample_metadata) VALUES ('\''" + (.ts[0:10]) + "'\'', '\''" + (.tool | sq) + "'\'', '\''" + (.event_type | sq) + "'\'', 1, 1, '\''" + (.metadata | tostring | sq) + "'\'') ON CONFLICT(date, tool, event_type) DO UPDATE SET count = count + 1;",

        # Generate UPSERT for sessions
        "INSERT INTO sessions (session_id, tool, event_count" +
            (if .event_type == "session_start" then ", started_at" else "" end) +
            (if .event_type == "session_stop" then ", stopped_at, stop_reason, duration_seconds" else "" end) +
            (if .event_type == "tool_failure" or .event_type == "command_failure" then ", failure_count" else "" end) +
            (if .event_type == "test_failure_loop" then ", test_loop_count" else "" end) +
            (if .event_type == "clarifying_question" then ", clarification_count" else "" end) +
            (if .event_type == "permission_denied" then ", denial_count" else "" end) +
            (if .event_type == "context_compression" then ", compression_count" else "" end) +
        ") VALUES ('\''" + (.session_id | sq) + "'\'', '\''" + (.tool | sq) + "'\'', 1" +
            (if .event_type == "session_start" then ", '\''" + (.ts | sq) + "'\''" else "" end) +
            (if .event_type == "session_stop" then ", '\''" + (.ts | sq) + "'\'', '\''" + ((.metadata.stop_reason // "unknown") | sq) + "'\'', " + ((.metadata.duration_seconds // 0) | tostring) else "" end) +
            (if .event_type == "tool_failure" or .event_type == "command_failure" then ", 1" else "" end) +
            (if .event_type == "test_failure_loop" then ", 1" else "" end) +
            (if .event_type == "clarifying_question" then ", 1" else "" end) +
            (if .event_type == "permission_denied" then ", 1" else "" end) +
            (if .event_type == "context_compression" then ", 1" else "" end) +
        ") ON CONFLICT(session_id) DO UPDATE SET event_count = event_count + 1" +
            (if .event_type == "session_start" then ", started_at = COALESCE(sessions.started_at, excluded.started_at)" else "" end) +
            (if .event_type == "session_stop" then ", stopped_at = excluded.stopped_at, stop_reason = excluded.stop_reason, duration_seconds = excluded.duration_seconds" else "" end) +
            (if .event_type == "tool_failure" or .event_type == "command_failure" then ", failure_count = failure_count + 1" else "" end) +
            (if .event_type == "test_failure_loop" then ", test_loop_count = test_loop_count + 1" else "" end) +
            (if .event_type == "clarifying_question" then ", clarification_count = clarification_count + 1" else "" end) +
            (if .event_type == "permission_denied" then ", denial_count = denial_count + 1" else "" end) +
            (if .event_type == "context_compression" then ", compression_count = compression_count + 1" else "" end) +
        ";"
    ' 2>/dev/null || true

		# Update ingestion state
		echo "INSERT INTO ingestion_state (file_path, byte_offset) VALUES ('${EVENTS_FILE}', ${FILE_SIZE}) ON CONFLICT(file_path) DO UPDATE SET byte_offset = ${FILE_SIZE}, last_ingested_at = datetime('now');"

		echo "COMMIT;"
	} | sqlite3 "$DB_FILE" 2>/dev/null

	harden_private_file "$DB_FILE"
fi # HAVE_NEW_EVENTS

# --- Session cost calculation from transcripts ---
# Cost is calculated here (not in hooks) because the Stop hook fires on every
# turn, and re-parsing the growing transcript each time would be expensive.
# session-start.sh persists session_id + transcript_path pairs.
#
# Transcripts grow during a session, so rollup may run multiple times before
# a session ends (e.g., via analyze-trigger). We always recalculate cost from
# the current transcript contents — later runs pick up new turns. Entries are
# kept in .transcript_paths until the transcript file disappears (session ended
# and cleanup occurred) or a configurable age threshold is reached.
TRANSCRIPT_PATHS_FILE="${METRICS_DIR}/.transcript_paths"
if [ -f "$TRANSCRIPT_PATHS_FILE" ] && command -v jq >/dev/null 2>&1; then
	# Source metrics.sh for _estimate_cost
	SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
	source "${SCRIPT_DIR}/../hooks/lib/metrics.sh"

	# Atomically claim the file so concurrent session-start.sh appends go to
	# a fresh .transcript_paths instead of the one we're processing.
	# If another rollup already claimed it, skip this pass — the winner will
	# process the data, and the next run will pick up anything new.
	WORK_FILE="${TRANSCRIPT_PATHS_FILE}.processing.$$"
	mv -n "$TRANSCRIPT_PATHS_FILE" "$WORK_FILE" 2>/dev/null || {
		# Claim failed — another process got it first, or file vanished.
		# Nothing to process this pass.
		WORK_FILE=""
	}
	if ! { [ -n "$WORK_FILE" ] && [ -f "$WORK_FILE" ]; }; then
		# Claim failed — another rollup process got it first, or file vanished.
		# Nothing to process; the winner handles this pass.
		:
	else

		# Track entries to keep (transcript still exists)
		KEEP_FILE="${TRANSCRIPT_PATHS_FILE}.keep"
		: >"$KEEP_FILE" 2>/dev/null || true

		# File format: <session_id>\t<transcript_path> (one per session)
		while IFS=$'\t' read -r sid tp; do
			[ -n "$sid" ] && [ -n "$tp" ] || continue

			# If the transcript is gone, check for a cost snapshot written by
			# the Stop hook. This covers sessions where rollup never ran while
			# the transcript existed (short sessions, cleanup races).
			if [ ! -f "$tp" ]; then
				snapshot="${METRICS_DIR}/.cost_snapshot_${sid}"
				if [ -f "$snapshot" ]; then
					IFS=$'\t' read -r s_in s_out s_cr s_cc s_model s_turns s_cost <"$snapshot"
					sqlite3 "$DB_FILE" "
					UPDATE sessions SET
						input_tokens = ${s_in:-0},
						output_tokens = ${s_out:-0},
						cache_read_tokens = ${s_cr:-0},
						cache_create_tokens = ${s_cc:-0},
						estimated_cost_usd = ${s_cost:-0},
						model = '${s_model//\'/\'\'}',
						assistant_turns = ${s_turns:-0}
					WHERE session_id = '${sid}';
				" 2>/dev/null || true
					rm -f "$snapshot" 2>/dev/null || true
				fi
				continue
			fi

			# Aggregate tokens and compute per-entry cost to handle mixed-model sessions.
			# Each assistant turn's tokens are priced at its own model rate, then summed.
			aggregated=$(jq -s '
			[.[] | select(.type == "assistant" and .message.usage != null)] |
			{
				input_tokens: (map(.message.usage.input_tokens // 0) | add // 0),
				output_tokens: (map(.message.usage.output_tokens // 0) | add // 0),
				cache_read_input_tokens: (map(.message.usage.cache_read_input_tokens // 0) | add // 0),
				cache_creation_input_tokens: (map(.message.usage.cache_creation_input_tokens // 0) | add // 0),
				model: (last(.[].message.model) // "unknown"),
				assistant_turns: length,
				per_entry: [.[] | {
					input: (.message.usage.input_tokens // 0),
					output: (.message.usage.output_tokens // 0),
					cache_read: (.message.usage.cache_read_input_tokens // 0),
					cache_create: (.message.usage.cache_creation_input_tokens // 0),
					model: (.message.model // "unknown")
				}]
			}
		' "$tp" 2>/dev/null) || {
				printf '%s\t%s\n' "$sid" "$tp" >>"$KEEP_FILE"
				continue
			}

			turns=$(printf '%s' "$aggregated" | jq -r '.assistant_turns')
			if [ "$turns" -le 0 ] 2>/dev/null; then
				# No assistant turns yet — keep entry for next rollup
				printf '%s\t%s\n' "$sid" "$tp" >>"$KEEP_FILE"
				continue
			fi

			input_tok=$(printf '%s' "$aggregated" | jq -r '.input_tokens')
			output_tok=$(printf '%s' "$aggregated" | jq -r '.output_tokens')
			cache_read=$(printf '%s' "$aggregated" | jq -r '.cache_read_input_tokens')
			cache_create=$(printf '%s' "$aggregated" | jq -r '.cache_creation_input_tokens')
			model=$(printf '%s' "$aggregated" | jq -r '.model')

			# Sum cost per entry so mixed-model sessions are priced correctly
			cost=0
			while IFS=$'\t' read -r e_in e_out e_cr e_cc e_model; do
				entry_cost=$(_estimate_cost "$e_in" "$e_out" "$e_cr" "$e_cc" "$e_model")
				cost=$(awk "BEGIN { printf \"%.6f\", $cost + $entry_cost }")
			done < <(printf '%s' "$aggregated" | jq -r '.per_entry[] | [.input, .output, .cache_read, .cache_create, .model] | @tsv')

			# Update the sessions row — always overwrite with latest transcript state
			sqlite3 "$DB_FILE" "
			UPDATE sessions SET
				input_tokens = ${input_tok},
				output_tokens = ${output_tok},
				cache_read_tokens = ${cache_read},
				cache_create_tokens = ${cache_create},
				estimated_cost_usd = ${cost},
				model = '${model//\'/\'\'}',
				assistant_turns = ${turns}
			WHERE session_id = '${sid}';
		" 2>/dev/null || true

			# Cost is now durable in the DB. Clean up snapshot and cursor if they exist
			# (redundant now that DB has fresh transcript-based data).
			rm -f "${METRICS_DIR}/.cost_snapshot_${sid}" "${METRICS_DIR}/.cost_cursor_${sid}" 2>/dev/null || true

			# Keep entry while transcript still exists (for recalculation as session grows).
			printf '%s\t%s\n' "$sid" "$tp" >>"$KEEP_FILE"
		done <"$WORK_FILE"
		rm -f "$WORK_FILE" 2>/dev/null || true

		# Merge surviving entries back. A new .transcript_paths may have been
		# created by session-start.sh while we were processing — append to it.
		if [ -s "$KEEP_FILE" ]; then
			cat "$KEEP_FILE" >>"$TRANSCRIPT_PATHS_FILE" 2>/dev/null || true
			harden_private_file "$TRANSCRIPT_PATHS_FILE"
		fi
		rm -f "$KEEP_FILE" 2>/dev/null || true

	fi # WORK_FILE claimed successfully
fi

# Rotate if file exceeds size limit
if [ "$FILE_SIZE" -gt "$ROTATE_AT_BYTES" ]; then
	rotated_file="${EVENTS_FILE}.$(date +%Y%m%d%H%M%S)"
	mv "$EVENTS_FILE" "$rotated_file"
	harden_private_file "$rotated_file"
	# Reset offset for new file
	sqlite3 "$DB_FILE" "DELETE FROM ingestion_state WHERE file_path = '${EVENTS_FILE}';" 2>/dev/null || true
fi

echo "Rollup complete: processed $((FILE_SIZE - OFFSET)) bytes"
