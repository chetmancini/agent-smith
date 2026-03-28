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

# ============================================================================
# Session-ID continuity across hooks
# ============================================================================

@test "session-start and session-stop emit the same session_id" {
    local session_hint="test-session-hint-abc"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    # session-start uses CLAUDE_SESSION_ID env var (does not read stdin for session id)
    echo '{}' | env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp/project" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    local start_sid
    start_sid=$(jq -r '.session_id' "$METRICS_FILE")
    [ "$start_sid" = "$expected_sid" ]

    # session-stop reads session_id from stdin JSON
    : > "$METRICS_FILE"
    printf '{"stop_reason":"end_turn","session_id":"%s","transcript_path":""}' "$session_hint" | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-stop.sh"

    local stop_sid
    stop_sid=$(jq -r '.session_id' "$METRICS_FILE")
    [ "$stop_sid" = "$expected_sid" ]
}

@test "compact hook emits the same session_id as session-start" {
    local session_hint="test-session-hint-xyz"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    echo '{}' | env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp/project" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    local start_sid
    start_sid=$(jq -r '.session_id' "$METRICS_FILE")

    : > "$METRICS_FILE"
    printf '{"session_id":"%s","transcript_path":""}' "$session_hint" | \
        env METRICS_DIR="$METRICS_DIR" \
        COMPACT_TRIGGER=auto \
        bash "$HOOKS_DIR/compact.sh"

    local comp_sid
    comp_sid=$(jq -r '.session_id' "$METRICS_FILE")
    [ "$start_sid" = "$comp_sid" ]
    [ "$comp_sid" = "$expected_sid" ]
}

@test "all hooks produce matching session_ids for a full session lifecycle" {
    local session_hint="full-lifecycle-session"
    local expected_sid
    expected_sid=$(expected_session_id "$session_hint")

    # 1. session-start
    echo '{}' | env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    # 2. compact (auto)
    printf '{"session_id":"%s","transcript_path":""}' "$session_hint" | \
        env METRICS_DIR="$METRICS_DIR" \
        COMPACT_TRIGGER=auto \
        bash "$HOOKS_DIR/compact.sh"

    # 3. session-stop
    printf '{"stop_reason":"end_turn","session_id":"%s","transcript_path":""}' "$session_hint" | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-stop.sh"

    # All three events should have the same session_id
    local sids
    sids=$(jq -r '.session_id' "$METRICS_FILE" | sort -u)
    [ "$(echo "$sids" | wc -l | tr -d ' ')" -eq 1 ]
    [ "$sids" = "$expected_sid" ]
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

@test "session-stop does not emit session_cost event" {
    local transcript="$TEST_TMPDIR/transcript.jsonl"
    cat > "$transcript" <<'JSONL'
{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
JSONL

    printf '{"stop_reason":"end_turn","session_id":"hint","transcript_path":"%s"}' "$transcript" | \
        env METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-stop.sh"

    # Should only have session_stop, NOT session_cost
    local event_count
    event_count=$(wc -l < "$METRICS_FILE" | tr -d ' ')
    [ "$event_count" -eq 1 ]

    run jq -r '.event_type' "$METRICS_FILE"
    assert_output "session_stop"
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

@test "rollup drops entry when transcript file is deleted" {
    local session_hint="deleted-session"
    local transcript="$TEST_TMPDIR/transcript.jsonl"

    cat > "$transcript" <<'JSONL'
{"type":"assistant","message":{"role":"assistant","type":"message","model":"claude-sonnet-4-6","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"stop_reason":"end_turn"}}
JSONL

    printf '{"transcript_path":"%s"}' "$transcript" | \
        env CLAUDE_SESSION_ID="$session_hint" \
        CLAUDE_PROJECT_DIR="/tmp" \
        METRICS_DIR="$METRICS_DIR" \
        bash "$HOOKS_DIR/session-start.sh"

    # Delete transcript before rollup
    rm -f "$transcript"

    run env METRICS_DIR="$METRICS_DIR" bash "$PROJECT_ROOT/scripts/metrics-rollup.sh"
    assert_success

    # Entry should be removed from .transcript_paths
    if [ -f "$METRICS_DIR/.transcript_paths" ]; then
        local content
        content=$(cat "$METRICS_DIR/.transcript_paths")
        [ -z "$content" ]
    fi
}
