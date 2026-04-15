#!/bin/bash
# SubagentStart hook: track subagent spawns and persist start timestamp
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

metrics_on_subagent_start "$agent_id" "$agent_type" "$turn_id" "$tool_use_id"

exit 0
