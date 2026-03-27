---
name: analyze-config
description: Analyze Claude Code session metrics and produce tuning recommendations. Use when asked to analyze metrics, tune config, review agent performance, generate a performance report, or optimize Claude Code settings.
---

# Analyze Config

Analyze session metrics and produce tuning recommendations for Claude Code configuration.

## Process

1. **Run rollup**: Execute `bash "${CLAUDE_PLUGIN_ROOT}/scripts/metrics-rollup.sh"` to ensure the SQLite database at `~/.config/agent-smith/rollup.db` is current
2. **Run local analysis first**: Execute `bash "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-config.sh" --sessions 50` (adjust session count as needed)
3. **Read the report**: Read the generated report from `~/.config/agent-smith/reports/`
4. **Only use LLM analysis with explicit approval**: If the user wants AI-generated tuning suggestions, execute `bash "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-config.sh" --llm --sessions 50`. Only add `--include-settings` if the user explicitly approves sending their local Claude settings snapshot.
5. **Categorize suggestions**: Split findings into auto-apply (safe) and approval-required (structural)
6. **Apply safe changes**: For wording improvements in custom commands (`~/.claude/commands/*.md`, `.claude/commands/*.md`) and CLAUDE.md instructions, apply directly — these are non-breaking prompt refinements
7. **Present structural changes**: For permission changes, hook timeout adjustments, hook additions, or settings modifications — show the user a summary table with the proposed change, risk level, and rationale. Wait for explicit approval before applying
8. **Validate**: After any changes, verify the settings.json is still valid JSON

## What to Look For

- **High tool failure rates** -> suggest timeout increases or prompt improvements
- **Frequent permission denials** -> suggest additions to `permissions.allow` in settings.json
- **Test failure loops** -> suggest better test strategy wording in commands or CLAUDE.md
- **Clarifying question patterns** -> suggest more prescriptive wording in the commands that triggered vague prompts
- **Session stop reasons** (e.g. frequent `max_tokens`) -> suggest model or effort level adjustments

## Auto-Apply Rules

**Safe to apply directly (non-breaking):**

- Wording improvements in `~/.claude/commands/*.md` or `.claude/commands/*.md`
- Wording improvements in CLAUDE.md files
- Adding clarifying instructions to existing prompt text

**Requires user approval:**

- Adding items to `permissions.allow` in settings.json
- Changing hook timeouts or matchers in settings.json
- Adding or removing hooks
- Modifying model or effort level settings
- Changes to hook shell scripts

## Raw Data Mode

Local raw analysis is the default: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-config.sh" --sessions 50`
