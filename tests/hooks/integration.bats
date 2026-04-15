#!/usr/bin/env bats
# Integration tests: hook payload semantics and session-ID continuity
# These tests pipe realistic JSON payloads into the actual hook scripts
# and verify the emitted events have correct, consistent session IDs.

setup() {
    load '../setup_suite'
    export TEST_TMPDIR
    TEST_TMPDIR="$(mktemp -d)"
    export METRICS_DIR="$TEST_TMPDIR/metrics"
    export METRICS_FILE="$METRICS_DIR/events.jsonl"
    export AGENT_METRICS_ENABLED=1
    mkdir -p "$METRICS_DIR"
}

teardown() {
    rm -rf "$TEST_TMPDIR"
}

# Helper: derive the expected session ID the same way the hooks do
expected_session_id() {
    printf '%s' "$1" | shasum -a 256 2>/dev/null | cut -c1-12
}

start_claude_session() {
    local session_hint="$1"
    local project_dir="${2:-/tmp/project}"

    echo '{}' | env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="$project_dir" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"
}

assert_metrics_file_has_only_session_id() {
    local expected_sid="$1"
    local session_ids

    session_ids=$(jq -r '.session_id' "$METRICS_FILE" | sort -u)
    [ "$session_ids" = "$expected_sid" ]
}

create_fake_pytest() {
    local fakebin="$1"
    local exit_code="${2:-1}"
    mkdir -p "$fakebin"
    cat > "${fakebin}/pytest" <<EOF
#!/bin/bash
exit ${exit_code}
EOF
    chmod 700 "${fakebin}/pytest"
}

# ============================================================================
# Session-ID continuity across hooks
# ============================================================================

@test "lifecycle hooks reuse the same derived session_id" {
    local session_hint="lifecycle-session"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    start_claude_session "$session_hint" "/tmp"

    printf '{"session_id":"%s","transcript_path":""}' "$session_hint" | \
        env METRICS_DIR="$METRICS_DIR" \
        COMPACT_TRIGGER=auto \
        bash "$HOOKS_DIR/compact.sh"

    printf '{"stop_reason":"end_turn","session_id":"%s","transcript_path":""}' "$session_hint" | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-stop.sh"

    local event_types
    event_types=$(jq -r '.event_type' "$METRICS_FILE")

    [ "$(printf '%s\n' "$event_types" | wc -l | tr -d ' ')" -eq 3 ]
    [ "$event_types" = $'session_start\ncontext_compression\nsession_stop' ]
    assert_metrics_file_has_only_session_id "$expected_sid"
}

@test "non-lifecycle hook emitters reuse the active session_id" {
    local session_hint="non-lifecycle-session"
    local expected_sid fakebin
    expected_sid=$(expected_session_id "$session_hint")
    fakebin="$TEST_TMPDIR/fakebin"

    : > "$METRICS_FILE"
    mkdir -p "$TEST_TMPDIR/app" "$TEST_TMPDIR/tests"
    printf 'def value():\n    return 1\n' > "$TEST_TMPDIR/app/foo.py"
    printf 'def test_value():\n    assert False\n' > "$TEST_TMPDIR/tests/test_foo.py"
    create_fake_pytest "$fakebin" 1

    start_claude_session "$session_hint" "$TEST_TMPDIR"
    : > "$METRICS_FILE"

    printf '{"tool_name":"Bash","error":"exit 1","tool_input":{"command":"false"}}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-failure.sh"

    printf '{"prompt":"fix it"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/vague-prompt.sh" >/dev/null

    printf '{"tool_name":"Write"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/permission-denied.sh"

    for _ in 1 2 3; do
        (
            cd "$TEST_TMPDIR" || exit 1
            printf '{"tool_input":{"file_path":"%s"}}' "$TEST_TMPDIR/app/foo.py" | \
                env PATH="$fakebin:$PATH" METRICS_DIR="$METRICS_DIR" \
                bash "$HOOKS_DIR/test-result.sh"
        )
    done

    printf '{"tool_name":"Bash","tool_input":{"command":"git status"},"tool_use_id":"tu-remaining","turn_id":"turn-remaining"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-attempt.sh"

    printf '{"error_type":"server_error","turn_id":"turn-remaining","tool_use_id":"tu-remaining"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/stop-failure.sh"

    printf '{"agent_id":"ag-remaining","agent_type":"Explore","turn_id":"turn-remaining","tool_use_id":"tu-remaining"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/subagent-start.sh"

    printf '{"agent_id":"ag-remaining","agent_type":"Explore","turn_id":"turn-remaining","tool_use_id":"tu-remaining"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/subagent-stop.sh"

    local event_types
    event_types=$(jq -r '.event_type' "$METRICS_FILE")

    [ "$(printf '%s\n' "$event_types" | wc -l | tr -d ' ')" -eq 9 ]
    [[ "$event_types" == *"tool_failure"* ]]
    [[ "$event_types" == *"command_failure"* ]]
    [[ "$event_types" == *"clarifying_question"* ]]
    [[ "$event_types" == *"permission_denied"* ]]
    [[ "$event_types" == *"test_failure_loop"* ]]
    [[ "$event_types" == *"tool_attempt"* ]]
    [[ "$event_types" == *"stop_failure"* ]]
    [[ "$event_types" == *"subagent_start"* ]]
    [[ "$event_types" == *"subagent_stop"* ]]
    assert_metrics_file_has_only_session_id "$expected_sid"
}

