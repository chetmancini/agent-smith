#!/bin/bash
# Config analyzer: gather metrics and optionally invoke Claude for tuning suggestions
# Usage: analyze-config.sh [--sessions N] [--llm] [--include-settings] [--auto]

set -euo pipefail

METRICS_DIR="${METRICS_DIR:-${HOME}/.config/agent-smith}"
DB_FILE="${METRICS_DIR}/rollup.db"
SESSIONS=50
USE_LLM=0
INCLUDE_SETTINGS=0
AUTO_MODE=0

# Plugin root (script lives in scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

while [ $# -gt 0 ]; do
	case "$1" in
	--sessions)
		SESSIONS="$2"
		shift 2
		;;
	--llm)
		USE_LLM=1
		shift
		;;
	--include-settings)
		INCLUDE_SETTINGS=1
		shift
		;;
	--auto)
		AUTO_MODE=1
		shift
		;;
	*) shift ;;
	esac
done

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

if ! command -v sqlite3 >/dev/null 2>&1; then
	echo "Error: sqlite3 not found" >&2
	exit 1
fi

if [ ! -f "$DB_FILE" ]; then
	echo "Error: Metrics database not found at $DB_FILE" >&2
	echo "Run 'bash ${PLUGIN_ROOT}/scripts/metrics-rollup.sh' first to process events." >&2
	exit 1
fi

# --- SQL Queries ---

query_tool_failures() {
	sqlite3 -header -column "$DB_FILE" "
        SELECT
            json_extract(metadata, '$.tool_name') as tool_name,
            COUNT(*) as total_failures,
            COUNT(DISTINCT session_id) as sessions_affected
        FROM events
        WHERE event_type IN ('tool_failure', 'command_failure')
          AND session_id IN (
              SELECT DISTINCT session_id FROM events
              WHERE event_type = 'session_start'
              ORDER BY ts DESC LIMIT $SESSIONS
          )
        GROUP BY tool_name
        ORDER BY total_failures DESC
        LIMIT 15;
    " 2>/dev/null || echo "(no data)"
}

query_permission_denials() {
	sqlite3 -header -column "$DB_FILE" "
        SELECT
            json_extract(metadata, '$.tool_name') as tool_name,
            COUNT(*) as denial_count,
            COUNT(DISTINCT session_id) as sessions_affected
        FROM events
        WHERE event_type = 'permission_denied'
          AND session_id IN (
              SELECT DISTINCT session_id FROM events
              WHERE event_type = 'session_start'
              ORDER BY ts DESC LIMIT $SESSIONS
          )
        GROUP BY tool_name
        ORDER BY denial_count DESC;
    " 2>/dev/null || echo "(no data)"
}

query_test_loops() {
	sqlite3 -header -column "$DB_FILE" "
        SELECT
            session_id,
            COUNT(*) as loop_events,
            MAX(json_extract(metadata, '$.failure_count')) as max_failures,
            json_extract(metadata, '$.test_command') as test_command
        FROM events
        WHERE event_type = 'test_failure_loop'
          AND session_id IN (
              SELECT DISTINCT session_id FROM events
              WHERE event_type = 'session_start'
              ORDER BY ts DESC LIMIT $SESSIONS
          )
        GROUP BY session_id
        ORDER BY max_failures DESC
        LIMIT 10;
    " 2>/dev/null || echo "(no data)"
}

query_clarifying_questions() {
	sqlite3 -header -column "$DB_FILE" "
        SELECT
            COUNT(*) as total_clarifications,
            COUNT(DISTINCT session_id) as sessions_with_clarification,
            (SELECT COUNT(DISTINCT session_id) FROM events
             WHERE event_type = 'session_start'
             ORDER BY ts DESC LIMIT $SESSIONS) as total_sessions
        FROM events
        WHERE event_type = 'clarifying_question'
          AND session_id IN (
              SELECT DISTINCT session_id FROM events
              WHERE event_type = 'session_start'
              ORDER BY ts DESC LIMIT $SESSIONS
          );
    " 2>/dev/null || echo "(no data)"
}

query_session_outcomes() {
	sqlite3 -header -column "$DB_FILE" "
        SELECT
            stop_reason,
            COUNT(*) as count,
            ROUND(AVG(duration_seconds), 0) as avg_duration_s,
            ROUND(MAX(duration_seconds), 0) as max_duration_s
        FROM sessions
        WHERE session_id IN (
            SELECT DISTINCT session_id FROM events
            WHERE event_type = 'session_start'
            ORDER BY ts DESC LIMIT $SESSIONS
        )
        AND stop_reason IS NOT NULL
        GROUP BY stop_reason
        ORDER BY count DESC;
    " 2>/dev/null || echo "(no data)"
}

query_overview() {
	sqlite3 -header -column "$DB_FILE" "
        SELECT
            tool,
            COUNT(DISTINCT session_id) as sessions,
            SUM(event_count) as total_events,
            SUM(failure_count) as failures,
            SUM(test_loop_count) as test_loops,
            SUM(clarification_count) as clarifications,
            SUM(denial_count) as denials
        FROM sessions
        GROUP BY tool
        ORDER BY sessions DESC;
    " 2>/dev/null || echo "(no data)"
}

# --- Gather Data ---

echo "Gathering metrics from last $SESSIONS sessions..."

