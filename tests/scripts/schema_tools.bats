#!/usr/bin/env bats

setup() {
	load '../setup_suite'
	export TEST_TMPDIR
	TEST_TMPDIR="$(mktemp -d)"
}

teardown() {
	rm -rf "$TEST_TMPDIR"
}

create_fake_curl() {
	local fakebin="$1"
	local expected_url="$2"
	local payload="$3"
	mkdir -p "$fakebin"
	cat >"${fakebin}/curl" <<EOF
#!/bin/bash
set -euo pipefail
url=""
output=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o)
      output="\$2"
      shift 2
      ;;
    -f|-s|-S|-L)
      shift
      ;;
    *)
      url="\$1"
      shift
      ;;
  esac
done
[ "\$url" = "$expected_url" ]
printf '%s\n' '$payload' > "\$output"
EOF
	chmod 700 "${fakebin}/curl"
}

@test "refresh-schemas pulls every supported schema by default" {
	local fakebin home_dir
	fakebin="$TEST_TMPDIR/fakebin"
	home_dir="$TEST_TMPDIR/home"

	mkdir -p "$fakebin"
	cat >"${fakebin}/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
url=""
output=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    -f|-s|-S|-L)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
	case "$url" in
	  https://json.schemastore.org/claude-code-settings.json)
	    printf '%s\n' '{"tool":"claude"}' > "$output"
	    ;;
	  https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json)
    printf '%s\n' '{"tool":"gemini"}' > "$output"
    ;;
  https://developers.openai.com/codex/config-schema.json)
    printf '%s\n' '{"tool":"codex"}' > "$output"
    ;;
	  https://opencode.ai/config.json)
	    printf '%s\n' '{"tool":"opencode"}' > "$output"
	    ;;
	  https://models.dev/model-schema.json)
	    printf '%s\n' '{"tool":"models-dev"}' > "$output"
	    ;;
	  *)
	    exit 1
	    ;;
	esac
EOF
	chmod 700 "${fakebin}/curl"

	run env HOME="$home_dir" PATH="$fakebin:$PATH" bash "$PROJECT_ROOT/scripts/refresh-schemas.sh"

	[ "$status" -eq 0 ]
	[ -f "$home_dir/.config/agent-smith/schemas/claude-code-settings.schema.json" ]
	[ -f "$home_dir/.config/agent-smith/schemas/gemini-cli-settings.schema.json" ]
	[ -f "$home_dir/.config/agent-smith/schemas/codex-config.schema.json" ]
	[ -f "$home_dir/.config/agent-smith/schemas/opencode-config.schema.json" ]
	[[ "$output" == *"Refreshed Claude Code schema"* ]]
	[[ "$output" == *"Refreshed Gemini CLI schema"* ]]
	[[ "$output" == *"Refreshed Codex schema"* ]]
	[[ "$output" == *"Refreshed OpenCode schema"* ]]
}

@test "refresh-schemas refreshes only Claude when requested" {
	local fakebin home_dir
	fakebin="$TEST_TMPDIR/fakebin"
	home_dir="$TEST_TMPDIR/home"

	mkdir -p "$home_dir/.claude"
	printf '{"model":"sonnet"}\n' >"$home_dir/.claude/settings.json"
	create_fake_curl "$fakebin" "https://json.schemastore.org/claude-code-settings.json" '{"type":"object","properties":{"model":{"type":"string"}}}'

	run env HOME="$home_dir" PATH="$fakebin:$PATH" bash "$PROJECT_ROOT/scripts/refresh-schemas.sh" --tool claude

	[ "$status" -eq 0 ]
	[ -f "$home_dir/.config/agent-smith/schemas/claude-code-settings.schema.json" ]
	[[ "$output" == *"Refreshed Claude Code schema"* ]]
}

@test "refresh-schemas refreshes only Codex when requested" {
	local fakebin home_dir
	fakebin="$TEST_TMPDIR/fakebin"
	home_dir="$TEST_TMPDIR/home"

	mkdir -p "$home_dir/.codex"
	printf 'model = "gpt-5.4"\n' >"$home_dir/.codex/config.toml"
	create_fake_curl "$fakebin" "https://developers.openai.com/codex/config-schema.json" '{"type":"object","properties":{"model":{"type":"string"}}}'

	run env HOME="$home_dir" PATH="$fakebin:$PATH" bash "$PROJECT_ROOT/scripts/refresh-schemas.sh" --tool codex

	[ "$status" -eq 0 ]
	[ -f "$home_dir/.config/agent-smith/schemas/codex-config.schema.json" ]
	[[ "$output" == *"Refreshed Codex schema"* ]]
}