# ============================================================================
# Hook payload semantics
# ============================================================================

@test "session-start persists session_id and transcript_path for rollup" {
    local transcript="/tmp/test-transcript.jsonl"
    local expected_sid
    expected_sid=$(expected_session_id "sess-123")

    printf '{"transcript_path":"%s"}' "$transcript" | \
        env CLAUDE_SESSION_ID="sess-123" \
        CLAUDE_PROJECT_DIR="/tmp" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    [ -f "$METRICS_DIR/.transcript_paths" ]
    # Format: <session_id>\t<transcript_path>
    grep -q "$transcript" "$METRICS_DIR/.transcript_paths"
    grep -q "$expected_sid" "$METRICS_DIR/.transcript_paths"
    # Verify tab-separated format
    local line
    line=$(cat "$METRICS_DIR/.transcript_paths")
    [ "$line" = "${expected_sid}	${transcript}" ]
}

@test "session-start handles missing transcript_path gracefully" {
    echo '{}' | env CLAUDE_SESSION_ID="sess-456" \
        CLAUDE_PROJECT_DIR="/tmp" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    # Should still emit the event
    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "session_start"

    # transcript_paths file should not be created (or should not contain empty line)
    if [ -f "$METRICS_DIR/.transcript_paths" ]; then
        # File exists but should not have an empty-string entry
        local content
        content=$(cat "$METRICS_DIR/.transcript_paths")
        [ -z "$content" ] || [ "$content" = "" ] && return 0
        # If there's actual content, that's wrong
        return 1
    fi
}

@test "session-start with metrics disabled does not fail on unbound METRICS_SESSION_ID" {
    printf '{"transcript_path":"/tmp/some-transcript.jsonl"}' | \
        env AGENT_METRICS_ENABLED=0 \
        CLAUDE_SESSION_ID="sess-disabled" \
        CLAUDE_PROJECT_DIR="/tmp" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    # Hook should exit 0 and not create transcript_paths or events
    [ ! -f "$METRICS_FILE" ]
    [ ! -f "$METRICS_DIR/.transcript_paths" ]
}

@test "session-stop reads stop_reason from stdin payload" {
    printf '{"stop_reason":"max_tokens","session_id":"hint","transcript_path":""}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-stop.sh"

    run jq -r '.metadata.stop_reason' "$METRICS_FILE"
    assert_output "max_tokens"
}

@test "session-stop defaults stop_reason when missing from payload" {
    printf '{"session_id":"hint"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-stop.sh"

    run jq -r '.metadata.stop_reason' "$METRICS_FILE"
    assert_output "completed"
}

@test "session-start accepts Codex payload fields and tags the event as codex" {
    local session_hint="codex-session-123"
    local transcript="$TEST_TMPDIR/codex-transcript.jsonl"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    printf '{"cwd":"/tmp/codex-project","session_id":"%s","transcript_path":"%s"}' \
        "$session_hint" "$transcript" | \
        env AGENT_SMITH_TOOL=codex \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    run jq -r '.tool' "$METRICS_FILE"
    assert_output "codex"

    run jq -r '.session_id' "$METRICS_FILE"
    assert_output "$expected_sid"

    run jq -r '.metadata.cwd' "$METRICS_FILE"
    assert_output "/tmp/codex-project"
}

@test "session-start accepts OpenCode payload fields and tags the event as opencode" {
    local session_hint="opencode-session-123"
    local transcript="$TEST_TMPDIR/opencode-transcript.jsonl"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    printf '{"cwd":"/tmp/opencode-project","session_id":"%s","transcript_path":"%s"}' \
        "$session_hint" "$transcript" | \
        env AGENT_SMITH_TOOL=opencode \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    run jq -r '.tool' "$METRICS_FILE"
    assert_output "opencode"

    run jq -r '.session_id' "$METRICS_FILE"
    assert_output "$expected_sid"

    run jq -r '.metadata.cwd' "$METRICS_FILE"
    assert_output "/tmp/opencode-project"
}

