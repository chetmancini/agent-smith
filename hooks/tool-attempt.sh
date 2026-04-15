#!/bin/bash
# PreToolUse hook: track tool attempts for success rate calculation
# Only emits for tools that can fail meaningfully: Bash, Edit, Write, Agent
# Never blocks the agent — exits 0 always

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // "unknown"')

# Belt-and-suspenders filter (matcher already limits to Bash|Edit|Write|Agent)
case "$tool_name" in
Bash|Edit|Write|Agent) ;;
*) exit 0 ;;
esac

session_id=$(echo "$input" | jq -r '.session_id // .sessionId // empty')
tool_use_id=$(echo "$input" | jq -r '.tool_use_id // .toolUseId // empty')
turn_id=$(echo "$input" | jq -r '.turn_id // .turnId // empty')
command=$(echo "$input" | jq -r '.tool_input.command // empty')
file_path=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.filePath // empty')

restore_metrics_session_id "$session_id" || true

metrics_on_tool_attempt "$tool_name" "$tool_use_id" "$turn_id" "$command" "$file_path"

exit 0
