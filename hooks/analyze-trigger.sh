#!/bin/bash
# Stop hook: check if enough sessions have accumulated to trigger auto-analysis
# Runs async — never blocks the agent

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

ANALYZE_THRESHOLD="${ANALYZE_THRESHOLD:-50}"
AUTO_ANALYZE_ENABLED="${AUTO_ANALYZE_ENABLED:-0}"
AUTO_ANALYZE_MODE="${AUTO_ANALYZE_MODE:-raw}"
AUTO_ANALYZE_INCLUDE_SETTINGS="${AUTO_ANALYZE_INCLUDE_SETTINGS:-0}"
METRICS_DIR="${METRICS_DIR:-${HOME}/.config/agent-smith}"
METRICS_DB="${METRICS_DIR}/rollup.db"

# Plugin root is one level up from hooks/
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/agent-tool.sh
source "${PLUGIN_ROOT}/scripts/lib/agent-tool.sh"

# Need sqlite3 and the rollup DB to check session count
if ! command -v sqlite3 >/dev/null 2>&1; then
	exit 0
fi

# Automatic analysis is opt-in. Public installs should never send telemetry to
# an LLM without an explicit user choice.
if [ "$AUTO_ANALYZE_ENABLED" != "1" ]; then
	exit 0
fi

# Run rollup first to ensure DB is current
if [ -f "${PLUGIN_ROOT}/scripts/metrics-rollup.sh" ]; then
	bash "${PLUGIN_ROOT}/scripts/metrics-rollup.sh" 2>/dev/null || true
fi

if [ ! -f "$METRICS_DB" ]; then
	exit 0
fi

agent_tool=$(metrics_tool_name)
escaped_agent_tool=$(printf '%s' "$agent_tool" | sed "s/'/''/g")

# Count sessions since last analysis run
session_count=$(sqlite3 "$METRICS_DB" "
    SELECT COUNT(DISTINCT session_id) FROM events
    WHERE ts > COALESCE(
        (SELECT MAX(ts) FROM events WHERE event_type = 'analysis_run' AND tool = '${escaped_agent_tool}'),
        '1970-01-01'
    )
    AND event_type = 'session_start'
    AND tool = '${escaped_agent_tool}';
" 2>/dev/null || echo "0")

if [ "$session_count" -ge "$ANALYZE_THRESHOLD" ]; then
	# Record the analysis run event
	emit_metric "$agent_tool" "analysis_run" "{\"trigger\":\"auto\",\"mode\":\"${AUTO_ANALYZE_MODE}\",\"sessions\":${session_count}}"

	# Spawn analyzer in background — don't block
	if [ -f "${PLUGIN_ROOT}/scripts/analyze-config.sh" ]; then
		analyze_args=(bash "${PLUGIN_ROOT}/scripts/analyze-config.sh" --sessions "$session_count" --auto --tool "$agent_tool")
		if [ "$AUTO_ANALYZE_MODE" = "llm" ]; then
			agent_cli_bin="$(agent_smith_cli_bin "$agent_tool")"
			command -v "$agent_cli_bin" >/dev/null 2>&1 || exit 0
			analyze_args+=(--llm)
			if [ "$AUTO_ANALYZE_INCLUDE_SETTINGS" = "1" ]; then
				analyze_args+=(--include-settings)
			fi
		fi
		nohup "${analyze_args[@]}" >/dev/null 2>&1 &
	fi
fi

exit 0