@test "refresh-schemas refreshes only Gemini when requested" {
	local fakebin home_dir
	fakebin="$TEST_TMPDIR/fakebin"
	home_dir="$TEST_TMPDIR/home"

	mkdir -p "$home_dir/.gemini"
	printf '{"model":"gemini-3-pro"}\n' >"$home_dir/.gemini/settings.json"
	create_fake_curl "$fakebin" "https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json" '{"type":"object","properties":{"model":{"type":"string"}}}'

	run env HOME="$home_dir" PATH="$fakebin:$PATH" bash "$PROJECT_ROOT/scripts/refresh-schemas.sh" --tool gemini

	[ "$status" -eq 0 ]
	[ -f "$home_dir/.config/agent-smith/schemas/gemini-cli-settings.schema.json" ]
	[[ "$output" == *"Refreshed Gemini CLI schema"* ]]
}

@test "validate-agent-config parses Codex TOML and reports schema diff fallback" {
	local home_dir schema_dir
	home_dir="$TEST_TMPDIR/home"
	schema_dir="$home_dir/.config/agent-smith/schemas"

	mkdir -p "$home_dir/.codex" "$schema_dir"
	cat >"$home_dir/.codex/config.toml" <<'EOF'
model = "gpt-5.4"
approval_policy = "on-request"
EOF
	cat >"$schema_dir/codex-config.schema.json" <<'EOF'
{
  "type": "object",
  "properties": {
    "model": { "type": "string" },
    "approval_policy": { "type": "string", "deprecated": true },
    "sandbox_mode": { "type": "string" }
  }
}
EOF

	run env HOME="$home_dir" PATH="$PATH" bash "$PROJECT_ROOT/scripts/validate-agent-config.sh"

	[ "$status" -eq 0 ]
	[[ "$output" == *"Tool: Codex"* ]]
	[[ "$output" == *"Parse: valid toml"* ]]
	[[ "$output" == *"Schema check: skipped (ajv not installed); using schema diff fallback"* ]]
	[[ "$output" == *"Deprecated top-level keys in use: approval_policy"* ]]
	[[ "$output" == *"Available top-level schema keys not set: sandbox_mode"* ]]
}

@test "refresh-schemas refreshes only OpenCode when requested" {
	local fakebin home_dir
	fakebin="$TEST_TMPDIR/fakebin"
	home_dir="$TEST_TMPDIR/home"

	mkdir -p "$home_dir/.config/opencode"
	printf '{"model":"anthropic/claude-sonnet-4-6"}\n' >"$home_dir/.config/opencode/opencode.json"
	mkdir -p "$fakebin"
	cat >"$fakebin/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
url=""
output=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o)
      output="$2"
      shift 2
      ;;
    -f|-s|-S|-L)
      shift
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
case "$url" in
  https://opencode.ai/config.json)
    printf '%s\n' '{"type":"object","properties":{"model":{"type":"string"}}}' > "$output"
    ;;
  https://models.dev/model-schema.json)
    printf '%s\n' '{"$defs":{"Model":{"type":"string"}}}' > "$output"
    ;;
  *)
    exit 1
    ;;
esac
EOF
	chmod 700 "$fakebin/curl"

	run env HOME="$home_dir" PATH="$fakebin:$PATH" bash "$PROJECT_ROOT/scripts/refresh-schemas.sh" --tool opencode

	[ "$status" -eq 0 ]
	[ -f "$home_dir/.config/agent-smith/schemas/opencode-config.schema.json" ]
	[ -f "$home_dir/.config/agent-smith/schemas/models-dev-model.schema.json" ]
	[[ "$output" == *"Refreshed OpenCode schema"* ]]
	[[ "$output" == *"Refreshed models.dev schema"* ]]
}

@test "validate-agent-config parses OpenCode JSON config and reports schema diff" {
	local home_dir schema_dir
	home_dir="$TEST_TMPDIR/home"
	schema_dir="$home_dir/.config/agent-smith/schemas"

	mkdir -p "$home_dir/.config/opencode" "$schema_dir"
	cat >"$home_dir/.config/opencode/opencode.json" <<'EOF'
{
  "model": "anthropic/claude-sonnet-4-6",
  "small_model": "anthropic/claude-haiku-4-5"
}
EOF
	cat >"$schema_dir/opencode-config.schema.json" <<'EOF'
{
  "type": "object",
  "properties": {
    "model": { "type": "string" },
    "small_model": { "type": "string" },
    "compaction": { "type": "object" }
  }
}
EOF

	run env HOME="$home_dir" PATH="$PATH" bash "$PROJECT_ROOT/scripts/validate-agent-config.sh"

	[ "$status" -eq 0 ]
	[[ "$output" == *"Tool: OpenCode"* ]]
	[[ "$output" == *"Parse: valid json"* ]]
	[[ "$output" == *"Available top-level schema keys not set: compaction"* ]]
}

