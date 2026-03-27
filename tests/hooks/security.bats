#!/usr/bin/env bats

setup() {
    load '../setup_suite'
    export TEST_TMPDIR
    TEST_TMPDIR="$(mktemp -d)"
}

teardown() {
    rm -rf "$TEST_TMPDIR"
}

get_mode() {
    local path="$1"
    if stat --version >/dev/null 2>&1; then
        stat -c '%a' "$path"
    else
        stat -f '%Lp' "$path"
    fi
}

create_metrics_db() {
    local db_file="$1"
    mkdir -p "$(dirname "$db_file")"
    sqlite3 "$db_file" "
        CREATE TABLE events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            tool TEXT NOT NULL,
            session_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            metadata TEXT NOT NULL,
            ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL UNIQUE,
            tool TEXT NOT NULL,
            started_at TEXT,
            stopped_at TEXT,
            duration_seconds INTEGER,
            stop_reason TEXT,
            event_count INTEGER NOT NULL DEFAULT 0,
            failure_count INTEGER NOT NULL DEFAULT 0,
            test_loop_count INTEGER NOT NULL DEFAULT 0,
            clarification_count INTEGER NOT NULL DEFAULT 0,
            denial_count INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO events (ts, tool, session_id, event_type, metadata)
        VALUES
            ('2026-03-27T00:00:00Z', 'claude', 'session-1', 'session_start', '{\"cwd\":\"/tmp/project\"}'),
            ('2026-03-27T00:05:00Z', 'claude', 'session-1', 'session_stop', '{\"stop_reason\":\"completed\",\"duration_seconds\":300}');
        INSERT INTO sessions (session_id, tool, started_at, stopped_at, duration_seconds, stop_reason, event_count)
        VALUES ('session-1', 'claude', '2026-03-27T00:00:00Z', '2026-03-27T00:05:00Z', 300, 'completed', 2);
    "
}

create_fake_claude() {
    local fakebin="$1"
    local marker_file="$2"
    local prompt_capture="$3"
    mkdir -p "$fakebin"
    cat > "${fakebin}/claude" <<EOF
#!/bin/bash
printf 'report\n'
printf '%s\n' "\$*" > "$prompt_capture"
touch "$marker_file"
EOF
    chmod 700 "${fakebin}/claude"
}

@test "test-result hook does not execute injected commands from filenames" {
    local src spec payload_file marker
    mkdir -p "$TEST_TMPDIR/app" "$TEST_TMPDIR/spec"
    src="$TEST_TMPDIR/app/foo\";touch agent_smith_injected;#.rb"
    spec="$TEST_TMPDIR/spec/foo\";touch agent_smith_injected;#_spec.rb"
    marker="$TEST_TMPDIR/agent_smith_injected"
    payload_file="$TEST_TMPDIR/payload.json"

    printf 'class Demo; end\n' > "$src"
    printf 'puts "spec loaded"\n' > "$spec"
    jq -n --arg p "$src" '{tool_input:{file_path:$p}}' > "$payload_file"

    run bash -lc "cd \"$TEST_TMPDIR\" && bash \"$HOOKS_DIR/test-result.sh\" < \"$payload_file\""

    [ "$status" -eq 0 ]
    [ ! -f "$marker" ]
}

@test "metrics files are created with private permissions" {
    local metrics_dir
    metrics_dir="$TEST_TMPDIR/metrics"

    run bash -lc "source \"$HOOKS_DIR/lib/metrics.sh\"; $(declare -f get_mode); export METRICS_DIR=\"$metrics_dir\"; export METRICS_FILE=\"$metrics_dir/events.jsonl\"; emit_metric claude session_start '{\"cwd\":\"/tmp\"}'; dir_mode=\$(get_mode \"$metrics_dir\"); file_mode=\$(get_mode \"$metrics_dir/events.jsonl\"); printf '%s %s\n' \"\$dir_mode\" \"\$file_mode\""

    [ "$status" -eq 0 ]
    [ "$output" = "700 600" ]
}

@test "analyze-config stays local by default and does not invoke claude" {
    local metrics_dir db_file fakebin marker prompt_capture
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"

    create_metrics_db "$db_file"
    create_fake_claude "$fakebin" "$marker" "$prompt_capture"

    run env PATH="$fakebin:$PATH" METRICS_DIR="$metrics_dir" bash "$PROJECT_ROOT/scripts/analyze-config.sh" --sessions 1

    [ "$status" -eq 0 ]
    [ ! -f "$marker" ]
    [ -d "$metrics_dir/reports" ]
}

@test "llm analysis omits settings unless include-settings is requested" {
    local metrics_dir db_file fakebin marker prompt_capture home_dir
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"
    home_dir="$TEST_TMPDIR/home"

    create_metrics_db "$db_file"
    create_fake_claude "$fakebin" "$marker" "$prompt_capture"
    mkdir -p "$home_dir/.claude"
    printf '{"apiKey":"super-secret-token"}\n' > "$home_dir/.claude/settings.json"

    run env PATH="$fakebin:$PATH" HOME="$home_dir" METRICS_DIR="$metrics_dir" bash "$PROJECT_ROOT/scripts/analyze-config.sh" --llm --sessions 1

    [ "$status" -eq 0 ]
    [ -f "$marker" ]
    ! grep -q "super-secret-token" "$prompt_capture"
}

@test "llm analysis includes settings only when explicitly requested" {
    local metrics_dir db_file fakebin marker prompt_capture home_dir
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"
    home_dir="$TEST_TMPDIR/home"

    create_metrics_db "$db_file"
    create_fake_claude "$fakebin" "$marker" "$prompt_capture"
    mkdir -p "$home_dir/.claude"
    printf '{"apiKey":"super-secret-token"}\n' > "$home_dir/.claude/settings.json"

    run env PATH="$fakebin:$PATH" HOME="$home_dir" METRICS_DIR="$metrics_dir" bash "$PROJECT_ROOT/scripts/analyze-config.sh" --llm --include-settings --sessions 1

    [ "$status" -eq 0 ]
    [ -f "$marker" ]
    grep -q "super-secret-token" "$prompt_capture"
}

@test "analyze-trigger is disabled by default" {
    local metrics_dir db_file fakebin marker prompt_capture
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"

    create_metrics_db "$db_file"
    create_fake_claude "$fakebin" "$marker" "$prompt_capture"

    run env PATH="$fakebin:$PATH" METRICS_DIR="$metrics_dir" ANALYZE_THRESHOLD=1 bash "$HOOKS_DIR/analyze-trigger.sh"

    [ "$status" -eq 0 ]
    [ ! -f "$marker" ]
}
