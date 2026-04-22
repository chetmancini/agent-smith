#!/usr/bin/env bats

setup() {
    load '../setup_suite'
}

@test "Codex uses a single repo-local hooks manifest" {
    [ -f "$PROJECT_ROOT/.codex/hooks.json" ]
    [ ! -e "$PROJECT_ROOT/hooks.json" ]
}

@test "Codex hook manifest does not use unsupported async hooks" {
    run grep -nE '"async"[[:space:]]*:[[:space:]]*true' "$PROJECT_ROOT/.codex/hooks.json"

    [ "$status" -eq 1 ]
}
