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
    cat > "${fakebin}/curl" <<EOF
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

@test "refresh-schemas auto-detects Claude from installed settings" {
    local fakebin home_dir
    fakebin="$TEST_TMPDIR/fakebin"
    home_dir="$TEST_TMPDIR/home"

    mkdir -p "$home_dir/.claude"
    printf '{"model":"sonnet"}\n' > "$home_dir/.claude/settings.json"
    create_fake_curl "$fakebin" "https://json.schemastore.org/claude-code-settings.json" '{"type":"object","properties":{"model":{"type":"string"}}}'

    run env HOME="$home_dir" PATH="$fakebin:$PATH" bash "$PROJECT_ROOT/scripts/refresh-schemas.sh"

    [ "$status" -eq 0 ]
    [ -f "$home_dir/.config/agent-smith/schemas/claude-code-settings.schema.json" ]
    [[ "$output" == *"Refreshed Claude Code schema"* ]]
}

@test "refresh-schemas auto-detects Codex from installed config" {
    local fakebin home_dir
    fakebin="$TEST_TMPDIR/fakebin"
    home_dir="$TEST_TMPDIR/home"

    mkdir -p "$home_dir/.codex"
    printf 'model = "gpt-5.4"\n' > "$home_dir/.codex/config.toml"
    create_fake_curl "$fakebin" "https://developers.openai.com/codex/config-schema.json" '{"type":"object","properties":{"model":{"type":"string"}}}'

    run env HOME="$home_dir" PATH="$fakebin:$PATH" bash "$PROJECT_ROOT/scripts/refresh-schemas.sh"

    [ "$status" -eq 0 ]
    [ -f "$home_dir/.config/agent-smith/schemas/codex-config.schema.json" ]
    [[ "$output" == *"Refreshed Codex schema"* ]]
}

@test "validate-agent-config parses Codex TOML and reports schema diff fallback" {
    local home_dir schema_dir
    home_dir="$TEST_TMPDIR/home"
    schema_dir="$home_dir/.config/agent-smith/schemas"

    mkdir -p "$home_dir/.codex" "$schema_dir"
    cat > "$home_dir/.codex/config.toml" <<'EOF'
model = "gpt-5.4"
approval_policy = "on-request"
EOF
    cat > "$schema_dir/codex-config.schema.json" <<'EOF'
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

@test "validate-agent-config parses Claude settings files" {
    local home_dir schema_dir project_dir
    home_dir="$TEST_TMPDIR/home"
    schema_dir="$home_dir/.config/agent-smith/schemas"
    project_dir="$TEST_TMPDIR/project"

    mkdir -p "$home_dir/.claude" "$schema_dir" "$project_dir/.claude"
    printf '{"model":"sonnet","hooks":{}}\n' > "$home_dir/.claude/settings.json"
    printf '{"model":"sonnet","permissions":{}}\n' > "$project_dir/.claude/settings.json"
    cat > "$schema_dir/claude-code-settings.schema.json" <<'EOF'
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
