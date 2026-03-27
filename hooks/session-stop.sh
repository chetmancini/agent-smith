#!/bin/bash
# Stop hook: emit session_stop metric with stop reason and duration
# Never blocks the agent — exits 0 always

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
stop_reason=$(echo "$input" | jq -r '.stop_reason // "completed"')

metrics_on_session_stop "$stop_reason"

exit 0
