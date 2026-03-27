#!/bin/bash
# Session start hook: emit session_start metric
# Reads PROJECT_TYPE from environment (set by user's own hooks) or defaults to "unknown"

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

metrics_on_session_start "${CLAUDE_PROJECT_DIR:-$(pwd)}" "${PROJECT_TYPE:-unknown}" "${CLAUDE_SESSION_ID:-}"

exit 0
