#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/agent-tool.sh
source "${SCRIPT_DIR}/lib/agent-tool.sh"

MODE="${1:-}"
TOOL=""
AGENT_CLI_BIN="${AGENT_CLI:-}"
SESSIONS="${SESSIONS:-50}"

usage() {
	cat <<'EOF'
Usage: scripts/run-agent-skill.sh <analyze-config|validate-schemas|upgrade-settings|loop> [--tool claude|codex|opencode]
EOF
}

if [ -z "${MODE}" ]; then
	usage >&2
	exit 1
fi
shift

while [ $# -gt 0 ]; do
	case "$1" in
	--tool)
		TOOL="${2:-}"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "Error: unknown argument '$1'" >&2
		usage >&2
		exit 1
		;;
	esac
done

TOOL="$(agent_smith_detect_tool "$TOOL")"

case "${MODE}" in
analyze-config)
	COMMON_PROMPT="Use the analyze-config skill from the loaded plugin to review the latest Agent Smith metrics for ${TOOL}.

Run the full skill workflow. Use ${SESSIONS} sessions for the analysis unless the local data set is smaller. When the skill invokes local scripts, treat --tool ${TOOL} as the active tool."
	;;
validate-schemas)
	COMMON_PROMPT="Use the validate-schemas skill from the loaded plugin to validate the current ${TOOL} configuration files only and report new, deprecated, or invalid settings."
	;;
upgrade-settings)
	COMMON_PROMPT="Use the upgrade-settings skill from the loaded plugin to refresh the latest ${TOOL} schema, compare it against the current ${TOOL} configuration files, and produce an implementation plan.

Run the full skill workflow. When the skill invokes local scripts, treat --tool ${TOOL} as the active tool. The final result should clearly cover:
- new schema-backed features worth adopting now
- deprecated or unknown config that should be removed or migrated
- lower-priority schema capabilities worth investigating later
- an ordered implementation plan with exact files and validation steps"
	;;
loop)
	COMMON_PROMPT="Use the validate-schemas skill first, then the analyze-config skill from the loaded plugin.

Validate the current ${TOOL} configuration files only, then analyze the latest Agent Smith metrics for ${TOOL} using ${SESSIONS} sessions. When the skills invoke local scripts, treat --tool ${TOOL} as the active tool. Cross-reference the two results as described in the skills and produce one combined summary with:
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

case "${TOOL}" in
claude)
	AGENT_BIN="${AGENT_CLI_BIN:-claude}"
	;;
codex)
	AGENT_BIN="${AGENT_CLI_BIN:-codex}"
	;;
opencode)
	AGENT_BIN="${AGENT_CLI_BIN:-opencode}"
	;;
*)
	echo "Error: unsupported tool '${TOOL}'" >&2
	exit 1
	;;
esac

if ! command -v "${AGENT_BIN}" >/dev/null 2>&1; then
	echo "Error: ${AGENT_BIN} CLI not found in PATH" >&2
	exit 1
fi

case "${TOOL}" in
claude)
	# Claude needs the plugin directory injected explicitly for one-shot runs.
	exec "${AGENT_BIN}" --plugin-dir "${PLUGIN_ROOT}" -p "${COMMON_PROMPT}"
	;;
codex)
	# Codex loads the local plugin manifest from the repo itself, so run in repo context.
	exec "${AGENT_BIN}" exec -C "${PLUGIN_ROOT}" "${COMMON_PROMPT}"
	;;
opencode)
	# OpenCode uses `run` for one-shot execution with --dir to set the working directory.
	exec "${AGENT_BIN}" run --dir "${PLUGIN_ROOT}" "${COMMON_PROMPT}"
	;;
esac
