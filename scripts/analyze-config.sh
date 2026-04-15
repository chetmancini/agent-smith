#!/bin/bash
# Config analyzer: gather metrics and optionally invoke the active agent for tuning suggestions
# Usage: analyze-config.sh [--sessions N] [--project NAME] [--tool claude|codex|opencode] [--llm] [--include-settings] [--auto]

set -euo pipefail

METRICS_DIR="${METRICS_DIR:-${HOME}/.config/agent-smith}"
DB_FILE="${METRICS_DIR}/rollup.db"
SESSIONS=50
USE_LLM=0
INCLUDE_SETTINGS=0
AUTO_MODE=0
PROJECT_FILTER=""
TOOL_FILTER="${AGENT_SMITH_TOOL:-}"

# Plugin root (script lives in scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/agent-tool.sh
source "${SCRIPT_DIR}/lib/agent-tool.sh"

while [ $# -gt 0 ]; do
	case "$1" in
	--sessions)
		SESSIONS="$2"
		shift 2
		;;
	-h | --help)
		cat <<'EOF'
Usage: analyze-config.sh [--sessions N] [--project NAME] [--tool claude|codex|opencode] [--llm] [--include-settings] [--auto]

Generate a local Agent Smith metrics report, optionally followed by active-agent recommendations.
EOF
		exit 0
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
	--project)
		PROJECT_FILTER="$2"
		shift 2
		;;
	--tool)
		TOOL_FILTER="$2"
		shift 2
		;;
	*) shift ;;
	esac
done

if [ -n "$TOOL_FILTER" ] && ! agent_smith_validate_tool_name "$TOOL_FILTER"; then
	echo "Error: unsupported tool '$TOOL_FILTER' (expected claude, codex, or opencode)" >&2
	exit 1
fi

if [ "$USE_LLM" -eq 1 ]; then
	# LLM-backed analysis should stay scoped to the active agent by default.
	TOOL_FILTER="$(agent_smith_detect_tool "$TOOL_FILTER")"
fi

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

llm_cli_bin() {
	agent_smith_cli_bin "$1"
}

llm_cli_label() {
	case "$1" in
	claude) printf '%s\n' 'Claude' ;;
	codex) printf '%s\n' 'Codex' ;;
	opencode) printf '%s\n' 'OpenCode' ;;
	*) return 1 ;;
	esac
}

run_llm_prompt() {
	case "$LLM_TOOL" in
	claude)
		"$LLM_BIN" -p --output-format text "$prompt" >"$output_file" 2>/dev/null
		;;
	codex)
		"$LLM_BIN" exec -C "$PLUGIN_ROOT" "$prompt" >"$output_file" 2>/dev/null
		;;
	opencode)
		"$LLM_BIN" run --dir "$PLUGIN_ROOT" "$prompt" >"$output_file" 2>/dev/null
		;;
	*)
		return 1
		;;
	esac
}

redact_settings_json() {
	local settings_path="$1"

	[ -f "$settings_path" ] || return 0

	if command -v jq >/dev/null 2>&1; then
		jq '
			def secret_key:
				ascii_downcase
				| test("(^|[-_])(apikey|apikeyid|token|secret|password|passwd|authorization|auth|credential|privatekey|private_key|clientsecret|client_secret|accesstoken|access_token|refreshtoken|refresh_token|sessiontoken|session_token)([-_]|$)");
			def redact:
				if type == "object" then
					with_entries(
						if (.key | secret_key) then
							.value = "[REDACTED]"
						else
							.value |= redact
						end
					)
				elif type == "array" then
					map(redact)
				else
					.
				end;
			redact
		' "$settings_path" 2>/dev/null && return 0
	fi

	# Fallback for environments without jq or malformed JSON: redact obvious
	# quoted key/value pairs without trying to fully parse the document.
	sed -E \
		-e 's/("([^"]*(api[_-]?key|token|secret|password|passwd|authorization|credential|private[_-]?key|client[_-]?secret)[^"]*)"[[:space:]]*:[[:space:]]*)"[^"]*"/\1"[REDACTED]"/Ig' \
		"$settings_path"
}

