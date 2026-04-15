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
            denial_count INTEGER NOT NULL DEFAULT 0,
            cwd TEXT
        );
        INSERT INTO events (ts, tool, session_id, event_type, metadata)
        VALUES
            ('2026-03-27T00:00:00Z', 'claude', 'session-1', 'session_start', '{\"cwd\":\"/tmp/project\"}'),
            ('2026-03-27T00:05:00Z', 'claude', 'session-1', 'session_stop', '{\"stop_reason\":\"completed\",\"duration_seconds\":300}');
        INSERT INTO sessions (session_id, tool, started_at, stopped_at, duration_seconds, stop_reason, event_count, cwd)
        VALUES ('session-1', 'claude', '2026-03-27T00:00:00Z', '2026-03-27T00:05:00Z', 300, 'completed', 2, '/tmp/project');
    "
}

create_fake_llm_cli() {
	local fakebin="$1"
	local name="$2"
	local marker_file="$3"
    local prompt_capture="$4"
    mkdir -p "$fakebin"
    cat > "${fakebin}/${name}" <<EOF
#!/bin/bash
printf 'report\n'
printf '%s\n' "\$*" > "$prompt_capture"
touch "$marker_file"
EOF
    chmod 700 "${fakebin}/${name}"
}

create_fake_nohup() {
    local fakebin="$1"
    mkdir -p "$fakebin"
    cat > "${fakebin}/nohup" <<'EOF'
#!/bin/bash
"$@"
EOF
    chmod 700 "${fakebin}/nohup"
}

create_fake_background_bash() {
    local fakebin="$1"
    local analyze_script="$2"
    local marker_file="$3"
    local argv_capture="$4"
    mkdir -p "$fakebin"
    cat > "${fakebin}/bash" <<EOF
#!/bin/bash
if [ "\$1" = "$analyze_script" ]; then
    printf '%s\n' "\$*" > "$argv_capture"
    touch "$marker_file"
    exit 0
fi
exec /bin/bash "\$@"
EOF
    chmod 700 "${fakebin}/bash"
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
    create_fake_llm_cli "$fakebin" claude "$marker" "$prompt_capture"

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
    create_fake_llm_cli "$fakebin" claude "$marker" "$prompt_capture"
    mkdir -p "$home_dir/.claude"
    printf '{"apiKey":"super-secret-token"}\n' > "$home_dir/.claude/settings.json"

    run env PATH="$fakebin:$PATH" HOME="$home_dir" METRICS_DIR="$metrics_dir" bash "$PROJECT_ROOT/scripts/analyze-config.sh" --llm --sessions 1

    [ "$status" -eq 0 ]
    [ -f "$marker" ]
    ! grep -q "super-secret-token" "$prompt_capture"
}

@test "llm analysis includes redacted settings only when explicitly requested" {
    local metrics_dir db_file fakebin marker prompt_capture home_dir
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"
    home_dir="$TEST_TMPDIR/home"

    create_metrics_db "$db_file"
    create_fake_llm_cli "$fakebin" claude "$marker" "$prompt_capture"
    mkdir -p "$home_dir/.claude"
    printf '{"apiKey":"super-secret-token","model":"sonnet"}\n' > "$home_dir/.claude/settings.json"

    run env PATH="$fakebin:$PATH" HOME="$home_dir" METRICS_DIR="$metrics_dir" bash "$PROJECT_ROOT/scripts/analyze-config.sh" --llm --include-settings --sessions 1

    [ "$status" -eq 0 ]
    [ -f "$marker" ]
    ! grep -q "super-secret-token" "$prompt_capture"
    grep -q '"apiKey": "\[REDACTED\]"' "$prompt_capture"
    grep -q '"model": "sonnet"' "$prompt_capture"
}

@test "llm analysis includes repo-local Claude settings when home config is missing" {
    local metrics_dir db_file fakebin marker prompt_capture home_dir project_dir
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"
    home_dir="$TEST_TMPDIR/home"
    project_dir="$TEST_TMPDIR/project"

    create_metrics_db "$db_file"
    create_fake_llm_cli "$fakebin" claude "$marker" "$prompt_capture"
    mkdir -p "$project_dir/.claude" "$home_dir"
    printf '{"apiKey":"repo-secret","model":"repo-sonnet"}\n' > "$project_dir/.claude/settings.json"

    run bash -c "cd \"$project_dir\" && env PATH=\"$fakebin:$PATH\" HOME=\"$home_dir\" METRICS_DIR=\"$metrics_dir\" bash \"$PROJECT_ROOT/scripts/analyze-config.sh\" --llm --include-settings --sessions 1 --tool claude"

    [ "$status" -eq 0 ]
    [ -f "$marker" ]
    ! grep -q "repo-secret" "$prompt_capture"
    grep -q '"apiKey": "\[REDACTED\]"' "$prompt_capture"
    grep -q '"model": "repo-sonnet"' "$prompt_capture"
}

