#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODE="${1:-}"
CLAUDE_BIN="${CLAUDE:-claude}"
SESSIONS="${SESSIONS:-50}"

usage() {
	cat <<'EOF'
Usage: scripts/run-claude-skill.sh <analyze-config|validate-schemas|loop>
EOF
}

if [ -z "${MODE}" ]; then
	usage >&2
	exit 1
fi

if ! command -v "${CLAUDE_BIN}" >/dev/null 2>&1; then
	echo "Error: ${CLAUDE_BIN} CLI not found in PATH" >&2
	exit 1
fi

case "${MODE}" in
analyze-config)
	PROMPT="Use the analyze-config skill from the loaded plugin to review the latest Agent Smith metrics.

Run the full skill workflow. Use ${SESSIONS} sessions for the analysis unless the local data set is smaller."
	;;
validate-schemas)
	PROMPT="Use the validate-schemas skill from the loaded plugin to validate the available agent configuration files and report new, deprecated, or invalid settings."
	;;
loop)
	PROMPT="Use the validate-schemas skill first, then the analyze-config skill from the loaded plugin.

Validate the available agent configuration files, then analyze the latest Agent Smith metrics using ${SESSIONS} sessions. Cross-reference the two results as described in the skills and produce one combined summary with:
- validation errors
- new or deprecated config worth acting on
- metrics-backed tuning suggestions
- which changes are safe to apply directly versus which require approval"
	;;
*)
	usage >&2
	exit 1
	;;
esac

exec "${CLAUDE_BIN}" --plugin-dir "${PLUGIN_ROOT}" -p "${PROMPT}"
