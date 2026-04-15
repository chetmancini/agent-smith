#!/bin/bash
# Shared metrics emission library for agent session telemetry
# Appends structured JSONL events to ~/.config/agent-smith/events.jsonl
# Never blocks the agent — all operations wrapped in || true
#
# Kill switch: set AGENT_METRICS_ENABLED=0 to disable all metrics collection.
# To fully remove metrics: delete `source metrics.sh` and the single
# metrics_on_* call from each hook script.

AGENT_METRICS_ENABLED="${AGENT_METRICS_ENABLED:-1}"
METRICS_DIR="${METRICS_DIR:-${HOME}/.config/agent-smith}"
METRICS_FILE="${METRICS_DIR}/events.jsonl"

# ============================================================================
# Core utilities
# ============================================================================

_metrics_dir_ready=0
_with_private_umask() {
	local old_umask
	old_umask=$(umask)
	umask 077
	"$@"
	umask "$old_umask"
}

_harden_path() {
	local path="$1"
	local mode="$2"
	[ -e "$path" ] || return 0
	chmod "$mode" "$path" 2>/dev/null || true
}

_ensure_metrics_dir() {
	if [ "$_metrics_dir_ready" -eq 0 ]; then
		_with_private_umask mkdir -p "$METRICS_DIR" 2>/dev/null || true
		_with_private_umask touch "$METRICS_FILE" 2>/dev/null || true
		_harden_path "$METRICS_DIR" 700
		_harden_path "$METRICS_FILE" 600
		_metrics_dir_ready=1
	fi
}

metrics_tool_name() {
	printf '%s' "${AGENT_SMITH_TOOL:-claude}"
}

metrics_session_state_file() {
	printf '%s' "${METRICS_DIR}/.current_session_$(metrics_tool_name)"
}

persist_active_session_id() {
	[ -n "${METRICS_SESSION_ID:-}" ] || return 0

	local state_file
	state_file=$(metrics_session_state_file)
	_ensure_metrics_dir
	printf '%s' "$METRICS_SESSION_ID" >"$state_file" 2>/dev/null || true
	_harden_path "$state_file" 600
}

load_active_session_id() {
	local state_file saved_session_id
	state_file=$(metrics_session_state_file)
	[ -f "$state_file" ] || return 1

	saved_session_id=$(cat "$state_file" 2>/dev/null || true)
	[ -n "$saved_session_id" ] || return 1

	METRICS_SESSION_ID="$saved_session_id"
	export METRICS_SESSION_ID
	return 0
}

restore_metrics_session_id() {
	local session_hint="${1:-}"
	local env_session_id=""

	if [ -n "$session_hint" ]; then
		METRICS_SESSION_ID=$(derive_session_id "$session_hint")
		export METRICS_SESSION_ID
		return 0
	fi

	for env_session_id in \
		"${AGENT_SMITH_SESSION_ID:-}" \
		"${CLAUDE_SESSION_ID:-}" \
		"${CODEX_SESSION_ID:-}" \
		"${OPENCODE_SESSION_ID:-}"; do
		if [ -n "$env_session_id" ]; then
			METRICS_SESSION_ID=$(derive_session_id "$env_session_id")
			export METRICS_SESSION_ID
			return 0
		fi
	done

	load_active_session_id
}

metrics_test_fail_counter_file() {
	local session_suffix="${METRICS_SESSION_ID:-}"
	if [ -n "$session_suffix" ]; then
		printf '%s' "${METRICS_DIR}/.test_fail_count_${session_suffix}"
	else
		printf '%s' "${METRICS_DIR}/.test_fail_count"
	fi
}

# Escape a string for safe JSON embedding.
# Handles all characters that RFC 8259 requires to be escaped: backslash,
# double-quote, and every ASCII control character (U+0000–U+001F, U+007F).
json_escape() {
	local str="$1"
	str="${str//\\/\\\\}"
	str="${str//\"/\\\"}"
	str="${str//$'\n'/\\n}"
	str="${str//$'\r'/\\r}"
	str="${str//$'\t'/\\t}"
	str="${str//$'\x08'/\\b}"
	str="${str//$'\x0c'/\\f}"
	# Strip remaining ASCII control characters that have no named JSON escape.
	# These are illegal unescaped in JSON strings and cause jq (and any strict
	# parser) to reject the entire line.  NUL (0x00) cannot appear in bash
	# strings so it is implicitly excluded.
	local c
	for c in $'\x01' $'\x02' $'\x03' $'\x04' $'\x05' $'\x06' $'\x07' \
		$'\x0b' $'\x0e' $'\x0f' $'\x10' $'\x11' $'\x12' $'\x13' \
		$'\x14' $'\x15' $'\x16' $'\x17' $'\x18' $'\x19' $'\x1a' \
		$'\x1b' $'\x1c' $'\x1d' $'\x1e' $'\x1f' $'\x7f'; do
		str="${str//$c/}"
	done
	printf '%s' "$str"
}

