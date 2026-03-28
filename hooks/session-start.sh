#!/bin/bash
# Session start hook: emit session_start metric and persist transcript path
# Reads PROJECT_TYPE from environment (set by user's own hooks) or defaults to "unknown"

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
transcript_path=$(echo "$input" | jq -r '.transcript_path // ""')

metrics_on_session_start "${CLAUDE_PROJECT_DIR:-$(pwd)}" "${PROJECT_TYPE:-unknown}" "${CLAUDE_SESSION_ID:-}"

# Persist session_id + transcript_path so rollup can calculate session cost.
# METRICS_SESSION_ID was set by metrics_on_session_start using derive_session_id
# on CLAUDE_SESSION_ID. Rollup must use this exact ID (not re-derive from the
# transcript path, which would produce a different hash).
if [ -n "$transcript_path" ]; then
	_ensure_metrics_dir
	printf '%s\t%s\n' "$METRICS_SESSION_ID" "$transcript_path" >>"${METRICS_DIR}/.transcript_paths" 2>/dev/null || true
	_harden_path "${METRICS_DIR}/.transcript_paths" 600
fi

exit 0
