# Analyze Config

Analyze session metrics and produce tuning recommendations for agent configurations.

## Process

1. **Run rollup**: Execute `bash "${CLAUDE_PLUGIN_ROOT}/scripts/metrics-rollup.sh"` to ensure the SQLite database is current
2. **Run local analysis first**: Execute `bash "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-config.sh" --sessions 50 --tool claude` (adjust session count as needed)
3. **Read the report**: Read the generated report from `~/.config/agent-smith/reports/`
4. **Only use LLM analysis with explicit approval**: If the user wants AI-generated tuning suggestions, execute `bash "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-config.sh" --llm --sessions 50 --tool claude`. Only add `--include-settings` if the user explicitly approves sending their local Claude settings snapshot.
5. **Categorize suggestions**: Split findings into auto-apply (safe) and approval-required (structural)
6. **Apply safe changes**: For wording improvements in custom commands and CLAUDE.md files, apply directly — these are non-breaking prompt refinements
7. **Present structural changes**: For permission changes, hook timeout adjustments, hook additions, or settings modifications — show the user a summary table with the proposed change, risk level, and rationale. Wait for explicit approval before applying
8. **Validate**: After any changes, verify settings files are still valid JSON

## Raw Data Mode

Local raw analysis is the default: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/analyze-config.sh" --sessions 50 --tool claude`
