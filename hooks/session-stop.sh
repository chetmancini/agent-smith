#!/bin/bash
# Stop hook: emit session_stop metric and snapshot session cost
# Stop fires on every turn. The cost snapshot is a lightweight file that
# rollup uses as a fallback when the transcript has been deleted.
# Never blocks the agent — exits 0 always

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
stop_reason=$(echo "$input" | jq -r '.stop_reason // "completed"')
transcript_path=$(echo "$input" | jq -r '.transcript_path // ""')
session_id=$(echo "$input" | jq -r '.session_id // ""')

# Each hook runs in a separate process, so METRICS_SESSION_ID from session-start
# is not inherited. Re-derive it from the same session_id to stay consistent.
METRICS_SESSION_ID=$(derive_session_id "$session_id")
export METRICS_SESSION_ID

metrics_on_session_stop "$stop_reason"
snapshot_session_cost "$transcript_path"

exit 0