echo "  -> Querying overview by tool..."
OVERVIEW=$(query_overview)
echo "  -> Querying tool failure rates..."
TOOL_FAILURES=$(query_tool_failures)
echo "  -> Querying permission denials..."
PERMISSION_DENIALS=$(query_permission_denials)
echo "  -> Querying test failure loops..."
TEST_LOOPS=$(query_test_loops)
echo "  -> Querying clarifying question patterns..."
CLARIFYING_QUESTIONS=$(query_clarifying_questions)
echo "  -> Querying session outcomes..."
SESSION_OUTCOMES=$(query_session_outcomes)
echo "  All metrics gathered."

# Generate output filename with collision handling
date_str=$(date +%Y-%m-%d)
output_dir="${METRICS_DIR}/reports"
ensure_private_dir "$output_dir"
base_name="$date_str-analysis"
output_file="${output_dir}/${base_name}.md"
suffix=2
while [ -f "$output_file" ]; do
	output_file="${output_dir}/${base_name}-${suffix}.md"
	suffix=$((suffix + 1))
done

write_raw_report() {
	cat >"$output_file" <<EOF
# Config Metrics Report (raw) — $(date +%Y-%m-%d)
Last $SESSIONS sessions analyzed.

## Overview by Tool
$OVERVIEW

## Tool Failure Rates
$TOOL_FAILURES

## Permission Denials
$PERMISSION_DENIALS

## Test Failure Loops
$TEST_LOOPS

## Clarifying Questions
$CLARIFYING_QUESTIONS

## Session Outcomes
$SESSION_OUTCOMES
EOF
	harden_private_file "$output_file"
}

# --- Raw Output Mode ---

if [ "$USE_LLM" -ne 1 ]; then
	write_raw_report
	echo "Raw report saved: $output_file"
	exit 0
fi

# --- LLM Analysis Mode ---

if ! command -v claude >/dev/null 2>&1; then
	echo "Error: claude CLI not found. Re-run without --llm for a local raw report." >&2
	exit 1
fi

# Read current config for context only when explicitly requested
SETTINGS_CONTEXT="Settings snapshot omitted. Suggest any settings changes from metrics only and note when local inspection is required."
if [ "$INCLUDE_SETTINGS" -eq 1 ]; then
	echo "  -> Reading current settings for context..."
	SETTINGS_EXCERPT=""
	if [ -f "${HOME}/.claude/settings.json" ]; then
		SETTINGS_EXCERPT=$(cat "${HOME}/.claude/settings.json")
	elif [ -f "${HOME}/.claude/settings.local.json" ]; then
		SETTINGS_EXCERPT=$(cat "${HOME}/.claude/settings.local.json")
	fi

	SETTINGS_CONTEXT="Current settings snapshot included below.

\`\`\`json
$SETTINGS_EXCERPT
\`\`\`"
fi

# Build the analysis prompt
prompt="You are an AI agent configuration tuner. Analyze the session metrics below and produce a tuning report with specific, actionable suggestions.

## Claude Code Configuration
Claude Code settings live in:
- Global user settings: ~/.claude/settings.json
- Project-level settings: .claude/settings.json (per repo)
- Custom slash commands: ~/.claude/commands/*.md or .claude/commands/*.md
- Hooks: registered in settings.json under the 'hooks' key

## Metrics Summary (last $SESSIONS sessions)

### Overview by Tool
$OVERVIEW

### Tool Failure Rates
$TOOL_FAILURES

### Permission Denials
$PERMISSION_DENIALS

### Test Failure Loops
$TEST_LOOPS

### Clarifying Question Patterns
$CLARIFYING_QUESTIONS

### Session Outcomes
$SESSION_OUTCOMES

## Settings Context
$SETTINGS_CONTEXT

## Config File Mapping
Use these mappings when suggesting changes:
- Hook timeout issues -> settings.json (hooks section)
- Permission denials -> settings.json (permissions.allow)
- Test strategy issues -> custom commands or CLAUDE.md instructions
- Vague prompt handling -> custom commands, CLAUDE.md instructions
- Model/effort issues -> settings.json (model, effortLevel)

## Instructions

Produce a report in this exact format:

# Config Analysis Report — $(date +%Y-%m-%d)

## Executive Summary
2-3 sentence overview of key findings.

## Critical Issues
Issues with >20% failure rate or significant user friction. Skip if none.

## Tuning Suggestions

### Auto-Apply (safe prompt/wording changes)
For each:
- **File**: exact path
- **Current**: relevant excerpt
- **Proposed**: replacement text
- **Rationale**: metrics-based justification

### Requires Approval (structural changes)
For each:
- **File**: exact path
- **Change type**: permission | hook timeout | hook addition | setting change
- **Proposed**: what to change
- **Risk**: what could go wrong
- **Rationale**: metrics-based justification

## Metrics Snapshot
Key numbers table for historical tracking.

## Next Steps
What to monitor going forward.

Be specific — reference file paths, metric values, and tool names. Only suggest changes supported by the data. If metrics show no significant issues, say so."

if [ "$AUTO_MODE" -eq 1 ]; then
	prompt="$prompt

NOTE: This is an automated analysis run. Produce the report only. Do not suggest interactive actions."
fi

echo "Running analysis with Claude..."
echo "  -> Building prompt ($(echo "$prompt" | wc -c | tr -d ' ') bytes)..."
echo "  -> Sending to Claude CLI (this may take 30-60s)..."

if claude -p --output-format text "$prompt" >"$output_file" 2>/dev/null; then
	harden_private_file "$output_file"
	echo "  Analysis complete."
	echo "Report saved: $output_file"
else
	echo "Error: Failed to generate analysis report" >&2
	rm -f "$output_file"
	exit 1
fi