# Truncate a string to N characters.
# Safe to call on json_escape'd output: detects an odd trailing backslash
# (from a split escape sequence like \" cut to just \) and removes it so
# the resulting string is still valid inside a JSON "..." value.
truncate_str() {
	local str="$1"
	local max="${2:-500}"
	if [ "${#str}" -gt "$max" ]; then
		str="${str:0:$max}"
		# Count trailing backslashes.  An odd count means truncation split an
		# escape sequence (e.g. \" → \, or \\\" → \\\).  Remove the dangling
		# backslash to keep the JSON valid.
		local tail="${str##*[!\\]}"
		if ((${#tail} % 2 == 1)); then
			str="${str%\\}"
		fi
		printf '%s...' "$str"
	else
		printf '%s' "$str"
	fi
}

# Estimate USD cost from token counts and model name
# Usage: _estimate_cost <input_tokens> <output_tokens> <cache_read> <cache_create> <model>
# Prices per 1M tokens (2026-03). Update as pricing changes.
_estimate_cost() {
	local input_tokens="${1:-0}"
	local output_tokens="${2:-0}"
	local cache_read="${3:-0}"
	local cache_create="${4:-0}"
	local model="${5:-unknown}"

	local input_rate=0 output_rate=0 cache_read_rate=0 cache_create_rate=0

	case "$model" in
	claude-opus-4-6*)
		input_rate=15000000 output_rate=75000000
		cache_read_rate=1500000 cache_create_rate=18750000
		;;
	claude-sonnet-4-6* | claude-sonnet-4-5*)
		input_rate=3000000 output_rate=15000000
		cache_read_rate=300000 cache_create_rate=3750000
		;;
	claude-haiku-4-5*)
		input_rate=800000 output_rate=4000000
		cache_read_rate=80000 cache_create_rate=1000000
		;;
	*) ;;
	esac

	# rates are price-per-1M-tokens * 1000000 (integer microdollars-per-token)
	# to avoid floating point in bash, compute in awk
	awk "BEGIN {
		cost = ($input_tokens * $input_rate + $output_tokens * $output_rate + $cache_read * $cache_read_rate + $cache_create * $cache_create_rate) / 1000000000000;
		printf \"%.6f\", cost
	}"
}

# Derive a stable session ID from a transcript path or fallback to date-PID
derive_session_id() {
	local transcript_path="${1:-}"
	if [ -n "$transcript_path" ]; then
		printf '%s' "$transcript_path" | shasum -a 256 2>/dev/null | cut -c1-12
	else
		printf '%s-%s' "$(date +%Y%m%d%H%M%S)" "$$"
	fi
}

# Low-level emit — appends one JSONL line
# Usage: emit_metric <tool> <event_type> <metadata_json>
emit_metric() {
	[ "$AGENT_METRICS_ENABLED" = "1" ] || return 0

	local tool="$1"
	local event_type="$2"
	local metadata="$3"
	local session_id="${METRICS_SESSION_ID:-$(date +%Y%m%d)-$$}"
	local ts
	ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

	_ensure_metrics_dir

	local line
	line="{\"ts\":\"${ts}\",\"tool\":\"${tool}\",\"session_id\":\"${session_id}\",\"event_type\":\"${event_type}\",\"metadata\":${metadata}}"

	printf '%s\n' "$line" >>"$METRICS_FILE" 2>/dev/null || true
	_harden_path "$METRICS_FILE" 600
}

# ============================================================================
# Hook-level wrappers — one call per hook, all metrics logic encapsulated
# Each function is self-contained. To remove metrics from a hook, delete:
#   1. source "${SCRIPT_DIR}/lib/metrics.sh"
#   2. The single metrics_on_* call
# ============================================================================

