#!/usr/bin/env bats
# Tests for hooks/lib/metrics.sh metrics emission library

setup() {
    load '../setup_suite'

    # Use a temp directory for metrics to avoid polluting real data
    export METRICS_DIR="$(mktemp -d)"
    export METRICS_FILE="${METRICS_DIR}/events.jsonl"
    export METRICS_SESSION_ID="test-session-001"
    export AGENT_METRICS_ENABLED=1

    source "${HOOKS_DIR}/lib/metrics.sh"
}

teardown() {
    rm -rf "$METRICS_DIR"
}

# ============================================================================
# json_escape
# ============================================================================

@test "json_escape handles plain strings" {
    run json_escape "hello world"
    assert_success
    assert_output "hello world"
}

@test "json_escape escapes double quotes" {
    run json_escape 'say "hello"'
    assert_success
    assert_output 'say \"hello\"'
}

@test "json_escape escapes backslashes" {
    run json_escape 'path\to\file'
    assert_success
    assert_output 'path\\to\\file'
}

@test "json_escape escapes newlines" {
    run json_escape $'line1\nline2'
    assert_success
    assert_output 'line1\nline2'
}

@test "json_escape escapes tabs" {
    run json_escape $'col1\tcol2'
    assert_success
    assert_output 'col1\tcol2'
}

# ============================================================================
# truncate_str
# ============================================================================

@test "truncate_str returns short strings unchanged" {
    run truncate_str "short" 500
    assert_success
    assert_output "short"
}

@test "truncate_str truncates long strings" {
    local long_str
    long_str=$(printf 'x%.0s' {1..600})
    run truncate_str "$long_str" 10
    assert_success
    assert_output "xxxxxxxxxx..."
}

@test "truncate_str defaults to 500 chars" {
    local long_str
    long_str=$(printf 'y%.0s' {1..600})
    run truncate_str "$long_str"
    assert_success
    # Should be 500 chars + "..."
    [ "${#output}" -eq 503 ]
}

# ============================================================================
# derive_session_id
# ============================================================================

@test "derive_session_id produces consistent hash from path" {
    run derive_session_id "/tmp/transcript-abc.jsonl"
    assert_success
    local first_output="$output"

    run derive_session_id "/tmp/transcript-abc.jsonl"
    assert_success
    assert_output "$first_output"
}

@test "derive_session_id produces different hashes for different paths" {
    run derive_session_id "/tmp/a.jsonl"
    local hash_a="$output"

    run derive_session_id "/tmp/b.jsonl"
    local hash_b="$output"

    [ "$hash_a" != "$hash_b" ]
}

@test "derive_session_id falls back to date-PID without path" {
    run derive_session_id ""
    assert_success
    # Should match pattern: YYYYMMDDHHMMSS-PID
    [[ "$output" =~ ^[0-9]{14}-[0-9]+$ ]]
}

# ============================================================================
# emit_metric (low-level)
# ============================================================================

@test "emit_metric creates metrics directory" {
    rm -rf "$METRICS_DIR"
    emit_metric "claude" "test_event" '{"key":"value"}'
    [ -d "$METRICS_DIR" ]
}

@test "emit_metric writes valid JSONL" {
    emit_metric "claude" "test_event" '{"key":"value"}'
    [ -f "$METRICS_FILE" ]

    run jq -e . "$METRICS_FILE"
    assert_success
}

@test "emit_metric includes all required fields" {
    emit_metric "claude" "session_start" '{"cwd":"/tmp"}'

    run jq -r '.tool' "$METRICS_FILE"
    assert_output "claude"

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "session_start"

    run jq -r '.session_id' "$METRICS_FILE"
    assert_output "test-session-001"

    run jq -r '.ts' "$METRICS_FILE"
    assert_success
    [[ "$output" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]]
}

@test "emit_metric preserves metadata JSON" {
    emit_metric "claude" "tool_failure" '{"tool_name":"Bash","error":"exit 1"}'

    run jq -r '.metadata.tool_name' "$METRICS_FILE"
    assert_output "Bash"

    run jq -r '.metadata.error' "$METRICS_FILE"
    assert_output "exit 1"
}

@test "emit_metric appends multiple events" {
    emit_metric "claude" "session_start" '{"cwd":"/tmp"}'
    emit_metric "claude" "tool_failure" '{"tool_name":"Edit"}'
    emit_metric "claude" "session_stop" '{"stop_reason":"end_turn"}'

    line_count=$(wc -l < "$METRICS_FILE" | tr -d ' ')
    [ "$line_count" -eq 3 ]
}

@test "emit_metric handles different tools" {
    emit_metric "claude" "session_start" '{"cwd":"/tmp"}'
    emit_metric "opencode" "session_start" '{"cwd":"/tmp"}'
    emit_metric "codex" "session_stop" '{"stop_reason":"complete"}'

    run jq -r '.tool' "$METRICS_FILE"
    assert_success
    echo "$output" | grep -q "claude"
    echo "$output" | grep -q "opencode"
    echo "$output" | grep -q "codex"
}

