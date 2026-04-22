#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/agent-tool.sh
source "${SCRIPT_DIR}/lib/agent-tool.sh"

TOOL=""
TMP_SCHEMA=""

while [ $# -gt 0 ]; do
	case "$1" in
	--tool)
		TOOL="${2:-}"
		shift 2
		;;
	-h | --help)
		cat <<'EOF'
Usage: refresh-schemas.sh [--tool claude|gemini|codex|opencode|pi]

Refresh cached JSON schemas for all supported agents by default.
Use --tool to refresh only one schema.
EOF
		exit 0
		;;
	*)
		echo "Error: unknown argument '$1'" >&2
		exit 1
		;;
	esac
done

refresh_schema() {
	local tool="$1"
	local schema_url schema_path metadata_path schema_dir models_dev_schema_path

	schema_url="$(agent_smith_schema_url "$tool")"
	schema_path="$(agent_smith_schema_cache_path "$tool")"
	metadata_path="$(agent_smith_schema_metadata_path "$tool")"
	schema_dir="$(dirname "$schema_path")"

	mkdir -p "$schema_dir"
	if [ "$tool" = "pi" ]; then
		cp "${SCRIPT_DIR}/../schemas/pi-settings.schema.json" "$schema_path"
		chmod 600 "$schema_path" 2>/dev/null || true
	else
		TMP_SCHEMA="$(mktemp "${TMPDIR:-/tmp}/agent-smith-schema.XXXXXX")"
		curl -fsSL "$schema_url" -o "$TMP_SCHEMA"
		mv "$TMP_SCHEMA" "$schema_path"
		TMP_SCHEMA=""
		chmod 600 "$schema_path" 2>/dev/null || true
	fi

	if [ "$tool" = "opencode" ]; then
		models_dev_schema_path="$(agent_smith_models_dev_schema_cache_path)"
		TMP_SCHEMA="$(mktemp "${TMPDIR:-/tmp}/agent-smith-schema.XXXXXX")"
		curl -fsSL "https://models.dev/model-schema.json" -o "$TMP_SCHEMA"
		mv "$TMP_SCHEMA" "$models_dev_schema_path"
		TMP_SCHEMA=""
		chmod 600 "$models_dev_schema_path" 2>/dev/null || true
	fi

	python3 - "$tool" "$schema_url" "$schema_path" "$metadata_path" <<'PY'
import json
import sys
from datetime import datetime, timezone

tool, url, schema_path, metadata_path = sys.argv[1:5]

metadata = {
    "tool": tool,
    "schema_url": url,
    "schema_path": schema_path,
    "fetched_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
}

with open(metadata_path, "w", encoding="utf-8") as fh:
    json.dump(metadata, fh, indent=2)
    fh.write("\n")
PY
	chmod 600 "$metadata_path" 2>/dev/null || true

	printf 'Refreshed %s schema: %s\n' "$(agent_smith_tool_label "$tool")" "$schema_path"
	if [ "$tool" = "opencode" ]; then
		printf 'Refreshed models.dev schema: %s\n' "$(agent_smith_models_dev_schema_cache_path)"
	fi
}

cleanup() {
	rm -f "${TMP_SCHEMA:-}"
}
trap cleanup EXIT

if [ -n "$TOOL" ]; then
	refresh_schema "$(agent_smith_detect_tool "$TOOL")"
	exit 0
fi

if [ -n "${AGENT_SMITH_TOOL:-}" ]; then
	refresh_schema "$(agent_smith_detect_tool)"
	exit 0
fi

while IFS= read -r tool; do
	refresh_schema "$tool"
done <<EOF
$(agent_smith_supported_tools)
EOF
