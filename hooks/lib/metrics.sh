#!/bin/bash
# Shared metrics emission library for agent session telemetry
# Appends structured JSONL events to ~/.config/agent-smith/events.jsonl
# Never blocks the agent — all operations wrapped in || true
#
# Kill switch: set AGENT_METRICS_ENABLED=0 to disable all metrics collection.
# To fully remove metrics: delete `source metrics.sh` and the single
# metrics_on_* call from each hook script.

AGENT_METRICS_ENABLED="${AGENT_METRICS_ENABLED:-1}"
METRICS_DIR="${METRICS_DIR:-${HOME}/.config/agent-smith}"
METRICS_FILE="${METRICS_DIR}/events.jsonl"

# ============================================================================
# Core utilities
# ============================================================================

_metrics_dir_ready=0
_with_private_umask() {
    local old_umask
    old_umask=$(umask)
    umask 077
    "$@"
    umask "$old_umask"
}

_harden_path() {
    local path="$1"
    local mode="$2"
    [ -e "$path" ] || return 0
    chmod "$mode" "$path" 2>/dev/null || true
}

_ensure_metrics_dir() {
    if [ "$_metrics_dir_ready" -eq 0 ]; then
        _with_private_umask mkdir -p "$METRICS_DIR" 2>/dev/null || true
        _with_private_umask touch "$METRICS_FILE" 2>/dev/null || true
        _harden_path "$METRICS_DIR" 700
        _harden_path "$METRICS_FILE" 600
        _metrics_dir_ready=1
    fi
}

# Escape a string for safe JSON embedding
json_escape() {
    local str="$1"
    str="${str//\\/\\\\}"
    str="${str//\"/\\\"}"
    str="${str//$'\n'/\\n}"
    str="${str//$'\r'/\\r}"
    str="${str//$'\t'/\\t}"
    printf '%s' "$str"
}

# Truncate a string to N characters
truncate_str() {
    local str="$1"
    local max="${2:-500}"
    if [ "${#str}" -gt "$max" ]; then
        printf '%s...' "${str:0:$max}"
    else
        printf '%s' "$str"
    fi
}

# Derive a stable session ID from a transcript path or fallback to date-PID
derive_session_id() {
    local transcript_path="${1:-}"
    if [ -n "$transcript_path" ]; then
        printf '%s' "$transcript_path" | shasum -a 256 2>/dev/null | cut -c1-12
    else
        printf '%s-%s' "$(date +%Y%m%d%H%M%S)" "$$"
    fi
}

# Low-level emit — appends one JSONL line
# Usage: emit_metric <tool> <event_type> <metadata_json>
emit_metric() {
    [ "$AGENT_METRICS_ENABLED" = "1" ] || return 0

    local tool="$1"
    local event_type="$2"
    local metadata="$3"
    local session_id="${METRICS_SESSION_ID:-$(date +%Y%m%d)-$$}"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    _ensure_metrics_dir

    local line
    line="{\"ts\":\"${ts}\",\"tool\":\"${tool}\",\"session_id\":\"${session_id}\",\"event_type\":\"${event_type}\",\"metadata\":${metadata}}"

    printf '%s\n' "$line" >> "$METRICS_FILE" 2>/dev/null || true
    _harden_path "$METRICS_FILE" 600
}

# ============================================================================
# Hook-level wrappers — one call per hook, all metrics logic encapsulated
# Each function is self-contained. To remove metrics from a hook, delete:
#   1. source "${SCRIPT_DIR}/lib/metrics.sh"
#   2. The single metrics_on_* call
# ============================================================================