redact_settings_toml() {
	local settings_path="$1"

	[ -f "$settings_path" ] || return 1

	awk '
		function is_secret_key(key, lowered) {
			lowered = tolower(key)
			return lowered ~ /(^|[-_])(api[_-]?key|api[_-]?keyid|token|secret|password|passwd|authorization|auth|credential|private[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|session[_-]?token)([-_]|$)/
		}

		{
			line = $0
			if (match(line, /^[[:space:]]*([[:alnum:]_.-]+)[[:space:]]*=/)) {
				key = substr(line, RSTART, RLENGTH)
				gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
				sub(/[[:space:]]*=$/, "", key)
				if (is_secret_key(key)) {
					sub(/=.*/, "= \"[REDACTED]\"", line)
				}
			}
			print line
		}
	' "$settings_path"
}

read_redacted_settings_snapshot() {
	local tool="$1"

	case "$tool" in
	codex)
		if [ -f "${HOME}/.codex/config.toml" ]; then
			redact_settings_toml "${HOME}/.codex/config.toml"
			return $?
		fi
		return 1
		;;
	opencode)
		if [ -f "${HOME}/.config/opencode/opencode.json" ]; then
			redact_settings_json "${HOME}/.config/opencode/opencode.json"
			return $?
		fi
		return 1
		;;
	claude | "")
		if [ -f "${HOME}/.claude/settings.json" ]; then
			redact_settings_json "${HOME}/.claude/settings.json"
			return $?
		fi
		if [ -f "${HOME}/.claude/settings.local.json" ]; then
			redact_settings_json "${HOME}/.claude/settings.local.json"
			return $?
		fi
		return 1
		;;
	*)
		return 1
		;;
	esac
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

escaped_tool_filter() {
	printf '%s' "$1" | sed "s/'/''/g"
}

tool_filter_label() {
	if [ -n "$TOOL_FILTER" ]; then
		printf ', tool: %s' "$TOOL_FILTER"
	fi
}

# Build the session-filter subquery used by all metric queries.
# When --project is set, restrict to sessions whose cwd basename matches.
session_filter_subquery() {
	local sql="SELECT session_id FROM sessions WHERE started_at IS NOT NULL"
	if [ -n "$TOOL_FILTER" ]; then
		local escaped_tool
		escaped_tool=$(escaped_tool_filter "$TOOL_FILTER")
		sql="$sql AND tool = '${escaped_tool}'"
	fi
	if [ -n "$PROJECT_FILTER" ]; then
		local escaped
		escaped=$(printf '%s' "$PROJECT_FILTER" | sed "s/'/''/g")
		# basename(cwd): strip trailing slash, then extract text after last '/'
		sql="$sql AND REPLACE(RTRIM(cwd,'/'), RTRIM(RTRIM(cwd,'/'), REPLACE(RTRIM(cwd,'/'),'/','')),'') = '${escaped}'"
	fi
	sql="$sql ORDER BY started_at DESC LIMIT $SESSIONS"
	printf '%s' "$sql"
}

# --- SQL Queries ---

