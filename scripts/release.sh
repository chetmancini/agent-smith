#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "${SCRIPT_DIR}/.." && pwd)

usage() {
	cat <<'EOF'
Usage:
  scripts/release.sh <version>

Example:
  scripts/release.sh 1.0.1
EOF
}

if [[ $# -ne 1 ]]; then
	usage >&2
	exit 1
fi

version=$1
tag="v${version}"

if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+)*$ ]]; then
	echo "Version must look like 1.2.3 or 1.2.3-rc1" >&2
	exit 1
fi

cd "$REPO_ROOT"

if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "Working tree must be clean before release." >&2
	echo "Commit or stash your current changes, then rerun make release VERSION=${version}." >&2
	exit 1
fi

if git rev-parse --verify --quiet "$tag" >/dev/null; then
	echo "Tag already exists: $tag" >&2
	exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
	echo "gh CLI is required for releases." >&2
	exit 1
fi

gh auth status >/dev/null

"${SCRIPT_DIR}/set-version.sh" "$version"

git add \
	VERSION \
	.claude-plugin/plugin.json \
	.claude-plugin/marketplace.json \
	.codex-plugin/plugin.json \
	.opencode-plugin/plugin.json

git commit -m "Release ${tag}"
git tag -a "$tag" -m "Release ${tag}"
git push origin HEAD
git push origin "$tag"
gh release create "$tag" --generate-notes

echo "Published ${tag}"
