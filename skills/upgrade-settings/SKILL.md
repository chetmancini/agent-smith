---
name: upgrade-settings
description: Refresh the latest schema for the active agent, compare it against the installed config, and produce an implementation plan for new features to adopt or deprecated settings to remove. Use when asked to review schema updates, upgrade settings, leverage new schema features, deprecate old settings, or turn schema drift into an actionable implementation plan.
---

# Upgrade Settings

Refresh the active agent schema, inspect the installed config against that schema, and produce an implementation plan for adopting new features and removing deprecated settings.

## Resolve Agent Smith Root

Before running any scripts, resolve `AGENT_SMITH_ROOT`:

- If the current repo already contains `scripts/refresh-schemas.sh`, `scripts/validate-agent-config.sh`, and one of `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `opencode-plugin/package.json`, or `.pi/extensions/agent-smith/index.ts`, use the current repo root.
- Otherwise, locate the installed Agent Smith plugin root first, then run all scripts from that path.

## Process

1. Resolve the initiating agent: use `claude` inside Claude Code, `codex` inside Codex, `opencode` inside OpenCode, and `pi` inside Pi. Unless the user explicitly asks for cross-agent planning, only inspect that agent family.
2. Export `AGENT_SMITH_TOOL=<initiating-agent>` before invoking the helper scripts so they do not guess when multiple agents are installed.
3. Refresh the latest schema with `bash "${AGENT_SMITH_ROOT}/scripts/refresh-schemas.sh" --tool <initiating-agent>`.
4. Validate the installed config with `bash "${AGENT_SMITH_ROOT}/scripts/validate-agent-config.sh" --tool <initiating-agent> --refresh` and capture the output.
5. Read the cached schema file from `~/.config/agent-smith/schemas/` for the initiating agent. Use the metadata file beside it to mention when the schema was fetched.
6. Read the initiating agent's installed config file:
   - Claude Code: `~/.claude/settings.json`, `~/.claude/settings.local.json`, and repo-local `.claude/settings.json` when present
   - Codex: `~/.codex/config.toml`
   - OpenCode: `~/.config/opencode/opencode.json`
   - Pi: `~/.pi/agent/settings.json` and repo-local `.pi/settings.json` when present
7. Compare the current config against the latest schema and focus on:
   - new top-level keys or subkeys not currently configured
   - new enum values for fields the user already sets
   - deprecated keys still present in the config
   - unknown keys that may now be removed or misspelled
8. Use the schema descriptions and defaults to decide whether a new feature is worth adopting now versus simply worth tracking.
9. Produce an implementation plan, not just a diff. The plan should separate:
   - adopt now
   - deprecate or remove
   - investigate later
10. For each plan item, include exact files, the schema key involved, why it matters, and the smallest safe implementation step.

## Output Contract

Produce a report in this format:

```markdown
# Settings Upgrade Plan -- <date>

## Summary
2-3 sentences on the most important schema-driven updates.

## New Features Worth Adopting
- **Key**: schema path
- **Config file**: exact file to change
- **Why now**: why this is useful given the existing config
- **Implementation step**: smallest safe change

## Deprecations and Removals
- **Key**: schema path
- **Config file**: exact file to change
- **Current state**: how it is configured today
- **Migration**: remove, rename, or replace

## Investigate Later
- items that are newly available but not clearly justified yet

## Implementation Plan
1. Ordered steps with exact files to edit
2. Validation command(s) to rerun
3. Risks or follow-up checks
```

## Guardrails

- Keep the plan scoped to the initiating agent unless the user explicitly asks for a cross-agent comparison.
- Do not suggest Claude-specific settings for Codex, OpenCode, or Pi, and do not suggest agent-specific settings outside the initiating agent family.
- Prefer schema-backed recommendations over speculation.
- If a key is merely available but not obviously useful from the current config, put it under `Investigate Later` instead of forcing an adoption recommendation.
