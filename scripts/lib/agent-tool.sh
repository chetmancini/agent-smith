#!/bin/bash

agent_smith_validate_tool_name() {
	case "$1" in
	claude | gemini | codex | opencode) return 0 ;;
	*) return 1 ;;
	esac
}

agent_smith_supported_tools() {
	printf '%s\n' claude gemini codex opencode
}

agent_smith_claude_config_candidates() {
	cat <<EOF
${HOME}/.claude/settings.json
${HOME}/.claude/settings.local.json
$(pwd)/.claude/settings.json
EOF
}

agent_smith_tool_config_candidates() {
	case "$1" in
	claude)
		agent_smith_claude_config_candidates
		;;
	gemini)
		printf '%s\n' "${GEMINI_CLI_HOME:-${HOME}/.gemini}/settings.json"
		printf '%s\n' "$(pwd)/.gemini/settings.json"
		;;
	codex)
		printf '%s\n' "${HOME}/.codex/config.toml"
		;;
	opencode)
		printf '%s\n' "${HOME}/.config/opencode/opencode.json"
		;;
	*)
		return 1
		;;
	esac
}

agent_smith_first_existing_tool_config() {
	local tool="$1"
	local candidate

	while IFS= read -r candidate; do
		[ -n "$candidate" ] || continue
		if [ -f "$candidate" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done <<EOF
$(agent_smith_tool_config_candidates "$tool")
EOF

	return 1
}

agent_smith_tool_has_config() {
	local tool="$1"

	agent_smith_first_existing_tool_config "$tool" >/dev/null
}

agent_smith_detect_tool() {
	local explicit_tool="${1:-}"
	local claude_has_config=0
	local gemini_has_config=0
	local codex_has_config=0
	local opencode_has_config=0
	local claude_has_cli=0
	local gemini_has_cli=0
	local codex_has_cli=0
	local opencode_has_cli=0
	local config_count=0
	local cli_count=0

	if [ -n "$explicit_tool" ]; then
		if agent_smith_validate_tool_name "$explicit_tool"; then
			printf '%s\n' "$explicit_tool"
			return 0
		fi
		echo "Error: unsupported tool '$explicit_tool' (expected claude, gemini, codex, or opencode)" >&2
		return 1
	fi

	if [ -n "${AGENT_SMITH_TOOL:-}" ]; then
		if agent_smith_validate_tool_name "${AGENT_SMITH_TOOL}"; then
			printf '%s\n' "${AGENT_SMITH_TOOL}"
			return 0
		fi
		echo "Error: unsupported AGENT_SMITH_TOOL '${AGENT_SMITH_TOOL}'" >&2
		return 1
	fi

	if agent_smith_tool_has_config claude; then
		claude_has_config=1
		config_count=$((config_count + 1))
	fi
	if agent_smith_tool_has_config gemini; then
		gemini_has_config=1
		config_count=$((config_count + 1))
	fi
	if agent_smith_tool_has_config codex; then
		codex_has_config=1
		config_count=$((config_count + 1))
	fi
	if agent_smith_tool_has_config opencode; then
		opencode_has_config=1
		config_count=$((config_count + 1))
	fi
	if command -v claude >/dev/null 2>&1; then
		claude_has_cli=1
		cli_count=$((cli_count + 1))
	fi
	if command -v gemini >/dev/null 2>&1; then
		gemini_has_cli=1
		cli_count=$((cli_count + 1))
	fi
	if command -v codex >/dev/null 2>&1; then
		codex_has_cli=1
		cli_count=$((cli_count + 1))
	fi
	if command -v opencode >/dev/null 2>&1; then
		opencode_has_cli=1
		cli_count=$((cli_count + 1))
	fi

	# If exactly one tool has config installed, use it
	if [ "$config_count" -eq 1 ]; then
		if [ "$claude_has_config" -eq 1 ]; then
			printf 'claude\n'
			return 0
		fi
		if [ "$gemini_has_config" -eq 1 ]; then
			printf 'gemini\n'
			return 0
		fi
		if [ "$codex_has_config" -eq 1 ]; then
			printf 'codex\n'
			return 0
		fi
		if [ "$opencode_has_config" -eq 1 ]; then
			printf 'opencode\n'
			return 0
		fi
	fi

	# If exactly one CLI is available, use it
	if [ "$cli_count" -eq 1 ]; then
		if [ "$claude_has_cli" -eq 1 ]; then
			printf 'claude\n'
			return 0
		fi
		if [ "$gemini_has_cli" -eq 1 ]; then
			printf 'gemini\n'
			return 0
		fi
		if [ "$codex_has_cli" -eq 1 ]; then
			printf 'codex\n'
			return 0
		fi
		if [ "$opencode_has_cli" -eq 1 ]; then
			printf 'opencode\n'
			return 0
		fi
	fi

	echo "Error: unable to infer which agent to inspect. Set AGENT_SMITH_TOOL=claude, AGENT_SMITH_TOOL=gemini, AGENT_SMITH_TOOL=codex, or AGENT_SMITH_TOOL=opencode." >&2
	return 1
}

agent_smith_schema_url() {
	case "$1" in
	claude) printf '%s\n' 'https://json.schemastore.org/claude-code-settings.json' ;;
	gemini) printf '%s\n' 'https://raw.githubusercontent.com/google-gemini/gemini-cli/main/schemas/settings.schema.json' ;;
	codex) printf '%s\n' 'https://developers.openai.com/codex/config-schema.json' ;;
	opencode) printf '%s\n' 'https://opencode.ai/config.json' ;;
	*)
		echo "Error: unsupported tool '$1'" >&2
		return 1
		;;
	esac
}