@test "codex llm analysis uses the codex cli and redacts TOML secrets before sending settings" {
    local metrics_dir db_file fakebin marker prompt_capture home_dir
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"
    home_dir="$TEST_TMPDIR/home"

    create_metrics_db "$db_file"
    create_fake_llm_cli "$fakebin" codex "$marker" "$prompt_capture"
    mkdir -p "$home_dir/.codex"
    cat > "$home_dir/.codex/config.toml" <<'EOF'
model = "gpt-5.4"
api_key = "super-secret-token"
bearer_token = "another-secret"
EOF

    run env PATH="$fakebin:$PATH" HOME="$home_dir" METRICS_DIR="$metrics_dir" \
        bash "$PROJECT_ROOT/scripts/analyze-config.sh" --llm --include-settings --sessions 1 --tool codex

    [ "$status" -eq 0 ]
    [ -f "$marker" ]
    grep -q '^exec -C ' "$prompt_capture"
    ! grep -q "super-secret-token" "$prompt_capture"
    ! grep -q "another-secret" "$prompt_capture"
    grep -q 'api_key = "\[REDACTED\]"' "$prompt_capture"
    grep -q 'bearer_token = "\[REDACTED\]"' "$prompt_capture"
    grep -q 'model = "gpt-5.4"' "$prompt_capture"
}

@test "opencode llm analysis redacts JSON secrets before sending settings" {
    local metrics_dir db_file fakebin marker prompt_capture home_dir
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"
    home_dir="$TEST_TMPDIR/home"

    create_metrics_db "$db_file"
    create_fake_llm_cli "$fakebin" opencode "$marker" "$prompt_capture"
    mkdir -p "$home_dir/.config/opencode"
    cat > "$home_dir/.config/opencode/opencode.json" <<'EOF'
{
  "model": "anthropic/claude-sonnet-4-6",
  "apiKey": "super-secret-token",
  "access_token": "another-secret"
}
EOF

    run env PATH="$fakebin:$PATH" HOME="$home_dir" METRICS_DIR="$metrics_dir" \
        bash "$PROJECT_ROOT/scripts/analyze-config.sh" --llm --include-settings --sessions 1 --tool opencode

    [ "$status" -eq 0 ]
    [ -f "$marker" ]
    grep -q '^run --dir ' "$prompt_capture"
    ! grep -q "super-secret-token" "$prompt_capture"
    ! grep -q "another-secret" "$prompt_capture"
    grep -q '"apiKey": "\[REDACTED\]"' "$prompt_capture"
    grep -q '"access_token": "\[REDACTED\]"' "$prompt_capture"
    grep -q '"model": "anthropic/claude-sonnet-4-6"' "$prompt_capture"
}

@test "opencode llm analysis does not fall back to Claude settings when OpenCode config is missing" {
    local metrics_dir db_file fakebin marker prompt_capture home_dir
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"
    home_dir="$TEST_TMPDIR/home"

    create_metrics_db "$db_file"
    create_fake_llm_cli "$fakebin" opencode "$marker" "$prompt_capture"
    mkdir -p "$home_dir/.claude"
    printf '{"apiKey":"claude-secret","model":"sonnet"}\n' > "$home_dir/.claude/settings.json"

    run env PATH="$fakebin:$PATH" HOME="$home_dir" METRICS_DIR="$metrics_dir" \
        bash "$PROJECT_ROOT/scripts/analyze-config.sh" --llm --include-settings --sessions 1 --tool opencode

    [ "$status" -eq 0 ]
    [ -f "$marker" ]
    ! grep -q "claude-secret" "$prompt_capture"
    ! grep -q '"model": "sonnet"' "$prompt_capture"
    grep -q "OpenCode settings snapshot omitted because ~/.config/opencode/opencode.json is unavailable" "$prompt_capture"
}

