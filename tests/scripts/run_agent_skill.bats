#!/usr/bin/env bats

setup() {
    load '../setup_suite'
    export TEST_TMPDIR
    TEST_TMPDIR="$(mktemp -d)"
}

teardown() {
    rm -rf "$TEST_TMPDIR"
}

create_fake_agent() {
    local fakebin="$1"
    local name="$2"
    mkdir -p "$fakebin"
    cat > "${fakebin}/${name}" <<'EOF'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*"
EOF
    chmod 700 "${fakebin}/${name}"
}

@test "run-agent-skill dispatches Claude with plugin-dir and print mode" {
    local fakebin
    fakebin="$TEST_TMPDIR/fakebin"
    create_fake_agent "$fakebin" fake-claude

    run env PATH="$fakebin:$PATH" AGENT_CLI=fake-claude SESSIONS=75 \
        bash "$PROJECT_ROOT/scripts/run-agent-skill.sh" analyze-config --tool claude

    [ "$status" -eq 0 ]
    [[ "$output" == --plugin-dir\ "$PROJECT_ROOT"\ -p* ]]
    [[ "$output" == *"Use the analyze-config skill from the loaded plugin"* ]]
    [[ "$output" == *"Use 75 sessions"* ]]
    [[ "$output" == *"--tool claude"* ]]
}

@test "run-agent-skill dispatches Codex via codex exec in repo context" {
    local fakebin
    fakebin="$TEST_TMPDIR/fakebin"
    create_fake_agent "$fakebin" fake-codex

    run env PATH="$fakebin:$PATH" AGENT_CLI=fake-codex SESSIONS=25 \
        bash "$PROJECT_ROOT/scripts/run-agent-skill.sh" loop --tool codex

    [ "$status" -eq 0 ]
    [[ "$output" == exec\ -C\ "$PROJECT_ROOT"* ]]
    [[ "$output" == *"Use the validate-schemas skill first, then the analyze-config skill"* ]]
    [[ "$output" == *"--tool codex"* ]]
    [[ "$output" == *"25 sessions"* ]]
}

@test "run-claude-skill wrapper forwards to the generic helper" {
    local fakebin
    fakebin="$TEST_TMPDIR/fakebin"
    create_fake_agent "$fakebin" fake-claude

    run env PATH="$fakebin:$PATH" AGENT_CLI=fake-claude \
        bash "$PROJECT_ROOT/scripts/run-claude-skill.sh" validate-schemas --tool claude

    [ "$status" -eq 0 ]
    [[ "$output" == --plugin-dir\ "$PROJECT_ROOT"\ -p* ]]
    [[ "$output" == *"validate the current claude configuration files only"* ]]
}