@test "validate-agent-config passes models.dev ref to ajv for OpenCode" {
	local home_dir schema_dir fakebin
	home_dir="$TEST_TMPDIR/home"
	schema_dir="$home_dir/.config/agent-smith/schemas"
	fakebin="$TEST_TMPDIR/fakebin"

	mkdir -p "$home_dir/.config/opencode" "$schema_dir" "$fakebin"
	cat >"$home_dir/.config/opencode/opencode.json" <<'EOF'
{
  "model": "anthropic/claude-sonnet-4-6"
}
EOF
	cat >"$schema_dir/opencode-config.schema.json" <<'EOF'
{
  "type": "object",
  "properties": {
    "model": { "$ref": "https://models.dev/model-schema.json#/$defs/Model" }
  }
}
EOF
	cat >"$schema_dir/models-dev-model.schema.json" <<'EOF'
{
  "$defs": {
    "Model": { "type": "string" }
  }
}
EOF
	cat >"$fakebin/ajv" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" > "${TMPDIR:-/tmp}/agent-smith-ajv-args.txt"
exit 0
EOF
	chmod 700 "$fakebin/ajv"

	run env HOME="$home_dir" PATH="$fakebin:$PATH" TMPDIR="$TEST_TMPDIR" bash "$PROJECT_ROOT/scripts/validate-agent-config.sh" --tool opencode

	[ "$status" -eq 0 ]
	grep -F -- "-r" "$TEST_TMPDIR/agent-smith-ajv-args.txt"
	grep -F -- "$schema_dir/models-dev-model.schema.json" "$TEST_TMPDIR/agent-smith-ajv-args.txt"
	[[ "$output" == *"Schema check: valid (ajv)"* ]]
}

@test "validate-agent-config refreshes missing models.dev cache before OpenCode ajv" {
	local home_dir schema_dir fakebin
	home_dir="$TEST_TMPDIR/home"
	schema_dir="$home_dir/.config/agent-smith/schemas"
	fakebin="$TEST_TMPDIR/fakebin"

	mkdir -p "$home_dir/.config/opencode" "$schema_dir" "$fakebin"
	cat >"$home_dir/.config/opencode/opencode.json" <<'EOF'
{
  "model": "anthropic/claude-sonnet-4-6"
}
EOF
	cat >"$schema_dir/opencode-config.schema.json" <<'EOF'
{
  "type": "object",
  "properties": {
    "model": { "$ref": "https://models.dev/model-schema.json#/$defs/Model" }
  }
}
EOF
	cat >"$fakebin/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
url=""
output=""
while [ $# -gt 0 ]; do
	case "$1" in
	-o)
		output="$2"
		shift 2
		;;
	-f|-s|-S|-L)
		shift
		;;
	*)
		url="$1"
		shift
		;;
	esac
done

	case "$url" in
		https://opencode.ai/config.json)
			cat >"$output" <<'JSON'
{"type":"object","properties":{"model":{"$ref":"https://models.dev/model-schema.json#/$defs/Model"}}}
JSON
			;;
		https://models.dev/model-schema.json)
			cat >"$output" <<'JSON'
{"$defs":{"Model":{"type":"string"}}}
JSON
			;;
		*)
		printf 'unexpected curl url: %s\n' "$url" >&2
		exit 1
		;;
esac
EOF
	chmod 700 "$fakebin/curl"
	cat >"$fakebin/ajv" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" > "${TMPDIR:-/tmp}/agent-smith-ajv-args.txt"
exit 0
EOF
	chmod 700 "$fakebin/ajv"

	run env HOME="$home_dir" PATH="$fakebin:$PATH" TMPDIR="$TEST_TMPDIR" bash "$PROJECT_ROOT/scripts/validate-agent-config.sh" --tool opencode

	[ "$status" -eq 0 ]
	[ -f "$schema_dir/models-dev-model.schema.json" ]
	grep -F -- "-r" "$TEST_TMPDIR/agent-smith-ajv-args.txt"
	grep -F -- "$schema_dir/models-dev-model.schema.json" "$TEST_TMPDIR/agent-smith-ajv-args.txt"
	[[ "$output" == *"Schema check: valid (ajv)"* ]]
}

@test "validate-agent-config skips models.dev refresh when no OpenCode config is installed" {
	local home_dir schema_dir fakebin
	home_dir="$TEST_TMPDIR/home"
	schema_dir="$home_dir/.config/agent-smith/schemas"
	fakebin="$TEST_TMPDIR/fakebin"

	mkdir -p "$schema_dir" "$fakebin"
	cat >"$schema_dir/opencode-config.schema.json" <<'EOF'
{
  "type": "object",
  "properties": {
    "model": { "$ref": "https://models.dev/model-schema.json#/$defs/Model" }
  }
}
EOF
	cat >"$fakebin/curl" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'curl should not run\n' >&2
exit 1
EOF
	chmod 700 "$fakebin/curl"
	cat >"$fakebin/ajv" <<'EOF'
#!/bin/bash
set -euo pipefail
printf 'ajv should not run\n' >&2
exit 1
EOF
	chmod 700 "$fakebin/ajv"

	run env HOME="$home_dir" PATH="$fakebin:$PATH" TMPDIR="$TEST_TMPDIR" bash "$PROJECT_ROOT/scripts/validate-agent-config.sh" --tool opencode

	[ "$status" -eq 0 ]
	[[ "$output" == *"Status: no installed OpenCode config files found"* ]]
}