@test "session-stop can use a Codex-specific default stop reason" {
    printf '{"session_id":"codex-stop-1","transcript_path":""}' | \
        env AGENT_SMITH_TOOL=codex \
        AGENT_SMITH_DEFAULT_STOP_REASON=turn_complete \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-stop.sh"

    run jq -r '.metadata.stop_reason' "$METRICS_FILE"
    assert_output "turn_complete"
}

@test "session-stop can use an OpenCode-specific default stop reason" {
    printf '{"session_id":"opencode-stop-1","transcript_path":""}' | \
        env AGENT_SMITH_TOOL=opencode \
        AGENT_SMITH_DEFAULT_STOP_REASON=turn_complete \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-stop.sh"

    run jq -r '.metadata.stop_reason' "$METRICS_FILE"
    assert_output "turn_complete"
}

@test "vague-prompt emits plain text for OpenCode and logs an opencode event" {
    run bash -c "printf '%s' '{\"prompt\":\"fix it\"}' | AGENT_SMITH_TOOL=opencode METRICS_DIR='$METRICS_DIR' bash '$HOOKS_DIR/vague-prompt.sh'"
    assert_success
    local hook_output="$output"

    # OpenCode gets plain text, not JSON
    [[ "$hook_output" == *"brief and may be ambiguous"* ]]
    # Should NOT be JSON formatted like Codex
    ! jq -e '.hookSpecificOutput' <<<"$hook_output" 2>/dev/null || true

    run jq -r '.tool' "$METRICS_FILE"
    assert_output "opencode"
}

@test "tool-failure detects OpenCode Bash failures from post-tool-use payloads" {
    printf '{"tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{"exit_code":1,"stderr":"boom"}}' | \
        env AGENT_SMITH_TOOL=opencode \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-failure.sh"

    local event_types
    event_types=$(jq -r '.event_type' "$METRICS_FILE")
    [ "$event_types" = $'tool_failure\ncommand_failure' ]

    run jq -r 'select(.event_type == "tool_failure") | .tool' "$METRICS_FILE"
    assert_output "opencode"
}

@test "vague-prompt emits Codex additionalContext JSON and logs a codex event" {
    run bash -c "printf '%s' '{\"prompt\":\"fix it\"}' | AGENT_SMITH_TOOL=codex METRICS_DIR='$METRICS_DIR' bash '$HOOKS_DIR/vague-prompt.sh'"
    assert_success
    local hook_output="$output"

    run jq -r '.hookSpecificOutput.hookEventName' <<<"$hook_output"
    assert_output "UserPromptSubmit"

    run jq -r '.hookSpecificOutput.additionalContext' <<<"$hook_output"
    [[ "$output" == *"brief and may be ambiguous"* ]]

    run jq -r '.tool' "$METRICS_FILE"
    assert_output "codex"
}

@test "vague-prompt keeps Codex JSON parseable when metrics persistence fails" {
    run bash -c "printf '%s' '{\"prompt\":\"fix it\"}' | AGENT_SMITH_TOOL=codex METRICS_DIR='/dev/null/metrics' bash '$HOOKS_DIR/vague-prompt.sh'"
    assert_success
    local hook_output="$output"

    run jq -r '.hookSpecificOutput.hookEventName' <<<"$hook_output"
    assert_output "UserPromptSubmit"

    run jq -r '.hookSpecificOutput.additionalContext' <<<"$hook_output"
    [[ "$output" == *"brief and may be ambiguous"* ]]
}

@test "tool-failure detects Codex Bash failures from post-tool-use payloads" {
    printf '{"tool_name":"Bash","turn_id":"turn-codex-1","tool_use_id":"tool-use-1","tool_input":{"command":"npm test"},"tool_response":{"exit_code":1,"stderr":"boom","stdout":"failing test output"}}' | \
        env AGENT_SMITH_TOOL=codex \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-failure.sh"

    local event_types
    event_types=$(jq -r '.event_type' "$METRICS_FILE")
    [ "$event_types" = $'tool_failure\ncommand_failure' ]

    run jq -r 'select(.event_type == "tool_failure") | .tool' "$METRICS_FILE"
    assert_output "codex"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.command' "$METRICS_FILE"
    assert_output "npm test"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.exit_code' "$METRICS_FILE"
    assert_output "1"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.stderr_snippet' "$METRICS_FILE"
    assert_output "boom"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.stdout_snippet' "$METRICS_FILE"
    assert_output "failing test output"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.turn_id' "$METRICS_FILE"
    assert_output "turn-codex-1"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.tool_use_id' "$METRICS_FILE"
    assert_output "tool-use-1"
}