query_tool_failures() {
	sqlite3 -header -column "$DB_FILE" "
        SELECT
            json_extract(metadata, '$.tool_name') as tool_name,
            COUNT(*) as total_failures,
            COUNT(DISTINCT session_id) as sessions_affected
        FROM events
        WHERE event_type IN ('tool_failure', 'command_failure')
          $(if [ -n "$TOOL_FILTER" ]; then printf "AND tool = '%s'" "$(escaped_tool_filter "$TOOL_FILTER")"; fi)
          AND session_id IN (
              $(session_filter_subquery)
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
          $(if [ -n "$TOOL_FILTER" ]; then printf "AND tool = '%s'" "$(escaped_tool_filter "$TOOL_FILTER")"; fi)
          AND session_id IN (
              $(session_filter_subquery)
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
          $(if [ -n "$TOOL_FILTER" ]; then printf "AND tool = '%s'" "$(escaped_tool_filter "$TOOL_FILTER")"; fi)
          AND session_id IN (
              $(session_filter_subquery)
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
            (SELECT COUNT(*) FROM ($(session_filter_subquery))) as total_sessions
        FROM events
        WHERE event_type = 'clarifying_question'
          $(if [ -n "$TOOL_FILTER" ]; then printf "AND tool = '%s'" "$(escaped_tool_filter "$TOOL_FILTER")"; fi)
          AND session_id IN (
              $(session_filter_subquery)
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
            $(session_filter_subquery)
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
        WHERE session_id IN (
            $(session_filter_subquery)
        )
        GROUP BY tool
        ORDER BY sessions DESC;
    " 2>/dev/null || echo "(no data)"
}

query_project_breakdown() {
	sqlite3 -header -column "$DB_FILE" "
        SELECT
            REPLACE(RTRIM(cwd,'/'), RTRIM(RTRIM(cwd,'/'), REPLACE(RTRIM(cwd,'/'),'/','')),'') as project,
            COUNT(DISTINCT session_id) as sessions,
            SUM(event_count) as total_events,
            SUM(failure_count) as failures,
            SUM(test_loop_count) as test_loops,
            SUM(clarification_count) as clarifications,
            SUM(denial_count) as denials,
            ROUND(AVG(duration_seconds), 0) as avg_duration_s
        FROM sessions
        WHERE cwd IS NOT NULL
          AND session_id IN (
              $(session_filter_subquery)
          )
        GROUP BY project
        ORDER BY sessions DESC
        LIMIT 20;
    " 2>/dev/null || echo "(no data)"
}

query_session_costs() {
	sqlite3 -header -column "$DB_FILE" "
        SELECT
            COUNT(*) as total_sessions,
            ROUND(SUM(estimated_cost_usd), 4) as total_cost_usd,
            ROUND(AVG(estimated_cost_usd), 4) as avg_cost_usd,
            ROUND(MAX(estimated_cost_usd), 4) as max_cost_usd,
            ROUND(SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens), 0) as total_tokens
        FROM sessions
        WHERE session_id IN (
            $(session_filter_subquery)
        )
        AND estimated_cost_usd > 0;
    " 2>/dev/null || echo "(no data)"
}

query_compressions() {
	sqlite3 -header -column "$DB_FILE" "
        SELECT
            COUNT(*) as total_compressions,
            COUNT(DISTINCT session_id) as sessions_with_compression,
            SUM(CASE WHEN json_extract(metadata, '$.trigger') = 'auto' THEN 1 ELSE 0 END) as auto_count,
            SUM(CASE WHEN json_extract(metadata, '$.trigger') = 'manual' THEN 1 ELSE 0 END) as manual_count,
            ROUND(AVG(json_extract(metadata, '$.transcript_lines')), 0) as avg_transcript_lines
        FROM events
        WHERE event_type = 'context_compression'
          $(if [ -n "$TOOL_FILTER" ]; then printf "AND tool = '%s'" "$(escaped_tool_filter "$TOOL_FILTER")"; fi)
          AND session_id IN (
              $(session_filter_subquery)
          );
    " 2>/dev/null || echo "(no data)"
}
# --- Gather Data ---

if [ -n "$PROJECT_FILTER" ]; then
	echo "Gathering metrics from last $SESSIONS sessions$(tool_filter_label) (project: $PROJECT_FILTER)..."
else
	echo "Gathering metrics from last $SESSIONS sessions$(tool_filter_label)..."
fi

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
echo "  -> Querying project breakdown..."
PROJECT_BREAKDOWN=$(query_project_breakdown)
echo "  -> Querying session costs..."
SESSION_COSTS=$(query_session_costs)
echo "  -> Querying context compressions..."
COMPRESSIONS=$(query_compressions)
echo "  All metrics gathered."

# Generate output filename with collision handling
date_str=$(date +%Y-%m-%d)
output_dir="${METRICS_DIR}/reports"
ensure_private_dir "$output_dir"
if [ -n "$TOOL_FILTER" ]; then
	base_name="$date_str-${TOOL_FILTER}-analysis"
else
	base_name="$date_str-analysis"
fi
output_file="${output_dir}/${base_name}.md"
suffix=2
while [ -f "$output_file" ]; do
	output_file="${output_dir}/${base_name}-${suffix}.md"
	suffix=$((suffix + 1))
done

write_raw_report() {
	local header
	header="# Config Metrics Report (raw) — $(date +%Y-%m-%d)"
	if [ -n "$PROJECT_FILTER" ]; then
		header="$header (project: $PROJECT_FILTER$(tool_filter_label))"
	elif [ -n "$TOOL_FILTER" ]; then
		header="$header (tool: $TOOL_FILTER)"
	fi
	cat >"$output_file" <<EOF
$header
Last $SESSIONS sessions analyzed$([ -n "$TOOL_FILTER" ] && printf ' for %s' "$TOOL_FILTER").

## Overview by Tool
$OVERVIEW

## Breakdown by Project
$PROJECT_BREAKDOWN

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

## Session Costs
$SESSION_COSTS

## Context Compressions
$COMPRESSIONS
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

LLM_TOOL="$TOOL_FILTER"
LLM_BIN="$(llm_cli_bin "$LLM_TOOL")"
LLM_LABEL="$(llm_cli_label "$LLM_TOOL")"

if ! command -v "$LLM_BIN" >/dev/null 2>&1; then
	echo "Error: ${LLM_BIN} CLI not found. Re-run without --llm for a local raw report." >&2
	exit 1
fi

# Read current config for context only when explicitly requested
SETTINGS_CONTEXT="Settings snapshot omitted. Suggest any settings changes from metrics only and note when local inspection is required."
CONFIG_SECTION_TITLE="Claude Code Configuration"
CONFIG_LOCATIONS=$(
	cat <<'EOF'
Claude Code settings live in:
- Global user settings: ~/.claude/settings.json
- Project-level settings: .claude/settings.json (per repo)
- Custom slash commands: ~/.claude/commands/*.md or .claude/commands/*.md
- Hooks: registered in settings.json under the 'hooks' key
EOF
)
CONFIG_FILE_MAPPING=$(
	cat <<'EOF'
Use these mappings when suggesting changes:
- Hook timeout issues -> settings.json (hooks section)
- Permission denials -> settings.json (permissions.allow)
- Test strategy issues -> custom commands or CLAUDE.md instructions
- Vague prompt handling -> custom commands, CLAUDE.md instructions
- Model/effort issues -> settings.json (model, effortLevel)
- High session costs -> model selection, prompt optimization, cache strategy
- Frequent compressions -> session length management, task decomposition
EOF
)

if [ "$TOOL_FILTER" = "codex" ]; then
	CONFIG_SECTION_TITLE="Codex Configuration"
	CONFIG_LOCATIONS=$(
		cat <<'EOF'
Codex settings live in:
- Global user settings: ~/.codex/config.toml
- Per-run overrides: codex -c key=value
- Agent skills and plugin instructions: Codex skills plus plugin-local instructions
- Tool approvals and sandbox behavior: ~/.codex/config.toml
EOF
	)
	CONFIG_FILE_MAPPING=$(
		cat <<'EOF'
Use these mappings when suggesting changes:
- Permission or sandbox friction -> ~/.codex/config.toml (approval_policy, sandbox_mode, app/tool settings)
- Prompt/instruction issues -> Codex skills, AGENTS.md, or plugin instructions
- Model/effort issues -> ~/.codex/config.toml (model, model_reasoning_effort, model_verbosity)
- High session costs -> model selection, reasoning effort, prompt optimization, cache strategy
- Frequent compressions -> task decomposition, memory usage, and instruction scope
- Do not suggest Claude-specific settings or hook changes when the filtered tool is codex
EOF
	)
elif [ "$TOOL_FILTER" = "opencode" ]; then
	CONFIG_SECTION_TITLE="OpenCode Configuration"
	CONFIG_LOCATIONS=$(
		cat <<'EOF'
OpenCode settings live in:
- Global user settings: ~/.config/opencode/opencode.json
- Global instructions: ~/.config/opencode/instructions.md
- Project-level instructions: instructions.md (per repo)
- Custom agents: opencode.json (agent key with mode, description, prompt)
- Plugins: ~/.config/opencode/plugins/ (TypeScript plugin files)
EOF
	)
	CONFIG_FILE_MAPPING=$(
		cat <<'EOF'
Use these mappings when suggesting changes:
- Permission friction -> opencode.json (permission key: read, edit, bash, etc.)
- Prompt/instruction issues -> instructions.md (global or project-level), agent prompts in opencode.json
- Model/effort issues -> opencode.json (model, small_model)
- High session costs -> model selection, prompt optimization, compaction settings
- Frequent compressions -> opencode.json (compaction key: auto, prune, reserved)
- Plugin behavior -> ~/.config/opencode/plugins/ TypeScript files
- Do not suggest Claude-specific or Codex-specific settings when the filtered tool is opencode
EOF
	)
fi

if [ "$INCLUDE_SETTINGS" -eq 1 ]; then
	echo "  -> Reading current settings for context..."
	SETTINGS_EXCERPT=""
	if SETTINGS_EXCERPT=$(read_redacted_settings_snapshot "$TOOL_FILTER"); then
		SETTINGS_CONTEXT="Current settings snapshot included below.

\`\`\`
$SETTINGS_EXCERPT
\`\`\`"
	else
		if [ "$TOOL_FILTER" = "codex" ]; then
			SETTINGS_CONTEXT="Codex settings snapshot omitted because ~/.codex/config.toml is unavailable. Suggest Codex changes from metrics only and do not infer from Claude settings."
		elif [ "$TOOL_FILTER" = "opencode" ]; then
			SETTINGS_CONTEXT="OpenCode settings snapshot omitted because ~/.config/opencode/opencode.json is unavailable. Suggest OpenCode changes from metrics only and do not infer from Claude or Codex settings."
		else
			SETTINGS_CONTEXT="Settings snapshot omitted. Suggest any settings changes from metrics only and note when local inspection is required."
		fi
	fi
fi

# Build the analysis prompt
prompt="You are an AI agent configuration tuner. Analyze the session metrics below and produce a tuning report with specific, actionable suggestions.

## $CONFIG_SECTION_TITLE
$CONFIG_LOCATIONS

## Metrics Summary (last $SESSIONS sessions$([ -n "$PROJECT_FILTER" ] && echo ", project: $PROJECT_FILTER")$([ -n "$TOOL_FILTER" ] && echo ", tool: $TOOL_FILTER"))

### Overview by Tool
$OVERVIEW

### Breakdown by Project
$PROJECT_BREAKDOWN

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

### Session Costs
$SESSION_COSTS

### Context Compressions
$COMPRESSIONS

## Settings Context
$SETTINGS_CONTEXT

## Config File Mapping
$CONFIG_FILE_MAPPING

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

echo "Running analysis with $LLM_LABEL..."
echo "  -> Building prompt ($(echo "$prompt" | wc -c | tr -d ' ') bytes)..."
echo "  -> Sending to ${LLM_LABEL} CLI (this may take 30-60s)..."

if run_llm_prompt; then
	harden_private_file "$output_file"
	echo "  Analysis complete."
	echo "Report saved: $output_file"
else
	echo "Error: Failed to generate analysis report" >&2
	rm -f "$output_file"
	exit 1
fi