# Call from: hooks/session-start.sh (after detect_project_type)
# Args: <cwd> <project_type> [session_hint] [transcript_path]
metrics_on_session_start() {
	[ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
	local cwd="${1:-$(pwd)}"
	local project_type="${2:-unknown}"
	local session_hint="${3:-}"
	local transcript_path="${4:-}"

	METRICS_SESSION_ID=$(derive_session_id "$session_hint")
	export METRICS_SESSION_ID
	persist_active_session_id

	# Persist start timestamp for duration calculation in session_stop.
	# Scoped by session_id so overlapping sessions don't corrupt each other.
	_ensure_metrics_dir
	printf '%s' "$(date +%s)" >"${METRICS_DIR}/.session_start_ts_${METRICS_SESSION_ID}" 2>/dev/null || true
	_harden_path "${METRICS_DIR}/.session_start_ts_${METRICS_SESSION_ID}" 600

	# Store a hash of the transcript path (not the raw path) in event metadata
	# so rollup can verify identity without exposing the file location.
	local tp_hash=""
	if [ -n "$transcript_path" ]; then
		tp_hash=$(printf '%s' "$transcript_path" | shasum -a 256 2>/dev/null | cut -c1-12)
	fi

	local escaped_cwd escaped_type
	escaped_cwd=$(json_escape "$cwd")
	escaped_type=$(json_escape "$project_type")
	emit_metric "$(metrics_tool_name)" "session_start" "{\"cwd\":\"${escaped_cwd}\",\"project_type\":\"${escaped_type}\",\"transcript_hash\":\"${tp_hash}\"}"
}

# Call from: hooks/session-stop.sh (after notification)
# Args: <stop_reason>
metrics_on_session_stop() {
	[ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
	local stop_reason="${1:-unknown}"

	local duration_seconds=0
	local ts_file="${METRICS_DIR}/.session_start_ts_${METRICS_SESSION_ID:-}"
	if [ -n "${METRICS_SESSION_ID:-}" ] && [ -f "$ts_file" ]; then
		local start_ts now_ts
		start_ts=$(cat "$ts_file" 2>/dev/null || echo "0")
		now_ts=$(date +%s)
		duration_seconds=$((now_ts - start_ts))
		# Do NOT delete the timestamp file. Stop fires on every turn,
		# not just session end. Deleting it would make subsequent turns emit
		# duration_seconds=0. The file is scoped by session_id so overlapping
		# sessions don't corrupt each other.
	fi

	local escaped_reason
	escaped_reason=$(json_escape "$stop_reason")
	emit_metric "$(metrics_tool_name)" "session_stop" "{\"stop_reason\":\"${escaped_reason}\",\"duration_seconds\":${duration_seconds}}"
}

# Call from: hooks/vague-prompt.sh (when is_vague=1)
# Args: <prompt_text>
metrics_on_clarifying_question() {
	[ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
	local prompt_text="${1:-}"

	local snippet
	snippet=$(truncate_str "$(json_escape "$prompt_text")" 100)
	emit_metric "$(metrics_tool_name)" "clarifying_question" "{\"prompt_snippet\":\"${snippet}\",\"is_vague\":true}"
}

# Call from: hooks/test-result.sh (after test execution)
# Args: <passed: 0|1> <test_command> <file_path>
metrics_on_test_result() {
	[ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
	local passed="$1"
	local test_command="${2:-}"
	local file_path="${3:-}"

	local counter
	counter=$(metrics_test_fail_counter_file)

	if [ "$passed" = "1" ]; then
		rm -f "$counter" 2>/dev/null || true
		return 0
	fi

	# Increment failure counter
	local fail_count=1
	if [ -f "$counter" ]; then
		fail_count=$(($(cat "$counter" 2>/dev/null || echo "0") + 1))
	fi
	printf '%s' "$fail_count" >"$counter" 2>/dev/null || true
	_harden_path "$counter" 600

	if [ "$fail_count" -ge 3 ]; then
		local escaped_cmd escaped_file
		escaped_cmd=$(truncate_str "$(json_escape "$test_command")" 300)
		escaped_file=$(json_escape "$file_path")
		emit_metric "$(metrics_tool_name)" "test_failure_loop" "{\"test_command\":\"${escaped_cmd}\",\"failure_count\":${fail_count},\"file_path\":\"${escaped_file}\"}"
	fi
}

# Call from: hooks/tool-failure.sh
# Args: <tool_name> <error> [command] [exit_code] [stderr_text] [stdout_text] [file_path] [turn_id] [tool_use_id]
metrics_on_tool_failure() {
	[ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
	local tool_name="${1:-unknown}"
	local error="${2:-}"
	local command="${3:-}"
	local exit_code="${4:-}"
	local stderr_text="${5:-}"
	local stdout_text="${6:-}"
	local file_path="${7:-}"
	local turn_id="${8:-}"
	local tool_use_id="${9:-}"

	local escaped_tool escaped_error metadata_json
	escaped_tool=$(json_escape "$tool_name")
	escaped_error=$(truncate_str "$(json_escape "$error")" 500)
	metadata_json="{\"tool_name\":\"${escaped_tool}\",\"error\":\"${escaped_error}\""

	if [ -n "$command" ]; then
		local escaped_cmd
		escaped_cmd=$(truncate_str "$(json_escape "$command")" 300)
		metadata_json="${metadata_json},\"command\":\"${escaped_cmd}\""
	fi
	case "$exit_code" in
	'' | *[!0-9]*)
		;;
	*)
		metadata_json="${metadata_json},\"exit_code\":${exit_code}"
		;;
	esac
	if [ -n "$stderr_text" ]; then
		local escaped_stderr
		escaped_stderr=$(truncate_str "$(json_escape "$stderr_text")" 500)
		metadata_json="${metadata_json},\"stderr_snippet\":\"${escaped_stderr}\""
	fi
	if [ -n "$stdout_text" ]; then
		local escaped_stdout
		escaped_stdout=$(truncate_str "$(json_escape "$stdout_text")" 500)
		metadata_json="${metadata_json},\"stdout_snippet\":\"${escaped_stdout}\""
	fi
	if [ -n "$file_path" ]; then
		local escaped_file
		escaped_file=$(truncate_str "$(json_escape "$file_path")" 300)
		metadata_json="${metadata_json},\"file_path\":\"${escaped_file}\""
	fi
	if [ -n "$turn_id" ]; then
		local escaped_turn_id
		escaped_turn_id=$(json_escape "$turn_id")
		metadata_json="${metadata_json},\"turn_id\":\"${escaped_turn_id}\""
	fi
	if [ -n "$tool_use_id" ]; then
		local escaped_tool_use_id
		escaped_tool_use_id=$(json_escape "$tool_use_id")
		metadata_json="${metadata_json},\"tool_use_id\":\"${escaped_tool_use_id}\""
	fi
	metadata_json="${metadata_json}}"

	emit_metric "$(metrics_tool_name)" "tool_failure" "${metadata_json}"

	# For Bash tool failures, also emit a command_failure event
	if [ "$tool_name" = "Bash" ] && [ -n "$command" ]; then
		local escaped_cmd command_failure_json
		escaped_cmd=$(truncate_str "$(json_escape "$command")" 300)
		command_failure_json="{\"command\":\"${escaped_cmd}\",\"error\":\"${escaped_error}\""
		case "$exit_code" in
		'' | *[!0-9]*)
			;;
		*)
			command_failure_json="${command_failure_json},\"exit_code\":${exit_code}"
			;;
		esac
		if [ -n "$stderr_text" ]; then
			local escaped_stderr
			escaped_stderr=$(truncate_str "$(json_escape "$stderr_text")" 500)
			command_failure_json="${command_failure_json},\"stderr_snippet\":\"${escaped_stderr}\""
		fi
		if [ -n "$stdout_text" ]; then
			local escaped_stdout
			escaped_stdout=$(truncate_str "$(json_escape "$stdout_text")" 500)
			command_failure_json="${command_failure_json},\"stdout_snippet\":\"${escaped_stdout}\""
		fi
		if [ -n "$turn_id" ]; then
			local escaped_turn_id
			escaped_turn_id=$(json_escape "$turn_id")
			command_failure_json="${command_failure_json},\"turn_id\":\"${escaped_turn_id}\""
		fi
		if [ -n "$tool_use_id" ]; then
			local escaped_tool_use_id
			escaped_tool_use_id=$(json_escape "$tool_use_id")
			command_failure_json="${command_failure_json},\"tool_use_id\":\"${escaped_tool_use_id}\""
		fi
		command_failure_json="${command_failure_json}}"
		emit_metric "$(metrics_tool_name)" "command_failure" "${command_failure_json}"
	fi
}

# Call from: hooks/permission-denied.sh
# Args: <tool_name>
metrics_on_permission_denied() {
	[ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
	local tool_name="${1:-unknown}"

	local escaped_tool
	escaped_tool=$(json_escape "$tool_name")
	emit_metric "$(metrics_tool_name)" "permission_denied" "{\"tool_name\":\"${escaped_tool}\"}"
}

# Call from: hooks/stop-failure.sh
# Args: <error_type> [turn_id] [tool_use_id]
metrics_on_stop_failure() {
	[ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
	local error_type="${1:-unknown}"
	local turn_id="${2:-}"
	local tool_use_id="${3:-}"

	local escaped_error_type metadata_json
	escaped_error_type=$(json_escape "$error_type")
	metadata_json="{\"error_type\":\"${escaped_error_type}\""

	if [ -n "$turn_id" ]; then
		local escaped_turn_id
		escaped_turn_id=$(json_escape "$turn_id")
		metadata_json="${metadata_json},\"turn_id\":\"${escaped_turn_id}\""
	fi
	if [ -n "$tool_use_id" ]; then
		local escaped_tool_use_id
		escaped_tool_use_id=$(json_escape "$tool_use_id")
		metadata_json="${metadata_json},\"tool_use_id\":\"${escaped_tool_use_id}\""
	fi
	metadata_json="${metadata_json}}"

	emit_metric "$(metrics_tool_name)" "stop_failure" "${metadata_json}"
}

# Call from: hooks/session-stop.sh (per-turn, writes a durable cost snapshot)
# Args: <transcript_path>
# Writes a session-scoped snapshot file so rollup has cost data even if
# the transcript is deleted before rollup runs. Updated on each turn.
#
# Incremental: tracks a line-count cursor so only new transcript lines are
# parsed each turn, avoiding the O(n²) cumulative cost of re-scanning the
# entire transcript on every Stop event. Previous totals are read from the
# existing snapshot and deltas are added.
snapshot_session_cost() {
	[ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
	local transcript_path="${1:-}"
	[ -n "$transcript_path" ] && [ -f "$transcript_path" ] || return 0
	[ -n "${METRICS_SESSION_ID:-}" ] || return 0

	_ensure_metrics_dir
	local snapshot="${METRICS_DIR}/.cost_snapshot_${METRICS_SESSION_ID}"
	local cursor_file="${METRICS_DIR}/.cost_cursor_${METRICS_SESSION_ID}"

	# Read previous cursor (lines + byte size already processed) and snapshot totals.
	# Cursor format: <line_count>\t<byte_size>
	local prev_lines=0 prev_bytes=0
	local prev_input=0 prev_output=0 prev_cr=0 prev_cc=0 prev_turns=0 prev_cost="0.000000"
	if [ -f "$cursor_file" ] && [ -f "$snapshot" ]; then
		IFS=$'\t' read -r prev_lines prev_bytes <"$cursor_file" 2>/dev/null || prev_lines=0
		# Validate both fields are numeric
		case "$prev_lines" in '' | *[!0-9]*) prev_lines=0 ;; esac
		case "$prev_bytes" in '' | *[!0-9]*) prev_bytes=0 ;; esac
		if [ "$prev_lines" -gt 0 ]; then
			IFS=$'\t' read -r prev_input prev_output prev_cr prev_cc _ prev_turns prev_cost <"$snapshot" 2>/dev/null || prev_lines=0
		fi
	fi

	local total_lines total_bytes
	total_lines=$(wc -l <"$transcript_path" 2>/dev/null | tr -d ' ') || total_lines=0
	total_bytes=$(wc -c <"$transcript_path" 2>/dev/null | tr -d ' ') || total_bytes=0

	# Detect transcript rewrite (compaction/truncation): if either the line
	# count or byte size decreased, the file was replaced, not appended to.
	# Reset and do a full (cheap, post-compaction) rescan.
	if [ "$prev_lines" -gt 0 ]; then
		if [ "$total_lines" -lt "$prev_lines" ] || [ "$total_bytes" -lt "$prev_bytes" ]; then
			prev_lines=0 prev_bytes=0 prev_input=0 prev_output=0 prev_cr=0 prev_cc=0
			prev_turns=0 prev_cost="0.000000"
		fi
	fi

	# Nothing new to process (line count unchanged and file hasn't shrunk)
	if [ "$prev_lines" -gt 0 ] && [ "$total_lines" -le "$prev_lines" ]; then
		return 0
	fi

	# Extract only new lines (tail is O(seek), not O(n) on the already-seen prefix)
	local new_data
	if [ "$prev_lines" -gt 0 ]; then
		new_data=$(tail -n +"$((prev_lines + 1))" "$transcript_path" 2>/dev/null) || return 0
	else
		new_data=$(cat "$transcript_path" 2>/dev/null) || return 0
	fi

	# Single jq pass on the new lines: aggregate tokens and compute cost inline.
	# jq handles the per-entry cost math so we avoid spawning awk per row.
	local delta
	delta=$(printf '%s' "$new_data" | jq -s --argjson rates '{
			"claude-opus-4-6":      {"i":15,"o":75,"cr":1.5,"cc":18.75},
			"claude-sonnet-4-6":    {"i":3,"o":15,"cr":0.3,"cc":3.75},
			"claude-sonnet-4-5":    {"i":3,"o":15,"cr":0.3,"cc":3.75},
			"claude-haiku-4-5":     {"i":0.8,"o":4,"cr":0.08,"cc":1}
		}' '
		[.[] | select(.type == "assistant" and .message.usage != null)] |
		if length == 0 then
			{input:0, output:0, cache_read:0, cache_create:0, model:"unknown", turns:0, cost:0}
		else
			{
				input:      (map(.message.usage.input_tokens // 0) | add),
				output:     (map(.message.usage.output_tokens // 0) | add),
				cache_read: (map(.message.usage.cache_read_input_tokens // 0) | add),
				cache_create:(map(.message.usage.cache_creation_input_tokens // 0) | add),
				model:      (last(.[].message.model) // "unknown"),
				turns:      length,
				cost:       (map(
					(.message.model // "unknown") as $m |
					($rates[($m | split("-") | .[:4] | join("-"))] // {i:0,o:0,cr:0,cc:0}) as $r |
					(
						((.message.usage.input_tokens // 0) * $r.i) +
						((.message.usage.output_tokens // 0) * $r.o) +
						((.message.usage.cache_read_input_tokens // 0) * $r.cr) +
						((.message.usage.cache_creation_input_tokens // 0) * $r.cc)
					) / 1000000
				) | add)
			}
		end
	' 2>/dev/null) || return 0

	local d_turns
	d_turns=$(printf '%s' "$delta" | jq -r '.turns') || return 0

	# If no new assistant turns, just update cursor and return
	if [ "$d_turns" = "0" ] || [ -z "$d_turns" ]; then
		printf '%s\t%s\n' "$total_lines" "$total_bytes" >"$cursor_file" 2>/dev/null || true
		return 0
	fi

	# Extract delta values and add to previous totals (single awk call)
	local result
	result=$(printf '%s' "$delta" | jq -r '[.input, .output, .cache_read, .cache_create, .model, .turns, .cost] | @tsv' |
		awk -F'\t' -v pi="$prev_input" -v po="$prev_output" -v pcr="$prev_cr" -v pcc="$prev_cc" \
			-v pt="$prev_turns" -v pc="$prev_cost" '{
			printf "%d\t%d\t%d\t%d\t%s\t%d\t%.6f\n",
				$1+pi, $2+po, $3+pcr, $4+pcc, $5, $6+pt, $7+pc
		}') || return 0

	printf '%s\n' "$result" >"$snapshot" 2>/dev/null || true
	_harden_path "$snapshot" 600
	printf '%s\t%s\n' "$total_lines" "$total_bytes" >"$cursor_file" 2>/dev/null || true
	_harden_path "$cursor_file" 600
}

# Call from: hooks/compact.sh (PostCompact hook)
# Args: <trigger: auto|compact> <transcript_path>
metrics_on_context_compression() {
	[ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
	local trigger="${1:-unknown}"
	local transcript_path="${2:-}"

	local transcript_lines=0
	if [ -n "$transcript_path" ] && [ -f "$transcript_path" ]; then
		transcript_lines=$(wc -l <"$transcript_path" | tr -d ' ')
	fi

	local escaped_trigger
	escaped_trigger=$(json_escape "$trigger")
	emit_metric "$(metrics_tool_name)" "context_compression" "{\"trigger\":\"${escaped_trigger}\",\"transcript_lines\":${transcript_lines}}"
}