@test "validate-agent-config parses Claude settings files" {
	local home_dir schema_dir project_dir
	home_dir="$TEST_TMPDIR/home"
	schema_dir="$home_dir/.config/agent-smith/schemas"
	project_dir="$TEST_TMPDIR/project"

	mkdir -p "$home_dir/.claude" "$schema_dir" "$project_dir/.claude"
	printf '{"model":"sonnet","hooks":{}}\n' >"$home_dir/.claude/settings.json"
	printf '{"model":"sonnet","permissions":{}}\n' >"$project_dir/.claude/settings.json"
	cat >"$schema_dir/claude-code-settings.schema.json" <<'EOF'
{
  "type": "object",
  "properties": {
    "model": { "type": "string" },
    "hooks": { "type": "object" },
    "permissions": { "type": "object" }
  }
}
EOF

	run env HOME="$home_dir" PATH="$PATH" bash -lc "cd '$project_dir' && bash '$PROJECT_ROOT/scripts/validate-agent-config.sh'"

	[ "$status" -eq 0 ]
	[[ "$output" == *"Tool: Claude Code"* ]]
	[[ "$output" == *"Config: $home_dir/.claude/settings.json"* ]]
	[[ "$output" == *"Config: $project_dir/.claude/settings.json"* ]]
	[[ "$output" == *"Parse: valid json"* ]]
}

@test "validate-agent-config parses Gemini settings files" {
	local home_dir schema_dir project_dir
	home_dir="$TEST_TMPDIR/home"
	schema_dir="$home_dir/.config/agent-smith/schemas"
	project_dir="$TEST_TMPDIR/project"

	mkdir -p "$home_dir/.gemini" "$schema_dir" "$project_dir/.gemini"
	printf '{"model":"gemini-3-pro","hooks":{}}\n' >"$home_dir/.gemini/settings.json"
	printf '{"model":"gemini-3-flash","output":{}}\n' >"$project_dir/.gemini/settings.json"
	cat >"$schema_dir/gemini-cli-settings.schema.json" <<'EOF'
{
  "type": "object",
  "properties": {
    "model": { "type": "string" },
    "hooks": { "type": "object" },
    "output": { "type": "object" }
  }
}
EOF

	run env HOME="$home_dir" PATH="$PATH" bash -lc "cd '$project_dir' && bash '$PROJECT_ROOT/scripts/validate-agent-config.sh' --tool gemini"

	[ "$status" -eq 0 ]
	[[ "$output" == *"Tool: Gemini CLI"* ]]
	[[ "$output" == *"Config: $home_dir/.gemini/settings.json"* ]]
	[[ "$output" == *"Config: $project_dir/.gemini/settings.json"* ]]
	[[ "$output" == *"Parse: valid json"* ]]
}

@test "validate-agent-config uses draft2020 for Gemini schemas" {
	local home_dir schema_dir fakebin project_dir
	home_dir="$TEST_TMPDIR/home"
	schema_dir="$home_dir/.config/agent-smith/schemas"
	fakebin="$TEST_TMPDIR/fakebin"
	project_dir="$TEST_TMPDIR/project"

	mkdir -p "$home_dir/.gemini" "$schema_dir" "$fakebin" "$project_dir/.gemini"
	printf '{"model":"gemini-3-pro"}\n' >"$project_dir/.gemini/settings.json"
	cat >"$schema_dir/gemini-cli-settings.schema.json" <<'EOF'
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "model": { "type": "string" }
  }
}
EOF
	cat >"$fakebin/ajv" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$@" > "${TMPDIR:-/tmp}/agent-smith-ajv-args.txt"
exit 0
EOF
	chmod 700 "$fakebin/ajv"

	run env HOME="$home_dir" PATH="$fakebin:$PATH" TMPDIR="$TEST_TMPDIR" bash -lc "cd '$project_dir' && bash '$PROJECT_ROOT/scripts/validate-agent-config.sh' --tool gemini"

	[ "$status" -eq 0 ]
	grep -F -- "--spec=draft2020" "$TEST_TMPDIR/agent-smith-ajv-args.txt"
	[[ "$output" == *"Schema check: valid (ajv)"* ]]
}
