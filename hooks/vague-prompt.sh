#!/bin/bash
# UserPromptSubmit hook: detect vague prompts and inject a clarification reminder
# Writes to stdout to append context to the user message; exit 0 always (never blocks)

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
prompt=$(echo "$input" | jq -r '.prompt // empty')

if [ -z "$prompt" ]; then
	exit 0
fi

# Trim leading/trailing whitespace
trimmed=$(echo "$prompt" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
word_count=$(echo "$trimmed" | wc -w | tr -d ' ')

# Short-circuit for prompts that are clearly specific:
# - More than 10 words
# - Reference a file path, code block, env var, or common extension
if [ "$word_count" -gt 10 ]; then
	exit 0
fi

if echo "$trimmed" | grep -qE '(/[a-zA-Z]|```|\.ts|\.tsx|\.py|\.go|\.rs|\.rb|\.js|\.jsx|\$[A-Z_]+|https?://)'; then
	exit 0
fi

# Vague imperative phrases with no concrete noun
VAGUE_PATTERNS=(
	'^fix (it|this|that|the bug|the issue|the problem|the error|things)\.?$'
	'^(make it|get it) (work|working|faster|better|right)\.?$'
	'^(clean( up)?|cleanup) (it|this|the code|up)\.?$'
	'^(improve|update|refactor|rewrite|optimize) (it|this|the code|this code)\.?$'
	'^help( me)?\.?$'
	'^(do|undo) (it|that|this)\.?$'
	'^(add|remove|delete) (it|this|that)\.?$'
	'^make (it|this|that) (better|good|work|cleaner|nicer|faster)\.?$'
	'^(debug|test|check|review|run) (it|this|that)\.?$'
	'^(continue|go ahead|proceed|keep going)\.?$'
	'^(try again|retry|redo)\.?$'
)

is_vague=0
for pattern in "${VAGUE_PATTERNS[@]}"; do
	if echo "$trimmed" | grep -qiE "$pattern"; then
		is_vague=1
		break
	fi
done

# Also flag very short action-only prompts (<=4 words starting with a verb, no file/symbol)
if [ "$is_vague" -eq 0 ] && [ "$word_count" -le 4 ]; then
	if echo "$trimmed" | grep -qiE '^(fix|update|improve|refactor|rewrite|clean|debug|check|test|review|add|remove|change|edit|run|build|deploy) '; then
		is_vague=1
	fi
fi

if [ "$is_vague" -eq 1 ]; then
	note='[System note: The request above is brief and may be ambiguous. Before making changes, ask one short clarifying question to confirm the target file, specific behavior, or desired outcome unless the prior conversation makes intent obvious.]'

	if [ "${AGENT_SMITH_TOOL:-claude}" = "codex" ]; then
		jq -n --arg note "$note" '{
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: $note
			}
		}'
	else
		# Append context to the user message (stdout is injected by Claude Code)
		printf '\n%s\n' "$note"
	fi

	metrics_on_clarifying_question "$trimmed"
fi

exit 0
