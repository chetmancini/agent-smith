# Analyze Config Fast

Analyze session metrics quickly using the local raw report only.

## Process

1. **Resolve the plugin root**: Use the current repo root when it contains `scripts/analyze-config.sh`; otherwise resolve the installed Agent Smith plugin root and refer to it as `AGENT_SMITH_ROOT`
2. **Resolve the initiating agent**: use `claude` when running inside Claude Code, `codex` when running inside Codex, `opencode` when running inside OpenCode, and `pi` when running inside Pi. Do not mix them unless the user explicitly asks for a cross-agent report
3. **Run rollup**: Execute `bash "${AGENT_SMITH_ROOT}/scripts/metrics-rollup.sh"` to ensure the SQLite database is current
4. **Run fast local analysis**: Execute `bash "${AGENT_SMITH_ROOT}/scripts/analyze-config.sh" --sessions 50 --tool <initiating-agent>` (adjust the session count as needed)
5. **Read the report**: Read the generated report from `~/.config/agent-smith/reports/`
6. **Categorize suggestions**: Split findings into auto-apply (safe) and approval-required (structural)
7. **Apply safe changes**: For wording improvements in custom commands and the initiating agent's instruction files, apply directly because these are non-breaking prompt refinements
8. **Present structural changes**: For permission changes, hook timeout adjustments, hook additions, or settings modifications, show the user a summary table with the proposed change, risk level, and rationale. Wait for explicit approval before applying
9. **Validate**: After any changes, verify settings files are still valid JSON or TOML for the initiating agent

## Notes

This command intentionally skips `--llm`. Use `/agent-smith:analyze` when you want the smarter agent-backed analysis path.