@test "codex llm analysis does not fall back to Claude settings when Codex config is missing" {
    local metrics_dir db_file fakebin marker prompt_capture home_dir
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"
    home_dir="$TEST_TMPDIR/home"

    create_metrics_db "$db_file"
    create_fake_llm_cli "$fakebin" codex "$marker" "$prompt_capture"
    mkdir -p "$home_dir/.claude"
    printf '{"apiKey":"claude-secret","model":"sonnet"}\n' > "$home_dir/.claude/settings.json"

    run env PATH="$fakebin:$PATH" HOME="$home_dir" METRICS_DIR="$metrics_dir" \
        bash "$PROJECT_ROOT/scripts/analyze-config.sh" --llm --include-settings --sessions 1 --tool codex

    [ "$status" -eq 0 ]
    [ -f "$marker" ]
    ! grep -q "claude-secret" "$prompt_capture"
    ! grep -q '"model": "sonnet"' "$prompt_capture"
    grep -q "Codex settings snapshot omitted because ~/.codex/config.toml is unavailable" "$prompt_capture"
}

@test "llm analysis defaults to the active agent cli when AGENT_SMITH_TOOL is set" {
    local metrics_dir db_file fakebin marker prompt_capture
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/codex_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"

    create_metrics_db "$db_file"
    create_fake_llm_cli "$fakebin" codex "$marker" "$prompt_capture"

    run env PATH="$fakebin:$PATH" METRICS_DIR="$metrics_dir" AGENT_SMITH_TOOL=codex \
        bash "$PROJECT_ROOT/scripts/analyze-config.sh" --llm --sessions 1

    [ "$status" -eq 0 ]
    [ -f "$marker" ]
    grep -q '^exec -C ' "$prompt_capture"
    grep -q 'tool: codex' "$prompt_capture"
}

@test "analyze-config report includes project breakdown section" {
    local metrics_dir db_file
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"

    create_metrics_db "$db_file"

    run env METRICS_DIR="$metrics_dir" bash "$PROJECT_ROOT/scripts/analyze-config.sh" --sessions 10

    [ "$status" -eq 0 ]
    local report_file
    report_file=$(ls "$metrics_dir/reports/"*.md | head -1)
    grep -q "Breakdown by Project" "$report_file"
}

@test "analyze-config report includes recent failure examples with rich metadata" {
    local metrics_dir db_file report_file
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"

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
            denial_count INTEGER NOT NULL DEFAULT 0,
            cwd TEXT
        );
        INSERT INTO events (ts, tool, session_id, event_type, metadata) VALUES
            ('2026-03-27T01:00:00Z', 'codex', 'codex-session', 'tool_failure', '{\"tool_name\":\"Bash\",\"command\":\"pnpm test\",\"exit_code\":2,\"stderr_snippet\":\"test suite failed\",\"stdout_snippet\":\"failing output\"}'),
            ('2026-03-27T01:00:01Z', 'codex', 'codex-session', 'command_failure', '{\"command\":\"pnpm test\",\"exit_code\":2,\"stderr_snippet\":\"test suite failed\"}');
        INSERT INTO sessions (session_id, tool, started_at, stopped_at, duration_seconds, stop_reason, event_count, failure_count, cwd) VALUES
            ('codex-session', 'codex', '2026-03-27T01:00:00Z', '2026-03-27T01:10:00Z', 600, 'completed', 2, 1, '/home/user/app');
    "

    run env METRICS_DIR="$metrics_dir" bash "$PROJECT_ROOT/scripts/analyze-config.sh" --sessions 10 --tool codex

    [ "$status" -eq 0 ]
    report_file=$(ls "$metrics_dir/reports/"*.md | head -1)
    grep -q "Recent Failure Examples" "$report_file"
    grep -q "pnpm test" "$report_file"
    grep -q "test suite failed" "$report_file"
    grep -q "failing output" "$report_file"
    grep -q "Bash" "$report_file"
}

@test "analyze-config --project filters by project basename" {
    local metrics_dir db_file
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"

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
            denial_count INTEGER NOT NULL DEFAULT 0,
            cwd TEXT
        );
        INSERT INTO events (ts, tool, session_id, event_type, metadata) VALUES
            ('2026-03-27T00:00:00Z', 'claude', 'session-a', 'session_start', '{\"cwd\":\"/home/user/app-a\"}'),
            ('2026-03-27T01:00:00Z', 'claude', 'session-b', 'session_start', '{\"cwd\":\"/home/user/app-b\"}');
        INSERT INTO sessions (session_id, tool, started_at, event_count, cwd) VALUES
            ('session-a', 'claude', '2026-03-27T00:00:00Z', 5, '/home/user/app-a'),
            ('session-b', 'claude', '2026-03-27T01:00:00Z', 3, '/home/user/app-b');
    "

    run env METRICS_DIR="$metrics_dir" bash "$PROJECT_ROOT/scripts/analyze-config.sh" --sessions 10 --project app-a

    [ "$status" -eq 0 ]
    local report_file
    report_file=$(ls "$metrics_dir/reports/"*.md | head -1)
    grep -q "project: app-a" "$report_file"
}

