#!/usr/bin/env bats

setup() {
    load '../setup_suite'
}

@test "repo-local Codex hooks mirror the legacy root hooks file" {
    run cmp -s "$PROJECT_ROOT/.codex/hooks.json" "$PROJECT_ROOT/hooks.json"

    [ "$status" -eq 0 ]
}

@test "Codex hook manifest does not use unsupported async hooks" {
    run grep -nE '"async"[[:space:]]*:[[:space:]]*true' "$PROJECT_ROOT/.codex/hooks.json" "$PROJECT_ROOT/hooks.json"

    [ "$status" -eq 1 ]
}
