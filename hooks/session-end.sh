#!/bin/bash
# SessionEnd hook: emit authoritative session_end metric and final cost snapshot
# SessionEnd fires exactly once when a session terminates (unlike Stop which fires per-turn).
# Never blocks the agent — exits 0 always

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
reason=$(echo "$input" | jq -r '.reason // "unknown"')
transcript_path=$(echo "$input" | jq -r '.transcript_path // ""')
session_id=$(echo "$input" | jq -r '.session_id // ""')

# Each hook runs in a separate process, so METRICS_SESSION_ID from session-start
# is not inherited. Re-derive it from the same session_id to stay consistent.
METRICS_SESSION_ID=$(derive_session_id "$session_id")
export METRICS_SESSION_ID

# Calculate duration from persisted start timestamp (same pattern as session-stop.sh)
duration_seconds=0
ts_file="${METRICS_DIR}/.session_start_ts_${METRICS_SESSION_ID}"
if [ -f "$ts_file" ]; then
	start_ts=$(cat "$ts_file" 2>/dev/null || echo "0")
	now_ts=$(date +%s)
	duration_seconds=$((now_ts - start_ts))
	# Do NOT delete the timestamp file — Stop hook still needs it for per-turn duration
fi

metrics_on_session_end "$reason" "$duration_seconds"
snapshot_session_cost "$transcript_path"

exit 0
