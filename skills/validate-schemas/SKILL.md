---
name: validate-schemas
description: Validate the installed agent config against the latest schema, surface new features to adopt, and flag deprecated config to remove. Use when asked to validate settings, check schema, update schemas, verify configuration files, or review config for new/deprecated options.
---

# Validate Schemas

Refresh the active agent's schema cache, validate that agent's installed config files, discover new features, and flag deprecated config for removal.

## Schema Sources

| Tool | Schema URL | Config File |
|------|-----------|-------------|
| Claude Code | `https://json.schemastore.org/claude-code-settings.json` | `~/.claude/settings.json`, `.claude/settings.json` |
| Codex | `https://developers.openai.com/codex/config-schema.json` | `~/.codex/config.toml` |
| OpenCode | `https://opencode.ai/config.json` | `~/.config/opencode/opencode.json` |
| Pi | `bundled://schemas/pi-settings.schema.json` | `~/.pi/agent/settings.json`, `.pi/settings.json` |
| Kilo Code | `https://app.kilo.ai/config.json` | `~/.config/opencode/opencode.json` |

## Process

### 1. Resolve Agent Smith Root and initiating agent

Before running any scripts, resolve `AGENT_SMITH_ROOT`:

- If the current repo already contains `scripts/refresh-schemas.sh` and `scripts/validate-agent-config.sh` plus `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `opencode-plugin/package.json`, or `.pi/extensions/agent-smith/index.ts`, use the current repo root.
- Otherwise, locate the installed Agent Smith plugin root first, then run all scripts from that path.

Resolve the initiating agent:

- Use `claude` when running inside Claude Code, `codex` when running inside Codex, `opencode` when running inside OpenCode, and `pi` when running inside Pi.
- Unless the user explicitly asks for cross-agent validation, only inspect the initiating agent's config family.
- Export `AGENT_SMITH_TOOL=<initiating-agent>` before running the helper scripts so they do not guess when both tools are installed.

### 2. Refresh the current agent schema

Use the helper script first. It refreshes only the initiating agent's schema cache and records fetch metadata.

```bash
AGENT_SMITH_TOOL=claude bash "${AGENT_SMITH_ROOT}/scripts/refresh-schemas.sh"
```text

For Codex, run the same command with `AGENT_SMITH_TOOL=codex`. For Pi, run it with `AGENT_SMITH_TOOL=pi`; Agent Smith uses the bundled Pi schema snapshot because Pi does not currently publish an official JSON schema.

### 3. Validate the installed config files

Run the helper script next:

```bash
AGENT_SMITH_TOOL=claude bash "${AGENT_SMITH_ROOT}/scripts/validate-agent-config.sh" --refresh
```text

The helper script:

- validates only the initiating agent's installed config files
- parses Codex TOML via `python3` before validation
- uses `ajv` when it is already installed locally
- otherwise falls back to parse checks plus a schema-diff summary of unknown, deprecated, and currently-unused top-level keys

**With AJV** (preferred, if already installed):
```bash
# Check if ajv is available
ajv --help 2>/dev/null

# Validate Claude Code settings (Draft 7)
ajv validate -s schema.json -d settings.json --spec=draft7