# Call from: hooks/session-start.sh (after detect_project_type)
# Args: <cwd> <project_type> [session_hint]
metrics_on_session_start() {
    [ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
    local cwd="${1:-$(pwd)}"
    local project_type="${2:-unknown}"
    local session_hint="${3:-}"

    METRICS_SESSION_ID=$(derive_session_id "$session_hint")
    export METRICS_SESSION_ID

    # Persist start timestamp for duration calculation in session_stop
    printf '%s' "$(date +%s)" > "${METRICS_DIR}/.session_start_ts" 2>/dev/null || true
    _harden_path "${METRICS_DIR}/.session_start_ts" 600

    local escaped_cwd escaped_type
    escaped_cwd=$(json_escape "$cwd")
    escaped_type=$(json_escape "$project_type")
    emit_metric "claude" "session_start" "{\"cwd\":\"${escaped_cwd}\",\"project_type\":\"${escaped_type}\"}"
}

# Call from: hooks/session-stop.sh (after notification)
# Args: <stop_reason>
metrics_on_session_stop() {
    [ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
    local stop_reason="${1:-unknown}"

    local duration_seconds=0
    if [ -f "${METRICS_DIR}/.session_start_ts" ]; then
        local start_ts now_ts
        start_ts=$(cat "${METRICS_DIR}/.session_start_ts" 2>/dev/null || echo "0")
        now_ts=$(date +%s)
        duration_seconds=$((now_ts - start_ts))
        rm -f "${METRICS_DIR}/.session_start_ts" 2>/dev/null || true
    fi

    local escaped_reason
    escaped_reason=$(json_escape "$stop_reason")
    emit_metric "claude" "session_stop" "{\"stop_reason\":\"${escaped_reason}\",\"duration_seconds\":${duration_seconds}}"
}

# Call from: hooks/vague-prompt.sh (when is_vague=1)
# Args: <prompt_text>
metrics_on_clarifying_question() {
    [ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
    local prompt_text="${1:-}"

    local snippet
    snippet=$(truncate_str "$(json_escape "$prompt_text")" 100)
    emit_metric "claude" "clarifying_question" "{\"prompt_snippet\":\"${snippet}\",\"is_vague\":true}"
}

# Call from: hooks/test-result.sh (after test execution)
# Args: <passed: 0|1> <test_command> <file_path>
metrics_on_test_result() {
    [ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
    local passed="$1"
    local test_command="${2:-}"
    local file_path="${3:-}"

    local counter="${METRICS_DIR}/.test_fail_count"

    if [ "$passed" = "1" ]; then
        rm -f "$counter" 2>/dev/null || true
        return 0
    fi

    # Increment failure counter
    local fail_count=1
    if [ -f "$counter" ]; then
        fail_count=$(( $(cat "$counter" 2>/dev/null || echo "0") + 1 ))
    fi
    printf '%s' "$fail_count" > "$counter" 2>/dev/null || true
    _harden_path "$counter" 600

    if [ "$fail_count" -ge 3 ]; then
        local escaped_cmd escaped_file
        escaped_cmd=$(truncate_str "$(json_escape "$test_command")" 300)
        escaped_file=$(json_escape "$file_path")
        emit_metric "claude" "test_failure_loop" "{\"test_command\":\"${escaped_cmd}\",\"failure_count\":${fail_count},\"file_path\":\"${escaped_file}\"}"
    fi
}

# Call from: hooks/tool-failure.sh
# Args: <tool_name> <error> [command]
metrics_on_tool_failure() {
    [ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
    local tool_name="${1:-unknown}"
    local error="${2:-}"
    local command="${3:-}"

    local escaped_tool escaped_error
    escaped_tool=$(json_escape "$tool_name")
    escaped_error=$(truncate_str "$(json_escape "$error")" 500)
    emit_metric "claude" "tool_failure" "{\"tool_name\":\"${escaped_tool}\",\"error\":\"${escaped_error}\"}"

    # For Bash tool failures, also emit a command_failure event
    if [ "$tool_name" = "Bash" ] && [ -n "$command" ]; then
        local escaped_cmd
        escaped_cmd=$(truncate_str "$(json_escape "$command")" 300)
        emit_metric "claude" "command_failure" "{\"command\":\"${escaped_cmd}\",\"error\":\"${escaped_error}\"}"
    fi
}

# Call from: hooks/permission-denied.sh
# Args: <tool_name>
metrics_on_permission_denied() {
    [ "$AGENT_METRICS_ENABLED" = "1" ] || return 0
    local tool_name="${1:-unknown}"

    local escaped_tool
    escaped_tool=$(json_escape "$tool_name")
    emit_metric "claude" "permission_denied" "{\"tool_name\":\"${escaped_tool}\"}"
}
