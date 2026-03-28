#!/bin/bash
# PostCompact hook: emit context_compression metric
# Never blocks the agent — exits 0 always

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
transcript_path=$(echo "$input" | jq -r '.transcript_path // ""')
session_id=$(echo "$input" | jq -r '.session_id // ""')

# Each hook runs in a separate process, so METRICS_SESSION_ID from session-start
# is not inherited. Re-derive it from the same session_id to stay consistent.
METRICS_SESSION_ID=$(derive_session_id "$session_id")
export METRICS_SESSION_ID

# The matcher value tells us whether this was auto or manual compact.
# We receive it via COMPACT_TRIGGER env var set by the hook registration,
# or default to "unknown".
trigger="${COMPACT_TRIGGER:-unknown}"

metrics_on_context_compression "$trigger" "$transcript_path"

exit 0
