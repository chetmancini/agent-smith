#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/agent-tool.sh
source "${SCRIPT_DIR}/lib/agent-tool.sh"

TOOL=""
REFRESH=0

while [ $# -gt 0 ]; do
	case "$1" in
	--tool)
		TOOL="${2:-}"
		shift 2
		;;
	--refresh)
		REFRESH=1
		shift
		;;
	-h | --help)
		cat <<'EOF'
Usage: validate-agent-config.sh [--tool claude|codex] [--refresh]

Validate the active agent's installed config files against the cached schema.
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
SCHEMA_PATH="$(agent_smith_schema_cache_path "$TOOL")"
SCHEMA_LABEL="$(agent_smith_tool_label "$TOOL")"

if [ "$REFRESH" -eq 1 ] || [ ! -f "$SCHEMA_PATH" ]; then
	AGENT_SMITH_TOOL="$TOOL" bash "${PLUGIN_ROOT}/scripts/refresh-schemas.sh" >/dev/null
fi

if [ ! -f "$SCHEMA_PATH" ]; then
	echo "Error: schema cache missing at $SCHEMA_PATH" >&2
	exit 1
fi

AJV_BIN=""
if command -v ajv >/dev/null 2>&1; then
	AJV_BIN="ajv"
fi

gather_config_files() {
	case "$TOOL" in
	claude)
		while IFS= read -r candidate; do
			[ -n "$candidate" ] || continue
			if [ -f "$candidate" ]; then
				printf '%s\n' "$candidate"
			fi
		done <<EOF
$(agent_smith_claude_config_candidates)
EOF
		;;
	codex)
		if [ -f "${HOME}/.codex/config.toml" ]; then
			printf '%s\n' "${HOME}/.codex/config.toml"
		fi
		;;
	esac
}

CONFIG_FILES="$(gather_config_files)"

printf 'Schema Validation Summary\n'
printf 'Tool: %s\n' "$SCHEMA_LABEL"
printf 'Schema: %s\n' "$SCHEMA_PATH"

if [ -z "$CONFIG_FILES" ]; then
	printf 'Status: no installed %s config files found\n' "$SCHEMA_LABEL"
	exit 0
fi

VALIDATION_STATUS=0

while IFS= read -r config_path; do
	[ -n "$config_path" ] || continue

	tmp_json=""
	parse_mode="json"
	ajv_spec="draft7"

	if [ "$TOOL" = "codex" ]; then
		parse_mode="toml"
		ajv_spec="draft2020"
		tmp_json="$(mktemp "${TMPDIR:-/tmp}/agent-smith-config.XXXXXX.json")"
		if ! python3 - "$config_path" "$tmp_json" <<'PY'; then
import json
import sys

try:
    import tomllib
except ModuleNotFoundError:
    try:
        import tomli as tomllib
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "python3 with tomllib support or the tomli package is required for Codex config validation"
        ) from exc

config_path, output_path = sys.argv[1:3]
with open(config_path, "rb") as fh:
    payload = tomllib.load(fh)
with open(output_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
			printf '\nConfig: %s\n' "$config_path"
			printf 'Result: invalid TOML\n'
			VALIDATION_STATUS=1
			rm -f "$tmp_json"
			continue
		fi
	else
		if ! jq empty "$config_path" >/dev/null 2>&1; then
			printf '\nConfig: %s\n' "$config_path"
			printf 'Result: invalid JSON\n'
			VALIDATION_STATUS=1
			continue
		fi
		tmp_json="$config_path"
	fi

	printf '\nConfig: %s\n' "$config_path"
	printf 'Parse: valid %s\n' "$parse_mode"

	if [ -n "$AJV_BIN" ]; then
		if ajv validate -s "$SCHEMA_PATH" -d "$tmp_json" --spec="$ajv_spec" >/tmp/agent-smith-ajv.out 2>/tmp/agent-smith-ajv.err; then
			printf 'Schema check: valid (ajv)\n'
		else
			printf 'Schema check: invalid (ajv)\n'
			sed 's/^/  /' /tmp/agent-smith-ajv.err
			VALIDATION_STATUS=1
		fi
	else
		printf 'Schema check: skipped (ajv not installed); using schema diff fallback\n'
	fi

	python3 - "$SCHEMA_PATH" "$tmp_json" <<'PY'
import json
import sys

schema_path, config_path = sys.argv[1:3]
with open(schema_path, "r", encoding="utf-8") as fh:
    schema = json.load(fh)
with open(config_path, "r", encoding="utf-8") as fh:
    config = json.load(fh)

schema_props = schema.get("properties", {})
if not isinstance(schema_props, dict) or not isinstance(config, dict):
    print("Schema diff: unavailable (non-object root)")
    raise SystemExit(0)

config_keys = set(config.keys())
schema_keys = set(schema_props.keys())
unknown = sorted(config_keys - schema_keys)
deprecated = sorted(
    key for key in config_keys
    if isinstance(schema_props.get(key), dict) and schema_props[key].get("deprecated") is True
)
available = sorted(schema_keys - config_keys)

if unknown:
    print("Unknown top-level keys: " + ", ".join(unknown))
else:
    print("Unknown top-level keys: none")

if deprecated:
    print("Deprecated top-level keys in use: " + ", ".join(deprecated))
else:
    print("Deprecated top-level keys in use: none")

if available:
    preview = ", ".join(available[:10])
    suffix = " ..." if len(available) > 10 else ""
    print("Available top-level schema keys not set: " + preview + suffix)
else:
    print("Available top-level schema keys not set: none")
PY

	if [ "$TOOL" = "codex" ]; then
		rm -f "$tmp_json"
	fi
done <<EOF
$CONFIG_FILES
EOF

rm -f /tmp/agent-smith-ajv.out /tmp/agent-smith-ajv.err

exit "$VALIDATION_STATUS"
