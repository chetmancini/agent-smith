---
name: analyze-config
description: Analyze Agent Smith session metrics and produce tuning recommendations for Claude Code, Codex, or OpenCode. Use when asked to analyze metrics, tune config, review agent performance, generate a performance report, or optimize agent settings.
---

# Analyze Config

Analyze session metrics and produce tuning recommendations for Claude Code, Codex, or OpenCode configuration.

## Resolve Agent Smith Root

Before running any scripts, resolve `AGENT_SMITH_ROOT`:

- If the current repo already contains `scripts/analyze-config.sh` plus `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, or `opencode-plugin/package.json`, use the current repo root.
- Otherwise, locate the installed Agent Smith plugin root first, then run all scripts from that path.

## Process

1. **Resolve the initiating agent**: use `claude` when running inside Claude Code, `codex` when running inside Codex, and `opencode` when running inside OpenCode. Do not mix them unless the user explicitly asks for a cross-agent report.
2. **Run rollup**: Execute `bash "${AGENT_SMITH_ROOT}/scripts/metrics-rollup.sh"` to ensure the SQLite database at `~/.config/agent-smith/rollup.db` is current
3. **Run local analysis first**: Execute `bash "${AGENT_SMITH_ROOT}/scripts/analyze-config.sh" --sessions 50 --tool <initiating-agent>` (adjust session count as needed)
4. **Read the report**: Read the generated report from `~/.config/agent-smith/reports/`
5. **Only use LLM analysis with explicit approval**: If the user wants AI-generated tuning suggestions, execute `bash "${AGENT_SMITH_ROOT}/scripts/analyze-config.sh" --llm --sessions 50 --tool <initiating-agent>`. Only add `--include-settings` if the user explicitly approves sending the relevant local settings snapshot.
6. **Categorize suggestions**: Split findings into auto-apply (safe) and approval-required (structural)
7. **Apply safe changes**: For wording improvements in the initiating agent's prompt/instruction files, apply directly — these are non-breaking prompt refinements
8. **Present structural changes**: For permission changes, hook timeout adjustments, hook additions, or settings modifications — show the user a summary table with the proposed change, risk level, and rationale. Wait for explicit approval before applying
9. **Validate**: After any changes, verify the relevant config file still parses

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

Local raw analysis is the default: `bash "${AGENT_SMITH_ROOT}/scripts/analyze-config.sh" --sessions 50 --tool <initiating-agent>`
