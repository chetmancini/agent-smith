#!/bin/bash
# PostToolUseFailure hook: log tool failures as metrics
# Never blocks the agent — exits 0 always

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // "unknown"')
error=$(echo "$input" | jq -r '.error // ""')
command=$(echo "$input" | jq -r '.tool_input.command // ""')

# Skip expected non-zero exits that aren't real failures
if [ "$tool_name" = "Bash" ]; then
    case "$command" in
        *"command -v"*|*"which "*|*"test -"*|*"[ -"*|*"git rev-parse"*|*"hash "*|*"type "*) exit 0 ;;
    esac
fi

metrics_on_tool_failure "$tool_name" "$error" "$command"

exit 0
