#!/bin/bash
# SubagentStop hook: track subagent completion with duration
# Never blocks the agent — exits 0 always

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
agent_id=$(echo "$input" | jq -r '.agent_id // "unknown"')
agent_type=$(echo "$input" | jq -r '.agent_type // "unknown"')
session_id=$(echo "$input" | jq -r '.session_id // .sessionId // empty')
turn_id=$(echo "$input" | jq -r '.turn_id // .turnId // empty')
tool_use_id=$(echo "$input" | jq -r '.tool_use_id // .toolUseId // empty')

restore_metrics_session_id "$session_id" || true

# Calculate duration from persisted start timestamp
duration_seconds=0
ts_file="${METRICS_DIR}/.subagent_start_ts_${agent_id}"
if [ -f "$ts_file" ]; then
    start_ts=$(cat "$ts_file" 2>/dev/null || echo "0")
    case "$start_ts" in
    '' | *[!0-9]*) start_ts=0 ;;
    esac
    if [ "$start_ts" -gt 0 ]; then
        now_ts=$(date +%s)
        duration_seconds=$((now_ts - start_ts))
    fi
    rm -f "$ts_file" 2>/dev/null || true
fi

metrics_on_subagent_stop "$agent_id" "$agent_type" "$duration_seconds" "$turn_id" "$tool_use_id"

exit 0