# Validate Codex config after converting TOML to JSON (Draft 2020-12)
ajv validate -s schema.json -d config.json --spec=draft2020
```text

**Manual validation** (fallback): If AJV is not available or the helper reports a schema-diff fallback, read the cached schema and the initiating agent's config files. Check:
- All required fields are present
- Field types match schema definitions
- Enum values are within allowed sets
- No unknown top-level keys (if `additionalProperties: false`)

For each validation error, show the JSON path, expected type/value, and actual value. Suggest the fix (e.g., "Change `effortLevel` from `'max'` to `'high'` -- allowed values are: low, medium, high").

### 4. Discover new features (schema diff)

Compare the schema's defined properties against the user's current config to find properties the user isn't using yet. This is the key integration point with analyze-config: schema validation finds what's *available*, and metrics analysis determines what's *worth adopting*.

**What to look for:**

- **New top-level properties** in the schema that aren't in the user's config
- **New enum values** added to existing properties (e.g., a new model option, a new effort level)
- **New sub-properties** in objects the user already configures (e.g., new hook event types, new permission categories)
- **Properties with meaningful defaults** that the user might want to explicitly set

**How to report:**

For each new feature found, report:
- **Property**: JSON path (e.g., `permissions.allow`)
- **Type**: what it is (new property, new enum value, new sub-property)
- **Schema description**: the description from the schema, if present
- **Default**: the default value, if specified
- **Recommendation**: whether this is likely useful based on the user's existing config patterns

Group findings by relevance:
1. **Likely useful** -- properties related to features the user already partially configures (e.g., user has `permissions` but not `permissions.deny`)
2. **Worth knowing about** -- new capabilities that may not be immediately needed
3. **Informational** -- properties that are fine to leave at defaults

### 5. Detect deprecated and removed config

Check for properties in the user's config that are NOT in the schema. These fall into two categories:

**Deprecated properties** (in the schema with `deprecated: true`):
- Report the property, its deprecation notice, and what replaced it
- Suggest the migration path (e.g., "Replace `apiKey` with `auth.token`")

**Unknown properties** (not in the schema at all):
- These may be removed features, typos, or custom extensions
- Report them with a recommendation to verify intent
- If the schema has `additionalProperties: false`, flag as errors
- If the schema allows additional properties, flag as warnings

**How to report:**

For each deprecated/unknown property:
- **Property**: JSON path
- **Status**: deprecated (with replacement) or unknown
- **Current value**: what the user has set
- **Action**: remove, migrate to new property, or verify intent

### 6. Generate combined report

Produce a single report with all findings:

```markdown
# Schema Validation Report -- <date>

## Validation Results
- <tool>: <valid/N errors>

## Validation Errors
(if any -- JSON path, expected, actual, fix)

## New Features Available
### Likely Useful
- ...
### Worth Knowing About
- ...

## Deprecated/Unknown Config
### Migrate
- ...
### Remove
- ...
### Verify
- ...

## Schema Versions
- <tool>: fetched <date>, <N> properties defined
```text

## Integration with analyze-config

These skills form a feedback loop:

```text
validate-schemas                    analyze-config
─────────────────                   ──────────────
Schema says feature X exists   →   Metrics show pattern that X would fix
Config has deprecated prop Y   →   Tuning report suggests removing Y
New enum value Z available     →   Session outcomes suggest trying Z
```

**When running both skills together:**

1. Run validate-schemas first to refresh and validate the initiating agent's schema/config pair
2. Run analyze-config to get metrics-based suggestions
3. Cross-reference: if validate-schemas found a new feature AND analyze-config's metrics show a pattern that feature addresses, elevate it to a strong recommendation
4. If analyze-config suggests a setting change, validate-schemas confirms the value is valid in the current schema
5. Deprecated config flagged by validate-schemas that also shows zero metrics impact should be prioritized for removal

**Example cross-references:**
- validate-schemas finds `permissions.deny` is available → analyze-config shows repeated permission denials for a specific tool → recommend configuring `permissions.deny` for that tool
- validate-schemas flags `model: "opus"` as deprecated → recommend the current valid model identifier from the schema's enum
- validate-schemas finds a new hook event type → analyze-config shows high failure rates for that category → recommend adding a hook for it

## Keeping Schemas Up to Date

Refresh only the initiating agent schema per run:
```bash
AGENT_SMITH_TOOL=claude bash "${AGENT_SMITH_ROOT}/scripts/refresh-schemas.sh"
```

## When to Validate

- After modifying any settings.json file
- After applying tuning suggestions from the analyze-config skill
- When troubleshooting configuration issues
- Periodically, to catch schema drift after tool updates
- When a new version of Claude Code, Codex, OpenCode, or Pi is released