@test "tool-failure parses stringified Codex Bash responses for richer metadata" {
    printf '%s' '{"tool_name":"Bash","turn_id":"turn-codex-2","tool_use_id":"tool-use-2","tool_input":{"command":"pnpm test"},"tool_response":"{\"exit_code\":2,\"stderr\":\"string boom\",\"stdout\":\"string output\"}"}' | \
        env AGENT_SMITH_TOOL=codex \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-failure.sh"

    local event_types
    event_types=$(jq -r '.event_type' "$METRICS_FILE")
    [ "$event_types" = $'tool_failure\ncommand_failure' ]

    run jq -r 'select(.event_type == "tool_failure") | .metadata.exit_code' "$METRICS_FILE"
    assert_output "2"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.stderr_snippet' "$METRICS_FILE"
    assert_output "string boom"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.stdout_snippet' "$METRICS_FILE"
    assert_output "string output"
}

@test "compact hook reads COMPACT_TRIGGER env for trigger type" {
    printf '{"session_id":"hint","transcript_path":""}' | \
        env METRICS_DIR="$METRICS_DIR" \
        COMPACT_TRIGGER=manual \
        bash "$HOOKS_DIR/compact.sh"

    run jq -r '.metadata.trigger' "$METRICS_FILE"
    assert_output "manual"
}

@test "compact hook reads auto trigger type" {
    printf '{"session_id":"hint","transcript_path":""}' | \
        env METRICS_DIR="$METRICS_DIR" \
        COMPACT_TRIGGER=auto \
        bash "$HOOKS_DIR/compact.sh"

    run jq -r '.metadata.trigger' "$METRICS_FILE"
    assert_output "auto"
}

@test "compact hook defaults trigger to unknown when COMPACT_TRIGGER unset" {
    printf '{"session_id":"hint","transcript_path":""}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash -c 'unset COMPACT_TRIGGER; bash "'"$HOOKS_DIR"'/compact.sh"'

    run jq -r '.metadata.trigger' "$METRICS_FILE"
    assert_output "unknown"
}

@test "compact hook counts transcript lines from payload path" {
    local transcript="$TEST_TMPDIR/transcript.jsonl"
    for i in $(seq 1 30); do
        echo '{"type":"user"}' >> "$transcript"
    done

    printf '{"session_id":"hint","transcript_path":"%s"}' "$transcript" | \
        env METRICS_DIR="$METRICS_DIR" \
        COMPACT_TRIGGER=auto \
        bash "$HOOKS_DIR/compact.sh"

    run jq -r '.metadata.transcript_lines' "$METRICS_FILE"
    assert_output "30"
}

# ============================================================================
# Session-stop does NOT emit session_cost (moved to rollup)
# ============================================================================

@test "session-stop emits session_stop event and writes cost snapshot" {
    local transcript="$TEST_TMPDIR/transcript.jsonl"
    local expected_sid
    expected_sid=$(expected_session_id "hint")

    cat > "$transcript" <<'JSONL'
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
JSONL

    printf '{"stop_reason":"end_turn","session_id":"hint","transcript_path":"%s"}' "$transcript" | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-stop.sh"

    # Should only have session_stop in events (no session_cost event)
    local event_count
    event_count=$(wc -l <"$METRICS_FILE" | tr -d ' ')
    [ "$event_count" -eq 1 ]

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "session_stop"

    # But should have written a cost snapshot file
    [ -f "$METRICS_DIR/.cost_snapshot_${expected_sid}" ]
}

# ============================================================================
# End-to-end: session-start → rollup → cost in sessions table
# ============================================================================