agent_smith_schema_cache_path() {
	case "$1" in
	claude) printf '%s\n' "${HOME}/.config/agent-smith/schemas/claude-code-settings.schema.json" ;;
	gemini) printf '%s\n' "${HOME}/.config/agent-smith/schemas/gemini-cli-settings.schema.json" ;;
	codex) printf '%s\n' "${HOME}/.config/agent-smith/schemas/codex-config.schema.json" ;;
	opencode) printf '%s\n' "${HOME}/.config/agent-smith/schemas/opencode-config.schema.json" ;;
	*)
		echo "Error: unsupported tool '$1'" >&2
		return 1
		;;
	esac
}

agent_smith_schema_metadata_path() {
	case "$1" in
	claude) printf '%s\n' "${HOME}/.config/agent-smith/schemas/claude-code-settings.schema.metadata.json" ;;
	gemini) printf '%s\n' "${HOME}/.config/agent-smith/schemas/gemini-cli-settings.schema.metadata.json" ;;
	codex) printf '%s\n' "${HOME}/.config/agent-smith/schemas/codex-config.schema.metadata.json" ;;
	opencode) printf '%s\n' "${HOME}/.config/agent-smith/schemas/opencode-config.schema.metadata.json" ;;
	*)
		echo "Error: unsupported tool '$1'" >&2
		return 1
		;;
	esac
}

agent_smith_tool_label() {
	case "$1" in
	claude) printf '%s\n' 'Claude Code' ;;
	gemini) printf '%s\n' 'Gemini CLI' ;;
	codex) printf '%s\n' 'Codex' ;;
	opencode) printf '%s\n' 'OpenCode' ;;
	*)
		echo "Error: unsupported tool '$1'" >&2
		return 1
		;;
	esac
}

agent_smith_cli_bin() {
	case "$1" in
	claude) printf '%s\n' "${AGENT_CLI:-claude}" ;;
	gemini) printf '%s\n' "${AGENT_CLI:-gemini}" ;;
	codex) printf '%s\n' "${AGENT_CLI:-codex}" ;;
	opencode) printf '%s\n' "${AGENT_CLI:-opencode}" ;;
	*)
		echo "Error: unsupported tool '$1'" >&2
		return 1
		;;
	esac
}
