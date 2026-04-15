#!/bin/bash
# StopFailure hook: log API errors and inject context for actionable error types
# Writes to stdout for rate_limit and max_output_tokens; exit 0 always (never blocks)

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
error_type=$(echo "$input" | jq -r '.error_type // "unknown"')
session_id=$(echo "$input" | jq -r '.session_id // .sessionId // empty')
turn_id=$(echo "$input" | jq -r '.turn_id // .turnId // empty')
tool_use_id=$(echo "$input" | jq -r '.tool_use_id // .toolUseId // empty')

restore_metrics_session_id "$session_id" || true

metrics_on_stop_failure "$error_type" "$turn_id" "$tool_use_id" >/dev/null 2>&1 || true

case "$error_type" in
rate_limit)
	printf '\n%s\n' '[System note: Rate limited — consider switching to a smaller model or waiting before retrying.]'
	;;
max_output_tokens)
	printf '\n%s\n' '[System note: Output truncated — consider breaking the task into smaller steps.]'
	;;
esac

exit 0
