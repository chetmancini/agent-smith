#!/bin/bash
# PermissionRequest hook: log permission denial events as metrics
# Never blocks the agent — exits 0 always

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
# Claude Code sends tool_name; OpenCode sends tool; Gemini Notification sends details.tool_name
raw_tool_name=$(echo "$input" | jq -r '.tool_name // .tool // .details.tool_name // .details.toolName // "unknown"')
tool_name=$(normalize_hook_tool_name "$raw_tool_name")
session_id=$(echo "$input" | jq -r '.session_id // .sessionId // empty')

restore_metrics_session_id "$session_id" || true

metrics_on_permission_denied "$tool_name"

exit 0