@test "analyze-config --tool filters sessions to the initiating agent" {
    local metrics_dir db_file report_file
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"

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
            denial_count INTEGER NOT NULL DEFAULT 0,
            cwd TEXT
        );
        INSERT INTO sessions (session_id, tool, started_at, event_count, cwd) VALUES
            ('claude-session', 'claude', '2026-03-27T00:00:00Z', 5, '/home/user/app'),
            ('codex-session', 'codex', '2026-03-27T01:00:00Z', 7, '/home/user/app');
    "

    run env METRICS_DIR="$metrics_dir" bash "$PROJECT_ROOT/scripts/analyze-config.sh" --sessions 10 --tool codex

    [ "$status" -eq 0 ]
    report_file=$(ls "$metrics_dir/reports/"*.md | head -1)
    grep -q "tool: codex" "$report_file"
    grep -q "codex" "$report_file"
    ! grep -q "claude-session" "$report_file"
}

@test "analyze-trigger counts only sessions from the initiating agent" {
    local metrics_dir db_file
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"

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
        INSERT INTO events (ts, tool, session_id, event_type, metadata) VALUES
            ('2026-03-27T00:00:00Z', 'claude', 'claude-1', 'session_start', '{}'),
            ('2026-03-27T00:01:00Z', 'claude', 'claude-2', 'session_start', '{}'),
            ('2026-03-27T00:02:00Z', 'codex', 'codex-1', 'session_start', '{}');
    "

    run env METRICS_DIR="$metrics_dir" AGENT_SMITH_TOOL=codex AUTO_ANALYZE_ENABLED=1 ANALYZE_THRESHOLD=2 bash "$HOOKS_DIR/analyze-trigger.sh"

    [ "$status" -eq 0 ]
    ! grep -q "analysis_run" "$metrics_dir/events.jsonl"
}

@test "analyze-trigger is disabled by default" {
    local metrics_dir db_file fakebin marker prompt_capture
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/claude_called"
    prompt_capture="$TEST_TMPDIR/prompt.txt"

    create_metrics_db "$db_file"
    create_fake_llm_cli "$fakebin" claude "$marker" "$prompt_capture"

    run env PATH="$fakebin:$PATH" METRICS_DIR="$metrics_dir" ANALYZE_THRESHOLD=1 bash "$HOOKS_DIR/analyze-trigger.sh"

    [ "$status" -eq 0 ]
    [ ! -f "$marker" ]
}

@test "analyze-trigger llm mode dispatches through run-agent-skill with the initiating tool" {
    local metrics_dir db_file fakebin marker prompt_capture
    metrics_dir="$TEST_TMPDIR/metrics"
    db_file="$metrics_dir/rollup.db"
    fakebin="$TEST_TMPDIR/fakebin"
    marker="$TEST_TMPDIR/run_agent_skill_called"
    prompt_capture="$TEST_TMPDIR/run_agent_skill_argv.txt"

    create_metrics_db "$db_file"
    sqlite3 "$db_file" "
        UPDATE events SET tool = 'codex', session_id = 'codex-session';
        UPDATE sessions SET tool = 'codex', session_id = 'codex-session';
    "
    create_fake_llm_cli "$fakebin" codex "$TEST_TMPDIR/codex_binary_checked" "$TEST_TMPDIR/codex_unused.txt"
    create_fake_nohup "$fakebin"
    create_fake_background_bash "$fakebin" "$PROJECT_ROOT/scripts/run-agent-skill.sh" "$marker" "$prompt_capture"

    run env PATH="$fakebin:/usr/bin:/bin" METRICS_DIR="$metrics_dir" \
        AGENT_SMITH_TOOL=codex AUTO_ANALYZE_ENABLED=1 AUTO_ANALYZE_MODE=llm AUTO_ANALYZE_INCLUDE_SETTINGS=1 ANALYZE_THRESHOLD=1 \
        /bin/bash "$HOOKS_DIR/analyze-trigger.sh"

    [ "$status" -eq 0 ]
    for _ in $(seq 1 20); do
        [ -f "$marker" ] && break
        sleep 0.1
    done
    [ -f "$marker" ]
    grep -q -- 'analyze-config' "$prompt_capture"
    grep -q -- '--tool codex' "$prompt_capture"
    grep -q -- '--sessions 1' "$prompt_capture"
    grep -q -- '--auto' "$prompt_capture"
    grep -q -- '--include-settings' "$prompt_capture"
}
