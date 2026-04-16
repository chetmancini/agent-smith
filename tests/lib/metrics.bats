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

@test "json_escape escapes backspace and form-feed" {
    run json_escape $'before\x08after\x0cend'
    assert_success
    assert_output 'before\bafter\fend'
}

@test "json_escape strips other control characters" {
    # BEL (0x07), VT (0x0B), ESC (0x1B), DEL (0x7F)
    run json_escape $'a\x07b\x0bc\x1bd\x7fe'
    assert_success
    assert_output 'abcde'
}

@test "json_escape produces valid JSON with all control chars" {
    # String containing every problematic control character
    local nasty=$'quo\"te back\\slash\nnew\rret\ttab\x08bs\x0cff\x07bel\x1besc\x01soh'
    local escaped
    escaped=$(json_escape "$nasty")
    # Wrap in a JSON object and verify jq can parse it
    run jq -e '.v' <<< "{\"v\":\"${escaped}\"}"
    assert_success
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

@test "truncate_str removes dangling backslash from split escape sequence" {
    # Simulate json_escape'd output: 9 chars + \" = 11 chars, truncate at 10
    # cuts between \ and " leaving a dangling backslash
    local escaped='abcdefghi\"rest'  # \ at position 10, " at 11
    run truncate_str "$escaped" 10
    assert_success
    # Should strip the trailing \ and append ...
    assert_output 'abcdefghi...'
}

@test "truncate_str preserves valid trailing escaped backslash" {
    # Ends with \\\\ (two escaped backslashes = 4 chars), even count is fine
    local escaped='abcdef\\\\'
    run truncate_str "$escaped" 10
    assert_success
    assert_output 'abcdef\\\\'
}

@test "truncate_str produces valid JSON when cutting escaped content" {
    # Build a string with many escaped quotes: \"\"\"...
    local escaped=""
    for i in $(seq 1 100); do
        escaped="${escaped}\\\""
    done
    local truncated
    truncated=$(truncate_str "$escaped" 51)
    # Verify it's valid inside a JSON string
    run jq -e '.v' <<< "{\"v\":\"${truncated}\"}"
    assert_success
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

@test "metrics_on_session_start writes session-scoped timestamp file" {
    metrics_on_session_start "/tmp" "python" ""
    # Session ID is derived from empty hint, uses date-PID fallback
    # Use the exported METRICS_SESSION_ID to find the file
    [ -f "${METRICS_DIR}/.session_start_ts_${METRICS_SESSION_ID}" ]
    local ts
    ts=$(cat "${METRICS_DIR}/.session_start_ts_${METRICS_SESSION_ID}")
    [[ "$ts" =~ ^[0-9]+$ ]]
}

@test "metrics_on_session_start includes transcript_hash in metadata" {
    metrics_on_session_start "/tmp" "python" "hint" "/some/transcript.jsonl"

    run jq -r '.metadata.transcript_hash' "$METRICS_FILE"
    assert_success
    # Should be a 12-char hex hash
    [[ "$output" =~ ^[0-9a-f]{12}$ ]]
}

@test "metrics_on_session_stop emits session_stop with duration" {
    # Simulate a prior session start with known session ID
    printf '%s' "$(( $(date +%s) - 60 ))" > "${METRICS_DIR}/.session_start_ts_${METRICS_SESSION_ID}"

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

@test "metrics_on_session_stop preserves timestamp file for subsequent turns" {
    printf '%s' "$(date +%s)" > "${METRICS_DIR}/.session_start_ts_${METRICS_SESSION_ID}"
    metrics_on_session_stop "end_turn"
    # Stop fires per-turn; timestamp must survive for correct duration on later turns
    [ -f "${METRICS_DIR}/.session_start_ts_${METRICS_SESSION_ID}" ]
}

@test "metrics_on_session_stop emits correct duration on second call" {
    printf '%s' "$(( $(date +%s) - 120 ))" > "${METRICS_DIR}/.session_start_ts_${METRICS_SESSION_ID}"

    # First turn
    metrics_on_session_stop "end_turn"
    # Second turn — should still have a valid duration, not 0
    : > "$METRICS_FILE"
    metrics_on_session_stop "end_turn"

    local dur
    dur=$(jq -r '.metadata.duration_seconds' "$METRICS_FILE")
    [ "$dur" -ge 119 ]
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
    printf '2' > "$(metrics_test_fail_counter_file)"
    metrics_on_test_result 1 "npm test" "src/foo.ts"
    [ ! -f "$(metrics_test_fail_counter_file)" ]
    # No event emitted for a pass
    [ ! -f "$METRICS_FILE" ]
}

@test "metrics_on_test_result increments counter on failure" {
    metrics_on_test_result 0 "npm test" "src/foo.ts"
    local count
    count=$(cat "$(metrics_test_fail_counter_file)")
    [ "$count" = "1" ]
    # No event at count < 3
    [ ! -f "$METRICS_FILE" ]
}

@test "metrics_on_test_result emits test_failure_loop at 3 failures" {
    printf '2' > "$(metrics_test_fail_counter_file)"
    metrics_on_test_result 0 "npm test" "src/foo.ts"

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "test_failure_loop"

    run jq -r '.metadata.failure_count' "$METRICS_FILE"
    assert_output "3"
}

@test "metrics_on_test_result keeps failure counters isolated by session" {
    export METRICS_SESSION_ID="session-a"
    metrics_on_test_result 0 "npm test" "src/a.ts"
    metrics_on_test_result 0 "npm test" "src/a.ts"

    export METRICS_SESSION_ID="session-b"
    metrics_on_test_result 0 "npm test" "src/b.ts"

    [ -f "${METRICS_DIR}/.test_fail_count_session-a" ]
    [ -f "${METRICS_DIR}/.test_fail_count_session-b" ]
    [ "$(cat "${METRICS_DIR}/.test_fail_count_session-a")" = "2" ]
    [ "$(cat "${METRICS_DIR}/.test_fail_count_session-b")" = "1" ]
    [ ! -f "$METRICS_FILE" ]
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

@test "metrics_on_tool_failure preserves rich Bash failure metadata" {
    metrics_on_tool_failure "Bash" "permission denied" "npm test" "23" "permission denied" "partial output" "" "turn-123" "tool-456"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.command' "$METRICS_FILE"
    assert_output "npm test"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.exit_code' "$METRICS_FILE"
    assert_output "23"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.stderr_snippet' "$METRICS_FILE"
    assert_output "permission denied"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.stdout_snippet' "$METRICS_FILE"
    assert_output "partial output"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.turn_id' "$METRICS_FILE"
    assert_output "turn-123"

    run jq -r 'select(.event_type == "tool_failure") | .metadata.tool_use_id' "$METRICS_FILE"
    assert_output "tool-456"
}

@test "metrics_on_permission_denied emits permission_denied" {
    metrics_on_permission_denied "Write"

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "permission_denied"

    run jq -r '.metadata.tool_name' "$METRICS_FILE"
    assert_output "Write"
}

# ============================================================================
# _estimate_cost
# ============================================================================

@test "_estimate_cost calculates opus cost correctly" {
    run _estimate_cost 1000000 1000000 1000000 1000000 "claude-opus-4-6"
    assert_success
    # input: 1M * 15/1M = 15.00
    # output: 1M * 75/1M = 75.00
    # cache_read: 1M * 1.50/1M = 1.50
    # cache_create: 1M * 18.75/1M = 18.75
    # total = 110.25
    assert_output "110.250000"
}

@test "_estimate_cost calculates sonnet cost correctly" {
    run _estimate_cost 1000000 1000000 0 0 "claude-sonnet-4-6"
    assert_success
    # input: 1M * 3/1M = 3.00, output: 1M * 15/1M = 15.00
    assert_output "18.000000"
}

@test "_estimate_cost calculates haiku cost correctly" {
    run _estimate_cost 100000 100000 0 0 "claude-haiku-4-5"
    assert_success
    # input: 100k * 0.80/1M = 0.08, output: 100k * 4.00/1M = 0.40
    assert_output "0.480000"
}

@test "_estimate_cost returns zero for unknown model" {
    run _estimate_cost 1000 1000 0 0 "unknown-model"
    assert_success
    assert_output "0.000000"
}

@test "_estimate_cost handles zero tokens" {
    run _estimate_cost 0 0 0 0 "claude-opus-4-6"
    assert_success
    assert_output "0.000000"
}

# ============================================================================
# snapshot_session_cost
# ============================================================================

_create_mock_transcript() {
    local transcript_file="$1"
    # Two assistant turns with known token usage
    cat > "$transcript_file" <<'JSONL'
{"type":"system","message":{"role":"system","content":"system prompt"}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}
{"type":"assistant","message":{"role":"assistant","type":"message","model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500},"stop_reason":"end_turn"}}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"thanks"}]}}
{"type":"assistant","message":{"role":"assistant","type":"message","model":"claude-sonnet-4-6","content":[{"type":"text","text":"bye"}],"usage":{"input_tokens":200,"output_tokens":100,"cache_read_input_tokens":2000,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
JSONL
}

@test "snapshot_session_cost writes snapshot file" {
    local transcript="${METRICS_DIR}/transcript.jsonl"
    _create_mock_transcript "$transcript"

    snapshot_session_cost "$transcript"

    [ -f "${METRICS_DIR}/.cost_snapshot_${METRICS_SESSION_ID}" ]
}

@test "snapshot_session_cost aggregates tokens correctly" {
    local transcript="${METRICS_DIR}/transcript.jsonl"
    _create_mock_transcript "$transcript"

    snapshot_session_cost "$transcript"

    local snapshot="${METRICS_DIR}/.cost_snapshot_${METRICS_SESSION_ID}"
    IFS=$'\t' read -r in out cr cc model turns cost < "$snapshot"
    [ "$in" = "300" ]
    [ "$out" = "150" ]
    [ "$cr" = "3000" ]
    [ "$cc" = "500" ]
}

@test "snapshot_session_cost records model and turn count" {
    local transcript="${METRICS_DIR}/transcript.jsonl"
    _create_mock_transcript "$transcript"

    snapshot_session_cost "$transcript"

    local snapshot="${METRICS_DIR}/.cost_snapshot_${METRICS_SESSION_ID}"
    IFS=$'\t' read -r in out cr cc model turns cost < "$snapshot"
    [ "$model" = "claude-sonnet-4-6" ]
    [ "$turns" = "2" ]
}

@test "snapshot_session_cost estimates cost > 0" {
    local transcript="${METRICS_DIR}/transcript.jsonl"
    _create_mock_transcript "$transcript"

    snapshot_session_cost "$transcript"

    local snapshot="${METRICS_DIR}/.cost_snapshot_${METRICS_SESSION_ID}"
    IFS=$'\t' read -r in out cr cc model turns cost < "$snapshot"
    [ "$(awk "BEGIN { print ($cost > 0) }")" = "1" ]
}

@test "snapshot_session_cost is a no-op when disabled" {
    export AGENT_METRICS_ENABLED=0
    snapshot_session_cost "/nonexistent/transcript.jsonl"
    [ ! -f "${METRICS_DIR}/.cost_snapshot_${METRICS_SESSION_ID}" ]
}

@test "snapshot_session_cost is a no-op when transcript missing" {
    snapshot_session_cost ""
    [ ! -f "${METRICS_DIR}/.cost_snapshot_${METRICS_SESSION_ID}" ]
}

@test "snapshot_session_cost skips transcript with no assistant entries" {
    local transcript="${METRICS_DIR}/transcript.jsonl"
    echo '{"type":"system","message":{"role":"system","content":"hi"}}' > "$transcript"

    snapshot_session_cost "$transcript"

    [ ! -f "${METRICS_DIR}/.cost_snapshot_${METRICS_SESSION_ID}" ]
}

# ============================================================================
# metrics_on_context_compression
# ============================================================================

@test "metrics_on_context_compression emits context_compression event" {
    local transcript="${METRICS_DIR}/transcript.jsonl"
    # Create a transcript with some lines
    for i in $(seq 1 50); do
        echo '{"type":"user","message":"msg"}' >> "$transcript"
    done

    metrics_on_context_compression "auto" "$transcript"

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "context_compression"
}

@test "metrics_on_context_compression records trigger type" {
    local transcript="${METRICS_DIR}/transcript.jsonl"
    echo '{"type":"user"}' > "$transcript"

    metrics_on_context_compression "manual" "$transcript"

    run jq -r '.metadata.trigger' "$METRICS_FILE"
    assert_output "manual"
}

@test "metrics_on_context_compression records transcript line count" {
    local transcript="${METRICS_DIR}/transcript.jsonl"
    for i in $(seq 1 25); do
        echo '{"type":"user"}' >> "$transcript"
    done

    metrics_on_context_compression "auto" "$transcript"

    run jq -r '.metadata.transcript_lines' "$METRICS_FILE"
    assert_output "25"
}

@test "metrics_on_context_compression is a no-op when disabled" {
    export AGENT_METRICS_ENABLED=0
    metrics_on_context_compression "auto" "/tmp/fake.jsonl"
    [ ! -f "$METRICS_FILE" ]
}

@test "metrics_on_context_compression handles missing transcript" {
    metrics_on_context_compression "auto" ""

    # Should still emit, just with 0 lines
    run jq -r '.metadata.transcript_lines' "$METRICS_FILE"
    assert_output "0"
}

# ============================================================================
# Session ID consistency across hooks
# ============================================================================

@test "snapshot_session_cost uses METRICS_SESSION_ID for file naming" {
    local hint="test-transcript-path"
    METRICS_SESSION_ID=$(derive_session_id "$hint")
    export METRICS_SESSION_ID

    local transcript="${METRICS_DIR}/transcript.jsonl"
    _create_mock_transcript "$transcript"
    snapshot_session_cost "$transcript"

    # Snapshot file should be named with the session ID
    [ -f "${METRICS_DIR}/.cost_snapshot_${METRICS_SESSION_ID}" ]
}

@test "context_compression uses same session_id as session_start when derived from same hint" {
    local hint="test-transcript-path"
    local expected_id
    expected_id=$(derive_session_id "$hint")

    METRICS_SESSION_ID=$(derive_session_id "$hint")
    export METRICS_SESSION_ID
    metrics_on_session_start "/tmp" "test" "$hint"

    local start_sid
    start_sid=$(jq -r '.session_id' "$METRICS_FILE")

    : > "$METRICS_FILE"

    METRICS_SESSION_ID=$(derive_session_id "$hint")
    export METRICS_SESSION_ID

    local transcript="${METRICS_DIR}/transcript.jsonl"
    echo '{"type":"user"}' > "$transcript"
    metrics_on_context_compression "auto" "$transcript"

    local comp_sid
    comp_sid=$(jq -r '.session_id' "$METRICS_FILE")

    [ "$start_sid" = "$comp_sid" ]
    [ "$start_sid" = "$expected_id" ]
}

# ============================================================================
# metrics_on_stop_failure
# ============================================================================

@test "metrics_on_stop_failure emits stop_failure event with error_type" {
    export METRICS_SESSION_ID="sf-test-session"
    metrics_on_stop_failure "rate_limit" "" ""
    [ -f "$METRICS_FILE" ]
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.event_type')" = "stop_failure" ]
    [ "$(echo "$line" | jq -r '.metadata.error_type')" = "rate_limit" ]
}

@test "metrics_on_stop_failure includes turn_id and tool_use_id when present" {
    export METRICS_SESSION_ID="sf-test-session"
    metrics_on_stop_failure "server_error" "turn-123" "tooluse-456"
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.turn_id')" = "turn-123" ]
    [ "$(echo "$line" | jq -r '.metadata.tool_use_id')" = "tooluse-456" ]
}

@test "metrics_on_stop_failure omits turn_id and tool_use_id when empty" {
    export METRICS_SESSION_ID="sf-test-session"
    metrics_on_stop_failure "billing_error" "" ""
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.turn_id // "absent"')" = "absent" ]
    [ "$(echo "$line" | jq -r '.metadata.tool_use_id // "absent"')" = "absent" ]
}

@test "metrics_on_stop_failure respects kill switch" {
    export METRICS_SESSION_ID="sf-test-session"
    AGENT_METRICS_ENABLED=0 metrics_on_stop_failure "rate_limit" "" ""
    [ ! -s "$METRICS_FILE" ]
}

# ============================================================================
# metrics_on_tool_attempt
# ============================================================================

@test "metrics_on_tool_attempt emits tool_attempt event with tool_name" {
    export METRICS_SESSION_ID="ta-test-session"
    metrics_on_tool_attempt "Bash" "" "" "" ""
    [ -f "$METRICS_FILE" ]
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.event_type')" = "tool_attempt" ]
    [ "$(echo "$line" | jq -r '.metadata.tool_name')" = "Bash" ]
}

@test "metrics_on_tool_attempt includes command for Bash" {
    export METRICS_SESSION_ID="ta-test-session"
    metrics_on_tool_attempt "Bash" "tooluse-1" "turn-1" "git status" ""
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.command')" = "git status" ]
    [ "$(echo "$line" | jq -r '.metadata.tool_use_id')" = "tooluse-1" ]
}

@test "metrics_on_tool_attempt includes file_path for Edit" {
    export METRICS_SESSION_ID="ta-test-session"
    metrics_on_tool_attempt "Edit" "tooluse-2" "turn-2" "" "src/main.ts"
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.file_path')" = "src/main.ts" ]
    [ "$(echo "$line" | jq -r '.metadata.command // "absent"')" = "absent" ]
}

@test "metrics_on_tool_attempt omits optional fields when empty" {
    export METRICS_SESSION_ID="ta-test-session"
    metrics_on_tool_attempt "Agent" "" "" "" ""
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.tool_name')" = "Agent" ]
    [ "$(echo "$line" | jq -r '.metadata.command // "absent"')" = "absent" ]
    [ "$(echo "$line" | jq -r '.metadata.file_path // "absent"')" = "absent" ]
    [ "$(echo "$line" | jq -r '.metadata.tool_use_id // "absent"')" = "absent" ]
}

@test "metrics_on_tool_attempt respects kill switch" {
    export METRICS_SESSION_ID="ta-test-session"
    AGENT_METRICS_ENABLED=0 metrics_on_tool_attempt "Bash" "" "" "ls" ""
    [ ! -s "$METRICS_FILE" ]
}

# ============================================================================
# metrics_on_subagent_start
# ============================================================================

@test "metrics_on_subagent_start emits subagent_start event" {
    export METRICS_SESSION_ID="sa-test-session"
    metrics_on_subagent_start "agent-abc" "Explore" "" ""
    [ -f "$METRICS_FILE" ]
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.event_type')" = "subagent_start" ]
    [ "$(echo "$line" | jq -r '.metadata.agent_id')" = "agent-abc" ]
    [ "$(echo "$line" | jq -r '.metadata.agent_type')" = "Explore" ]
}

@test "metrics_on_subagent_start persists timestamp file" {
    export METRICS_SESSION_ID="sa-test-session"
    metrics_on_subagent_start "agent-xyz" "Plan" "" ""
    [ -f "${METRICS_DIR}/.subagent_start_ts_agent-xyz" ]
    local ts
    ts=$(cat "${METRICS_DIR}/.subagent_start_ts_agent-xyz")
    # Should be a valid unix timestamp (numeric, reasonable range)
    [[ "$ts" =~ ^[0-9]+$ ]]
}

@test "metrics_on_subagent_start includes turn_id and tool_use_id" {
    export METRICS_SESSION_ID="sa-test-session"
    metrics_on_subagent_start "agent-123" "general-purpose" "turn-5" "tooluse-9"
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.turn_id')" = "turn-5" ]
    [ "$(echo "$line" | jq -r '.metadata.tool_use_id')" = "tooluse-9" ]
}

@test "metrics_on_subagent_start respects kill switch" {
    export METRICS_SESSION_ID="sa-test-session"
    AGENT_METRICS_ENABLED=0 metrics_on_subagent_start "agent-off" "Explore" "" ""
    [ ! -s "$METRICS_FILE" ]
    [ ! -f "${METRICS_DIR}/.subagent_start_ts_agent-off" ]
}

# ============================================================================
# metrics_on_subagent_stop
# ============================================================================

@test "metrics_on_subagent_stop emits subagent_stop event" {
    export METRICS_SESSION_ID="sa-test-session"
    metrics_on_subagent_stop "agent-abc" "Explore" "42" "" ""
    [ -f "$METRICS_FILE" ]
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.event_type')" = "subagent_stop" ]
    [ "$(echo "$line" | jq -r '.metadata.agent_id')" = "agent-abc" ]
    [ "$(echo "$line" | jq -r '.metadata.agent_type')" = "Explore" ]
    [ "$(echo "$line" | jq -r '.metadata.duration_seconds')" = "42" ]
}

@test "metrics_on_subagent_stop includes turn_id and tool_use_id" {
    export METRICS_SESSION_ID="sa-test-session"
    metrics_on_subagent_stop "agent-abc" "Plan" "10" "turn-7" "tooluse-11"
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.turn_id')" = "turn-7" ]
    [ "$(echo "$line" | jq -r '.metadata.tool_use_id')" = "tooluse-11" ]
}

@test "metrics_on_subagent_stop respects kill switch" {
    export METRICS_SESSION_ID="sa-test-session"
    AGENT_METRICS_ENABLED=0 metrics_on_subagent_stop "agent-off" "Explore" "10" "" ""
    [ ! -s "$METRICS_FILE" ]
}

# ============================================================================
# metrics_on_session_end
# ============================================================================

@test "metrics_on_session_end emits session_end event with reason" {
    export METRICS_SESSION_ID="se-test-session"
    metrics_on_session_end "prompt_input_exit" "120"
    [ -f "$METRICS_FILE" ]
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.event_type')" = "session_end" ]
    [ "$(echo "$line" | jq -r '.metadata.reason')" = "prompt_input_exit" ]
    [ "$(echo "$line" | jq -r '.metadata.duration_seconds')" = "120" ]
}

@test "metrics_on_session_end defaults reason to unknown" {
    export METRICS_SESSION_ID="se-test-session"
    metrics_on_session_end "" "0"
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.reason')" = "unknown" ]
}

@test "metrics_on_session_end respects kill switch" {
    export METRICS_SESSION_ID="se-test-session"
    AGENT_METRICS_ENABLED=0 metrics_on_session_end "clear" "60"
    [ ! -s "$METRICS_FILE" ]
}

# ============================================================================
# metrics_on_permission_auto_denied
# ============================================================================

@test "metrics_on_permission_auto_denied emits permission_auto_denied event" {
    export METRICS_SESSION_ID="pad-test-session"
    metrics_on_permission_auto_denied "Bash" "not in allowlist"
    [ -f "$METRICS_FILE" ]
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.event_type')" = "permission_auto_denied" ]
    [ "$(echo "$line" | jq -r '.metadata.tool_name')" = "Bash" ]
    [ "$(echo "$line" | jq -r '.metadata.reason')" = "not in allowlist" ]
}

@test "metrics_on_permission_auto_denied omits reason when empty" {
    export METRICS_SESSION_ID="pad-test-session"
    metrics_on_permission_auto_denied "Edit" ""
    local line
    line=$(tail -1 "$METRICS_FILE")
    [ "$(echo "$line" | jq -r '.metadata.tool_name')" = "Edit" ]
    [ "$(echo "$line" | jq -r '.metadata.reason // "absent"')" = "absent" ]
}

@test "metrics_on_permission_auto_denied respects kill switch" {
    export METRICS_SESSION_ID="pad-test-session"
    AGENT_METRICS_ENABLED=0 metrics_on_permission_auto_denied "Bash" "blocked"
    [ ! -s "$METRICS_FILE" ]
}
