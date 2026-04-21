#!/usr/bin/env bats

setup() {
    load '../setup_suite'
}

@test "Gemini lifecycle hooks use explicit lifecycle matchers" {
    run jq -r '
        [
          .hooks.SessionStart[0].matcher,
          .hooks.SessionEnd[0].matcher,
          .hooks.SessionEnd[1].matcher
        ] | @tsv
    ' "$PROJECT_ROOT/gemini-extension/hooks/hooks.json"

    [ "$status" -eq 0 ]
    [ "$output" = $'startup|resume|clear\texit|clear|logout\texit|clear|logout' ]
}
