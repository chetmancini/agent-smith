#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/agent-tool.sh
source "${SCRIPT_DIR}/lib/agent-tool.sh"

TOOL=""

while [ $# -gt 0 ]; do
	case "$1" in
	--tool)
		TOOL="${2:-}"
		shift 2
		;;
	-h | --help)
		cat <<'EOF'
Usage: refresh-schemas.sh [--tool claude|codex|opencode]

Refresh the cached JSON schema for the active agent only.
EOF
		exit 0
		;;
	*)
		echo "Error: unknown argument '$1'" >&2
		exit 1
		;;
	esac
done

TOOL="$(agent_smith_detect_tool "$TOOL")"
SCHEMA_URL="$(agent_smith_schema_url "$TOOL")"
SCHEMA_PATH="$(agent_smith_schema_cache_path "$TOOL")"
METADATA_PATH="$(agent_smith_schema_metadata_path "$TOOL")"
SCHEMA_DIR="$(dirname "$SCHEMA_PATH")"
TMP_SCHEMA="$(mktemp "${TMPDIR:-/tmp}/agent-smith-schema.XXXXXX")"

cleanup() {
	rm -f "$TMP_SCHEMA"
}
trap cleanup EXIT

mkdir -p "$SCHEMA_DIR"

curl -fsSL "$SCHEMA_URL" -o "$TMP_SCHEMA"
mv "$TMP_SCHEMA" "$SCHEMA_PATH"
chmod 600 "$SCHEMA_PATH" 2>/dev/null || true

python3 - "$TOOL" "$SCHEMA_URL" "$SCHEMA_PATH" "$METADATA_PATH" <<'PY'
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
chmod 600 "$METADATA_PATH" 2>/dev/null || true

printf 'Refreshed %s schema: %s\n' "$(agent_smith_tool_label "$TOOL")" "$SCHEMA_PATH"
