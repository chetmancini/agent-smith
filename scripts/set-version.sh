#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)
VERSION_FILE="${REPO_ROOT}/VERSION"

usage() {
	cat <<'EOF'
Usage:
  scripts/set-version.sh <version>
  scripts/set-version.sh --sync

Examples:
  scripts/set-version.sh 1.0.1
  scripts/set-version.sh --sync
EOF
}

if [[ $# -ne 1 ]]; then
	usage >&2
	exit 1
fi

arg=$1

if [[ $arg == "--sync" ]]; then
	if [[ ! -f $VERSION_FILE ]]; then
		echo "VERSION file not found: $VERSION_FILE" >&2
		exit 1
	fi
	version=$(tr -d '[:space:]' <"$VERSION_FILE")
else
	version=$arg
fi

if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+)*$ ]]; then
	echo "Version must look like 1.2.3 or 1.2.3-rc1" >&2
	exit 1
fi

printf '%s\n' "$version" >"$VERSION_FILE"

update_json() {
	local file=$1
	local filter=$2
	local tmp

	tmp=$(mktemp "${TMPDIR:-/tmp}/agent-smith-version.XXXXXX")
	jq --arg version "$version" "$filter" "$file" >"$tmp"
	mv "$tmp" "$file"
}

# shellcheck disable=SC2016
update_json "${REPO_ROOT}/.claude-plugin/plugin.json" '.version = $version'
# shellcheck disable=SC2016
update_json "${REPO_ROOT}/.codex-plugin/plugin.json" '.version = $version'
# shellcheck disable=SC2016
update_json "${REPO_ROOT}/gemini-extension/gemini-extension.json" '.version = $version'
# shellcheck disable=SC2016
update_json "${REPO_ROOT}/agent-smith-app/package.json" '.version = $version'
# shellcheck disable=SC2016
update_json "${REPO_ROOT}/opencode-plugin/package.json" '.version = $version'
# shellcheck disable=SC2016
update_json "${REPO_ROOT}/.claude-plugin/marketplace.json" '
  .metadata.version = $version
  | .plugins |= map(if .name == "agent-smith" then .version = $version else . end)
'

echo "Synced Agent Smith version to ${version}"
echo "Updated:"
echo "  VERSION"
echo "  .claude-plugin/plugin.json"
echo "  .claude-plugin/marketplace.json"
echo "  .codex-plugin/plugin.json"
echo "  gemini-extension/gemini-extension.json"
echo "  agent-smith-app/package.json"
echo "  opencode-plugin/package.json"
