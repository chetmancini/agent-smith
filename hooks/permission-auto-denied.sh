#!/bin/bash
# PermissionDenied hook: log auto-mode classifier denials as metrics
# Fires when the auto-mode classifier rejects a tool call (user never sees a dialog).
# Different from PermissionRequest (permission-denied.sh) which fires when a dialog appears.
# Never blocks the agent — exits 0 always

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // "unknown"')
reason=$(echo "$input" | jq -r '.reason // empty')
session_id=$(echo "$input" | jq -r '.session_id // .sessionId // empty')

restore_metrics_session_id "$session_id" || true

metrics_on_permission_auto_denied "$tool_name" "$reason"

exit 0