@test "rollup calculates session cost from persisted transcript path" {
    local session_hint="e2e-cost-test"
    local transcript="$TEST_TMPDIR/transcript.jsonl"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    # Create a transcript with known token usage
    cat > "$transcript" <<'JSONL'
{"type":"system","message":{"role":"system","content":"prompt"}}
{"type":"assistant","message":{"role":"assistant","type":"message","model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
JSONL

    # 1. session-start: emits event and persists transcript path
    printf '{"transcript_path":"%s"}' "$transcript" | \
        env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    # Verify .transcript_paths has the right session_id
    grep -q "$expected_sid" "$METRICS_DIR/.transcript_paths"

    # 2. Run rollup to ingest events and calculate cost
    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    # 3. Verify cost data landed in the sessions table
    local cost
    cost=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT estimated_cost_usd FROM sessions WHERE session_id = '${expected_sid}';" 2>/dev/null)
    [ "$(awk "BEGIN { print ($cost > 0) }")" = "1" ]

    local model
    model=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT model FROM sessions WHERE session_id = '${expected_sid}';" 2>/dev/null)
    [ "$model" = "claude-sonnet-4-6" ]

    local turns
    turns=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT assistant_turns FROM sessions WHERE session_id = '${expected_sid}';" 2>/dev/null)
    [ "$turns" = "1" ]

    # 4. Transcript still exists, so entry is kept for future rollup runs
    [ -f "$METRICS_DIR/.transcript_paths" ]
    grep -q "$expected_sid" "$METRICS_DIR/.transcript_paths"
}

@test "rollup updates cost when transcript grows between runs" {
    local session_hint="growing-session"
    local transcript="$TEST_TMPDIR/transcript.jsonl"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    # Start with one assistant turn
    cat > "$transcript" <<'JSONL'
{"type":"assistant","message":{"role":"assistant","type":"message","model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
JSONL

    printf '{"transcript_path":"%s"}' "$transcript" | \
        env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    # First rollup
    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    local turns_1
    turns_1=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT assistant_turns FROM sessions WHERE session_id = '${expected_sid}';" 2>/dev/null)
    [ "$turns_1" = "1" ]

    # Transcript grows — second assistant turn added
    cat >> "$transcript" <<'JSONL'
{"type":"assistant","message":{"role":"assistant","type":"message","model":"claude-sonnet-4-6","content":[{"type":"text","text":"bye"}],"usage":{"input_tokens":2000,"output_tokens":1000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
JSONL

    # Second rollup picks up the new turn
    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    local turns_2
    turns_2=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT assistant_turns FROM sessions WHERE session_id = '${expected_sid}';" 2>/dev/null)
    [ "$turns_2" = "2" ]

    # Cost should be higher after second turn
    local cost_2
    cost_2=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT estimated_cost_usd FROM sessions WHERE session_id = '${expected_sid}';" 2>/dev/null)
    [ "$(awk "BEGIN { print ($cost_2 > 0) }")" = "1" ]
}

@test "rollup drops entry when transcript is deleted and no snapshot exists" {
    local session_hint="deleted-no-snapshot"
    local transcript="$TEST_TMPDIR/transcript.jsonl"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    cat > "$transcript" <<'JSONL'
{"type":"assistant","message":{"role":"assistant","type":"message","model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
JSONL

    printf '{"transcript_path":"%s"}' "$transcript" | \
        env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    # Delete transcript AND ensure no snapshot exists
    rm -f "$transcript"

    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    # Cost should be 0 — no transcript, no snapshot, data lost
    local cost
    cost=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT estimated_cost_usd FROM sessions WHERE session_id = '${expected_sid}';" 2>/dev/null)
    [ "${cost:-0}" = "0" ] || [ "${cost:-0.0}" = "0.0" ]
}

@test "rollup uses cost snapshot when transcript is deleted before rollup" {
    local session_hint="snapshot-fallback"
    local transcript="$TEST_TMPDIR/transcript.jsonl"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    # Create transcript
    cat > "$transcript" <<'JSONL'
{"type":"assistant","message":{"role":"assistant","type":"message","model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":1000,"output_tokens":500,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
JSONL

    # session-start persists transcript path
    printf '{"transcript_path":"%s"}' "$transcript" | \
        env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    # session-stop writes cost snapshot (fires per-turn)
    printf '{"stop_reason":"end_turn","session_id":"%s","transcript_path":"%s"}' \
        "$session_hint" "$transcript" | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-stop.sh"

    # Verify snapshot was written
    [ -f "$METRICS_DIR/.cost_snapshot_${expected_sid}" ]

    # Delete transcript BEFORE rollup — simulating cleanup race
    rm -f "$transcript"

    # Run rollup — should use snapshot as fallback
    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    # Cost should be non-zero despite transcript being gone
    local cost
    cost=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT estimated_cost_usd FROM sessions WHERE session_id = '${expected_sid}';" 2>/dev/null)
    [ "$(awk "BEGIN { print ($cost > 0) }")" = "1" ]

    local turns
    turns=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT assistant_turns FROM sessions WHERE session_id = '${expected_sid}';" 2>/dev/null)
    [ "$turns" = "1" ]

    # Snapshot should be cleaned up after use
    [ ! -f "$METRICS_DIR/.cost_snapshot_${expected_sid}" ]
}

@test "rollup prices mixed-model sessions per-entry, not per-session" {
    local session_hint="mixed-model-session"
    local transcript="$TEST_TMPDIR/transcript.jsonl"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    # Two turns: one Haiku (cheap), one Opus (expensive), same token counts
    cat > "$transcript" <<'JSONL'
{"type":"assistant","message":{"role":"assistant","type":"message","model":"claude-haiku-4-5","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":1000000,"output_tokens":1000000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
{"type":"assistant","message":{"role":"assistant","type":"message","model":"claude-opus-4-6","content":[{"type":"text","text":"bye"}],"usage":{"input_tokens":1000000,"output_tokens":1000000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
JSONL

    printf '{"transcript_path":"%s"}' "$transcript" | \
        env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    local cost
    cost=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT estimated_cost_usd FROM sessions WHERE session_id = '${expected_sid}';" 2>/dev/null)

    # Haiku: 1M*0.80/1M + 1M*4.00/1M = 4.80
    # Opus:  1M*15/1M + 1M*75/1M = 90.00
    # Total should be 94.80
    # If priced all at Opus (last model): would be 180.00
    # If priced all at Haiku: would be 9.60
    # So cost must be between those extremes
    [ "$(awk "BEGIN { print ($cost > 90 && $cost < 100) }")" = "1" ]
}

@test "rollup daily_rollup tracks distinct session_count separately from event count" {
    cat > "$METRICS_FILE" <<'JSONL'
{"ts":"2026-04-10T00:00:00Z","tool":"claude","session_id":"session-1","event_type":"tool_failure","metadata":{"tool_name":"Bash","error":"exit 1"}}
{"ts":"2026-04-10T00:01:00Z","tool":"claude","session_id":"session-1","event_type":"tool_failure","metadata":{"tool_name":"Bash","error":"exit 1"}}
{"ts":"2026-04-10T00:02:00Z","tool":"claude","session_id":"session-2","event_type":"tool_failure","metadata":{"tool_name":"Bash","error":"exit 1"}}
JSONL

    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    local rollup_row
    rollup_row=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT count || '|' || session_count
         FROM daily_rollup
         WHERE date = '2026-04-10'
           AND tool = 'claude'
           AND event_type = 'tool_failure';" 2>/dev/null)
    [ "$rollup_row" = "3|2" ]
}

# ============================================================================
# Rollup resilience: malformed JSONL lines must not truncate ingestion
# ============================================================================

@test "rollup skips malformed JSONL lines and ingests surrounding valid events" {
    cat > "$METRICS_FILE" <<'JSONL'
{"ts":"2026-04-10T10:00:00Z","tool":"claude","session_id":"s-good-1","event_type":"session_start","metadata":{"cwd":"/tmp"}}
THIS IS NOT JSON AT ALL
{"ts":"2026-04-10T10:01:00Z","tool":"claude","session_id":"s-good-2","event_type":"tool_failure","metadata":{"tool_name":"Bash","error":"exit 1"}}
{"truncated json
{"ts":"2026-04-10T10:02:00Z","tool":"claude","session_id":"s-good-3","event_type":"session_stop","metadata":{"stop_reason":"end_turn","duration_seconds":60}}
JSONL

    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    # All 3 valid events should be ingested; the 2 malformed lines skipped
    local event_count
    event_count=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT COUNT(*) FROM events;" 2>/dev/null)
    [ "$event_count" = "3" ]
}

@test "rollup ingests events after a line with embedded control characters" {
    # Simulate a payload where json_escape missed a control char (pre-fix data)
    printf '{"ts":"2026-04-10T11:00:00Z","tool":"claude","session_id":"s-pre","event_type":"session_start","metadata":{"cwd":"/tmp"}}\n' > "$METRICS_FILE"
    printf '{"ts":"2026-04-10T11:01:00Z","tool":"claude","session_id":"s-bad","event_type":"tool_failure","metadata":{"error":"has \x07 bell"}}\n' >> "$METRICS_FILE"
    printf '{"ts":"2026-04-10T11:02:00Z","tool":"claude","session_id":"s-post","event_type":"session_stop","metadata":{"stop_reason":"end_turn","duration_seconds":30}}\n' >> "$METRICS_FILE"

    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    # The event before and after the bad line must be ingested
    local count_good
    count_good=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT COUNT(*) FROM events WHERE session_id IN ('s-pre', 's-post');" 2>/dev/null)
    [ "$count_good" = "2" ]
}

@test "rollup preserves events appended after claim for the next run" {
    cat > "$METRICS_FILE" <<'JSONL'
{"ts":"2026-04-10T12:00:00Z","tool":"claude","session_id":"s-first","event_type":"session_start","metadata":{"cwd":"/tmp"}}
JSONL

    env METRICS_DIR="$METRICS_DIR" \
        AGENT_SMITH_ROLLUP_AFTER_CLAIM_DELAY=0.2 \
        bash "$PROJECT_ROOT/scripts/metrics-rollup.sh" >/dev/null 2>&1 &
    local rollup_pid=$!

    local claimed_batch=""
    for _ in $(seq 1 50); do
        claimed_batch=$(find "$METRICS_DIR" -maxdepth 1 -type f -name 'events.jsonl.processing.*' -print -quit)
        if [ -n "$claimed_batch" ]; then
            break
        fi
        sleep 0.01
    done
    [ -n "$claimed_batch" ]

    printf '%s\n' '{"ts":"2026-04-10T12:00:01Z","tool":"claude","session_id":"s-second","event_type":"session_stop","metadata":{"stop_reason":"end_turn","duration_seconds":3}}' >> "$METRICS_FILE"

    wait "$rollup_pid"

    local first_pass_count
    first_pass_count=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT COUNT(*) FROM events;" 2>/dev/null)
    [ "$first_pass_count" = "1" ]

    local queued_session
    queued_session=$(jq -r '.session_id' "$METRICS_FILE")
    [ "$queued_session" = "s-second" ]

    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    local second_pass_count
    second_pass_count=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT COUNT(*) FROM events;" 2>/dev/null)
    [ "$second_pass_count" = "2" ]

    local distinct_sessions
    distinct_sessions=$(sqlite3 "$METRICS_DIR/rollup.db" \
        "SELECT COUNT(DISTINCT session_id) FROM events WHERE session_id IN ('s-first', 's-second');" 2>/dev/null)
    [ "$distinct_sessions" = "2" ]
}

@test "tool_failure with control chars in error produces valid JSONL after fix" {
    source "${HOOKS_DIR}/lib/metrics.sh"

    # Error message with backspace, form-feed, bell, and ESC
    local nasty_error=$'compile error\x08\x0c\x07\x1b in module'
    metrics_on_tool_failure "Bash" "$nasty_error" "make build"

    # Every line in events.jsonl must be valid JSON
    local bad_lines
    bad_lines=$(jq -e . "$METRICS_FILE" 2>&1 >/dev/null | wc -l | tr -d ' ')
    [ "$bad_lines" = "0" ]
}

# ============================================================================
# StopFailure hook
# ============================================================================

@test "stop-failure emits stop_failure event with error_type" {
    local session_hint="test-stop-failure-abc"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    # Prime session state so restore_metrics_session_id can find it
    echo '{}' | env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp/project" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    : > "$METRICS_FILE"
    printf '{"error_type":"rate_limit","session_id":"%s"}' "$session_hint" | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/stop-failure.sh"

    [ -f "$METRICS_FILE" ]
    local line
    line=$(cat "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.event_type')" = "stop_failure" ]
    [ "$(echo "$line" | jq -r '.metadata.error_type')" = "rate_limit" ]
    [ "$(echo "$line" | jq -r '.session_id')" = "$expected_sid" ]
}

@test "stop-failure injects context for rate_limit" {
    local output
    output=$(printf '{"error_type":"rate_limit","session_id":"hint"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/stop-failure.sh")
    [[ "$output" == *"Rate limited"* ]]
}

@test "stop-failure injects context for max_output_tokens" {
    local output
    output=$(printf '{"error_type":"max_output_tokens","session_id":"hint"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/stop-failure.sh")
    [[ "$output" == *"Output truncated"* ]]
}

@test "stop-failure does not inject context for server_error" {
    local output
    output=$(printf '{"error_type":"server_error","session_id":"hint"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/stop-failure.sh")
    [ -z "$output" ]
}

@test "stop-failure exits 0 on empty input" {
    echo '{}' | env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/stop-failure.sh"
    [ $? -eq 0 ]
}

# ============================================================================
# PreToolUse (tool-attempt) hook
# ============================================================================

@test "tool-attempt emits tool_attempt for Bash tool" {
    local session_hint="test-tool-attempt-abc"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    echo '{}' | env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp/project" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    : > "$METRICS_FILE"
    printf '{"tool_name":"Bash","tool_input":{"command":"git status"},"session_id":"%s","tool_use_id":"tu-1","turn_id":"t-1"}' "$session_hint" | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-attempt.sh"

    [ -f "$METRICS_FILE" ]
    local line
    line=$(cat "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.event_type')" = "tool_attempt" ]
    [ "$(echo "$line" | jq -r '.metadata.tool_name')" = "Bash" ]
    [ "$(echo "$line" | jq -r '.metadata.command')" = "git status" ]
    [ "$(echo "$line" | jq -r '.session_id')" = "$expected_sid" ]
}

@test "tool-attempt emits tool_attempt for Edit tool with file_path" {
    : > "$METRICS_FILE"
    printf '{"tool_name":"Edit","tool_input":{"file_path":"src/main.ts"},"session_id":"hint","tool_use_id":"tu-2"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-attempt.sh"

    local line
    line=$(cat "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.tool_name')" = "Edit" ]
    [ "$(echo "$line" | jq -r '.metadata.file_path')" = "src/main.ts" ]
}

@test "tool-attempt silently exits for Read tool" {
    : > "$METRICS_FILE"
    printf '{"tool_name":"Read","tool_input":{},"session_id":"hint"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-attempt.sh"

    # Should not emit any event
    [ ! -s "$METRICS_FILE" ]
}

@test "tool-attempt silently exits for Grep tool" {
    : > "$METRICS_FILE"
    printf '{"tool_name":"Grep","tool_input":{},"session_id":"hint"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-attempt.sh"

    [ ! -s "$METRICS_FILE" ]
}

@test "tool-attempt emits for Agent tool" {
    : > "$METRICS_FILE"
    printf '{"tool_name":"Agent","tool_input":{},"session_id":"hint","tool_use_id":"tu-3"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-attempt.sh"

    local line
    line=$(cat "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.tool_name')" = "Agent" ]
}

@test "tool-attempt exits 0 on empty input" {
    echo '{}' | env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/tool-attempt.sh"
    [ $? -eq 0 ]
}

# ============================================================================
# SubagentStart / SubagentStop hooks
# ============================================================================

@test "subagent-start emits subagent_start event" {
    local session_hint="test-subagent-abc"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    echo '{}' | env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp/project" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    : > "$METRICS_FILE"
    printf '{"agent_id":"ag-1","agent_type":"Explore","session_id":"%s","turn_id":"t-1","tool_use_id":"tu-1"}' "$session_hint" | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/subagent-start.sh"

    [ -f "$METRICS_FILE" ]
    local line
    line=$(cat "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.event_type')" = "subagent_start" ]
    [ "$(echo "$line" | jq -r '.metadata.agent_id')" = "ag-1" ]
    [ "$(echo "$line" | jq -r '.metadata.agent_type')" = "Explore" ]
    [ "$(echo "$line" | jq -r '.session_id')" = "$expected_sid" ]
}

@test "subagent-stop emits subagent_stop event with duration" {
    local session_hint="test-subagent-stop-abc"

    echo '{}' | env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp/project" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    # Simulate subagent start (write a timestamp 5 seconds ago)
    local fake_ts
    fake_ts=$(($(date +%s) - 5))
    printf '%s' "$fake_ts" > "${METRICS_DIR}/.subagent_start_ts_ag-2"

    : > "$METRICS_FILE"
    printf '{"agent_id":"ag-2","agent_type":"Plan","session_id":"%s"}' "$session_hint" | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/subagent-stop.sh"

    [ -f "$METRICS_FILE" ]
    local line duration
    line=$(cat "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.event_type')" = "subagent_stop" ]
    [ "$(echo "$line" | jq -r '.metadata.agent_id')" = "ag-2" ]
    duration=$(echo "$line" | jq -r '.metadata.duration_seconds')
    # Duration should be >= 4 (we wrote timestamp 5 seconds ago, allowing 1s jitter)
    [ "$duration" -ge 4 ]
}

@test "subagent-stop cleans up timestamp file" {
    printf '%s' "$(date +%s)" > "${METRICS_DIR}/.subagent_start_ts_ag-cleanup"

    printf '{"agent_id":"ag-cleanup","agent_type":"Explore","session_id":"hint"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/subagent-stop.sh"

    [ ! -f "${METRICS_DIR}/.subagent_start_ts_ag-cleanup" ]
}

@test "subagent-stop handles missing timestamp file gracefully" {
    : > "$METRICS_FILE"
    printf '{"agent_id":"ag-nostart","agent_type":"Explore","session_id":"hint"}' | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/subagent-stop.sh"

    # Should still emit with duration 0
    local line
    line=$(cat "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.duration_seconds')" = "0" ]
}

@test "subagent-start exits 0 on empty input" {
    echo '{}' | env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/subagent-start.sh"
    [ $? -eq 0 ]
}

@test "subagent-stop exits 0 on empty input" {
    echo '{}' | env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/subagent-stop.sh"
    [ $? -eq 0 ]
}