@test "emit_metric never fails even with bad directory" {
    export METRICS_DIR="/nonexistent/readonly/path"
    export METRICS_FILE="${METRICS_DIR}/events.jsonl"
    emit_metric "claude" "test" '{"key":"value"}'
}

# ============================================================================
# Kill switch: AGENT_METRICS_ENABLED=0
# ============================================================================

@test "emit_metric is a no-op when AGENT_METRICS_ENABLED=0" {
    export AGENT_METRICS_ENABLED=0
    emit_metric "claude" "test_event" '{"key":"value"}'
    [ ! -f "$METRICS_FILE" ]
}

@test "metrics_on_session_start is a no-op when disabled" {
    export AGENT_METRICS_ENABLED=0
    metrics_on_session_start "/tmp" "nodejs" ""
    [ ! -f "$METRICS_FILE" ]
}

@test "metrics_on_session_stop is a no-op when disabled" {
    export AGENT_METRICS_ENABLED=0
    metrics_on_session_stop "end_turn"
    [ ! -f "$METRICS_FILE" ]
}

@test "metrics_on_test_result is a no-op when disabled" {
    export AGENT_METRICS_ENABLED=0
    metrics_on_test_result 0 "npm test" "src/foo.ts"
    [ ! -f "$METRICS_FILE" ]
}

# ============================================================================
# Hook-level wrappers
# ============================================================================

@test "metrics_on_session_start emits session_start with cwd and project_type" {
    metrics_on_session_start "/home/user/project" "nodejs" "transcript-123"

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "session_start"

    run jq -r '.metadata.cwd' "$METRICS_FILE"
    assert_output "/home/user/project"

    run jq -r '.metadata.project_type' "$METRICS_FILE"
    assert_output "nodejs"
}

@test "metrics_on_session_start writes start timestamp file" {
    metrics_on_session_start "/tmp" "python" ""
    [ -f "${METRICS_DIR}/.session_start_ts" ]
    local ts
    ts=$(cat "${METRICS_DIR}/.session_start_ts")
    [[ "$ts" =~ ^[0-9]+$ ]]
}

@test "metrics_on_session_stop emits session_stop with duration" {
    # Simulate a prior session start
    printf '%s' "$(( $(date +%s) - 60 ))" > "${METRICS_DIR}/.session_start_ts"

    metrics_on_session_stop "end_turn"

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "session_stop"

    run jq -r '.metadata.stop_reason' "$METRICS_FILE"
    assert_output "end_turn"

    # Duration should be >= 59 seconds (allowing for timing)
    local dur
    dur=$(jq -r '.metadata.duration_seconds' "$METRICS_FILE")
    [ "$dur" -ge 59 ]
}

@test "metrics_on_session_stop cleans up timestamp file" {
    printf '%s' "$(date +%s)" > "${METRICS_DIR}/.session_start_ts"
    metrics_on_session_stop "end_turn"
    [ ! -f "${METRICS_DIR}/.session_start_ts" ]
}

@test "metrics_on_clarifying_question emits truncated prompt" {
    metrics_on_clarifying_question "fix it"

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "clarifying_question"

    run jq -r '.metadata.prompt_snippet' "$METRICS_FILE"
    assert_output "fix it"

    run jq -r '.metadata.is_vague' "$METRICS_FILE"
    assert_output "true"
}

@test "metrics_on_test_result resets counter on pass" {
    printf '2' > "${METRICS_DIR}/.test_fail_count"
    metrics_on_test_result 1 "npm test" "src/foo.ts"
    [ ! -f "${METRICS_DIR}/.test_fail_count" ]
    # No event emitted for a pass
    [ ! -f "$METRICS_FILE" ]
}

@test "metrics_on_test_result increments counter on failure" {
    metrics_on_test_result 0 "npm test" "src/foo.ts"
    local count
    count=$(cat "${METRICS_DIR}/.test_fail_count")
    [ "$count" = "1" ]
    # No event at count < 3
    [ ! -f "$METRICS_FILE" ]
}

@test "metrics_on_test_result emits test_failure_loop at 3 failures" {
    printf '2' > "${METRICS_DIR}/.test_fail_count"
    metrics_on_test_result 0 "npm test" "src/foo.ts"

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "test_failure_loop"

    run jq -r '.metadata.failure_count' "$METRICS_FILE"
    assert_output "3"
}

@test "metrics_on_tool_failure emits tool_failure" {
    metrics_on_tool_failure "Edit" "file not found"

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "tool_failure"

    run jq -r '.metadata.tool_name' "$METRICS_FILE"
    assert_output "Edit"
}

@test "metrics_on_tool_failure emits command_failure for Bash" {
    metrics_on_tool_failure "Bash" "exit 1" "rm -rf /oops"

    # Should have 2 events: tool_failure + command_failure
    line_count=$(wc -l < "$METRICS_FILE" | tr -d ' ')
    [ "$line_count" -eq 2 ]

    run jq -s '.[1].event_type' "$METRICS_FILE"
    assert_output '"command_failure"'
}

@test "metrics_on_permission_denied emits permission_denied" {
    metrics_on_permission_denied "Write"

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "permission_denied"

    run jq -r '.metadata.tool_name' "$METRICS_FILE"
    assert_output "Write"
}
