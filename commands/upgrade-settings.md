# Upgrade Settings

Refresh the latest schema for the active agent, compare it against the current configuration, and produce an implementation plan for new features to adopt and deprecated settings to remove.

## Process

1. **Resolve the plugin root**: Use the current repo root when it contains `scripts/refresh-schemas.sh` and `scripts/validate-agent-config.sh`; otherwise resolve the installed Agent Smith plugin root and refer to it as `AGENT_SMITH_ROOT`
2. **Resolve the initiating agent**: use `claude` when running inside Claude Code, `codex` when running inside Codex, `opencode` when running inside OpenCode, and `pi` when running inside Pi. Do not mix them unless the user explicitly asks for a cross-agent plan
3. **Refresh the schema**: Execute `bash "${AGENT_SMITH_ROOT}/scripts/refresh-schemas.sh" --tool <initiating-agent>`
4. **Validate the current config**: Execute `bash "${AGENT_SMITH_ROOT}/scripts/validate-agent-config.sh" --tool <initiating-agent> --refresh`
5. **Compare schema and config**: Identify new features worth adopting, deprecated or unknown settings to remove, and lower-priority capabilities worth investigating later
6. **Produce a plan**: Emit an ordered implementation plan with exact files, the relevant schema keys, validation commands, and any follow-up risks

## Output

Structure the result as:

- Summary
- New Features Worth Adopting
- Deprecations and Removals
- Investigate Later
- Implementation Plan
