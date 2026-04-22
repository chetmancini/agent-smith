#!/bin/bash
# PostToolUseFailure hook: log tool failures as metrics
# Never blocks the agent — exits 0 always

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
raw_tool_name=$(echo "$input" | jq -r '.tool_name // "unknown"')
tool_name=$(normalize_hook_tool_name "$raw_tool_name")
command=$(echo "$input" | jq -r '.tool_input.command // ""')
file_path=$(echo "$input" | jq -r '.tool_input.file_path // .filePath // ""')
session_id=$(echo "$input" | jq -r '.session_id // .sessionId // empty')
turn_id=$(echo "$input" | jq -r '.turn_id // .turnId // empty')
tool_use_id=$(echo "$input" | jq -r '.tool_use_id // .toolUseId // empty')

restore_metrics_session_id "$session_id" || true

if [ "${AGENT_SMITH_TOOL:-claude}" = "codex" ] || [ "${AGENT_SMITH_TOOL:-claude}" = "opencode" ] || [ "${AGENT_SMITH_TOOL:-claude}" = "gemini" ] || [ "${AGENT_SMITH_TOOL:-claude}" = "pi" ]; then
	exit_code=$(echo "$input" | jq -r '
		def parsed_tool_response:
			(.tool_response // null) as $response
			| if ($response | type) == "string" then
				($response | fromjson? // $response)
			else
				$response
			end;
		parsed_tool_response as $response
		| if ($response | type) == "object" then
			($response.exit_code // $response.exitCode // $response.status // $response["Exit Code"] // 0)
		else
			0
		end
	')
	case "$exit_code" in
	'' | 0)
		exit 0
		;;
	esac
	stderr_text=$(echo "$input" | jq -r '
		def parsed_tool_response:
			(.tool_response // null) as $response
			| if ($response | type) == "string" then
				($response | fromjson? // $response)
			else
				$response
			end;
		parsed_tool_response as $response
		| if ($response | type) == "object" then
			($response.stderr // $response.error // $response.message // $response["Stderr"] // "")
		else
			""
		end
	')
	stdout_text=$(echo "$input" | jq -r '
		def parsed_tool_response:
			(.tool_response // null) as $response
			| if ($response | type) == "string" then
				($response | fromjson? // $response)
			else
				$response
			end;
		parsed_tool_response as $response
		| if ($response | type) == "object" then
			($response.stdout // $response["Stdout"] // "")
		else
			""
		end
	')
	error=$(echo "$input" | jq -r '
		def parsed_tool_response:
			(.tool_response // null) as $response
			| if ($response | type) == "string" then
				($response | fromjson? // $response)
			else
				$response
			end;
		parsed_tool_response as $response
		| if ($response | type) == "object" then
			($response.stderr // $response.error // $response.message // $response["Stderr"] // ("exit " + (($response.exit_code // $response.exitCode // $response.status // $response["Exit Code"] // 1) | tostring)))
		else
			"exit 1"
		end
	')
else
	exit_code=""
	stderr_text=""
	stdout_text=""
	error=$(echo "$input" | jq -r '.error // ""')
fi

# Skip expected non-zero exits that aren't real failures
if [ "$tool_name" = "Bash" ]; then
	case "$command" in
	*"command -v"* | *"which "* | *"test -"* | *"[ -"* | *"git rev-parse"* | *"hash "* | *"type "*) exit 0 ;;
	esac
fi

metrics_on_tool_failure "$tool_name" "$error" "$command" "$exit_code" "$stderr_text" "$stdout_text" "$file_path" "$turn_id" "$tool_use_id"

exit 0
