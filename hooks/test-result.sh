#!/bin/bash
# Post-edit test hook: run the corresponding test file after editing a source file
# Exits 0 always — test failures are reported but never block the edit

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hooks/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
# shellcheck source=hooks/lib/metrics.sh
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
# Claude Code sends tool_input.file_path (PostToolUse Edit|Write payload)
# OpenCode sends filePath at the top level (file.edited event shape)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // .filePath // empty')
session_id=$(echo "$input" | jq -r '.session_id // .sessionId // empty')

restore_metrics_session_id "$session_id" || true

if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
	exit 0
fi

helper_output=$(bash "$PROJECT_ROOT/scripts/find-test-target.sh" "$file_path" 2>/dev/null || true)
found=$(printf '%s' "$helper_output" | jq -r '.found // false' 2>/dev/null || echo "false")
if [ "$found" != "true" ]; then
	exit 0
fi

test_file=$(printf '%s' "$helper_output" | jq -r '.test_file // empty')
test_cmd=()
while IFS= read -r cmd_part; do
	test_cmd+=("$cmd_part")
done < <(printf '%s' "$helper_output" | jq -r '.test_command[]?')
printf -v test_cmd_display '%q ' "${test_cmd[@]}"
test_cmd_display="${test_cmd_display% }"

if [ -z "$test_file" ] || [ "${#test_cmd[@]}" -eq 0 ]; then
	exit 0
fi

log_info "Testing: $(basename "$file_path") -> $(basename "$test_file")"

if "${test_cmd[@]}" >&2; then
	log_info "Tests passed"
	metrics_on_test_result 1 "$test_cmd_display" "$file_path"
else
	log_warn "Tests failed — review output above"
	metrics_on_test_result 0 "$test_cmd_display" "$file_path"
fi

exit 0
