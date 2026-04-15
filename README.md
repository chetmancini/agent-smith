# Agent Smith

> "Never send a human to do a machine's job." Agent Smith, *The Matrix* (1999)
>
> [Clip on YouTube](https://www.youtube.com/watch?v=dJ4Bt2xtE9Q)
>
> ![Agent Smith poster](https://github.com/user-attachments/assets/401bb432-7be5-441a-8617-c1d1d2e52fde)

A self-tuning feedback loop plugin for Claude Code, Codex, and OpenCode.
Collects session metrics, analyzes patterns, and produces tuning
recommendations to continuously improve agent reliability and autonomy.

## Quick Start

### Installation

**Claude Code:**

```bash
claude plugins marketplace add chetmancini/agent-smith
claude plugins install agent-smith@agent-smith
# local development
claude --plugin-dir path/to/agent-smith
```

**Codex:** For local development, keep this repo checked out locally and run Agent Smith through the Codex helpers in this checkout. Those helpers invoke `codex exec -C` so Codex loads [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json) directly from the repo.

Enable Codex hooks once in `~/.codex/config.toml` if you want automatic metrics collection from Codex sessions:

```toml
[features]
codex_hooks = true
```

Codex currently discovers repo-local hooks from [`.codex/hooks.json`](.codex/hooks.json), so keep this checkout trusted and launch Codex from anywhere inside the repo when you want the automatic hook flow.

```bash
make codex-analyze
make codex-validate-schemas
make codex-upgrade-settings
```

If you publish Agent Smith through your own Codex plugin source, point that source at this repo root so Codex can read [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json). For hook-based metrics in a checkout, Codex uses the repo-local [`.codex/hooks.json`](.codex/hooks.json) file.

### OpenCode

OpenCode uses the native TypeScript plugin:

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["agent-smith-opencode"]
}
```

Or from a local clone:

```json
{
  "plugin": ["./path/to/agent-smith/opencode-plugin"]
}
```

This is the supported OpenCode integration path and provides the full OpenCode-native telemetry surface.

### Prerequisites

- **jq** — `brew install jq`
- **sqlite3** — ships with macOS
- **python3** — for Codex TOML parsing during schema validation

### Usage

Claude Code starts collecting metrics as soon as its hook manifest loads. OpenCode starts collecting metrics when the native `agent-smith-opencode` plugin loads. In Codex, the skill and helper workflow works as soon as the plugin loads, and automatic hook-based metrics collection works when `features.codex_hooks = true` and the repo-local [`.codex/hooks.json`](.codex/hooks.json) file is available in a trusted project.

**Slash command** (inside any supported agent):
```text
/agent-smith:analyze
/agent-smith:analyze-fast
/agent-smith:upgrade-settings
```

**Manual scripts:**
```bash
bash scripts/metrics-rollup.sh                          # Process events into SQLite
bash scripts/analyze-config.sh --sessions 50             # Local raw report (default)
bash scripts/analyze-config.sh --llm --sessions 50       # Agent-backed report for the active tool
bash scripts/analyze-config.sh --llm --include-settings   # Include redacted settings snapshot
```

**Schema validation** (scoped to the calling agent):
```bash
bash scripts/refresh-schemas.sh
bash scripts/validate-agent-config.sh --refresh
```

**Schema upgrade planning** (scoped to the calling agent):
```bash
make agent-upgrade-settings TOOL=codex
```

Or ask your agent to use the `validate-schemas`, `upgrade-settings`, or `analyze-config` skills directly.

### Configuration

| Environment Variable | Default | Purpose |
|---------------------|---------|---------|
| `AGENT_METRICS_ENABLED` | `1` | Set to `0` to disable all metrics collection |
| `METRICS_DIR` | `~/.config/agent-smith` | Where metrics data is stored |
| `ANALYZE_THRESHOLD` | `50` | Sessions required before optional automatic analysis |
| `AUTO_ANALYZE_ENABLED` | `0` | Set to `1` for background report generation |
| `AUTO_ANALYZE_MODE` | `raw` | `raw` for local-only reports, `llm` for agent-backed analysis |
| `AUTO_ANALYZE_INCLUDE_SETTINGS` | `0` | Set to `1` to include redacted settings in LLM prompts |

## Support Matrix

| Feature                            | Claude Code | Codex | OpenCode |
|------------------------------------|:-----------:|:-----:|:--------:|
| Session lifecycle                  | ✓           | ✓     | ✓        |
| Bash failure tracking              | ✓           | ✓     | ✓        |
| Vague prompt guidance              | ✓           | ✓     | ✓        |
| Rollup & analysis                  | ✓           | ✓     | ✓        |
| Schema validation                  | ✓           | ✓     | ✓        |
| Tool failures                      | ✓           |       | ✓        |
| Permission denials                 | ✓           |       | ✓        |
| Permission grants                  |             |       | ✓        |
| Session errors                     |             |       | ✓        |
| File-edited telemetry              |             |       | ✓        |
| Context compression                | ✓           |       | ✓        |
| Edit-triggered test-loop detection | ✓           |       | ✓        |

Schema validation and upgrade planning are available for all three agents. As of April 15, 2026, Codex still exposes a narrower hook surface than Claude Code, and Agent Smith only sees `Bash` in current Codex tool-scoped hooks. OpenCode reaches the richer cells above through the native npm plugin. Metrics are tagged by initiating agent, and analysis stays scoped per-agent.

## How It Works

```text
┌─────────────────────────────────────────────────────────┐
│  1. COLLECT                                             │
│  Hooks emit metrics supported by the host agent:        │
│  session lifecycle, vague prompts, bash failures,       │
│  and, where available, tool failures,                   │
│  permission denials, test loops, compact events         │
│  → ~/.config/agent-smith/events.jsonl                   │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  2. ROLLUP                                              │
│  JSONL events → SQLite database                         │
│  Incremental, resumable, auto-rotating                  │
│  → ~/.config/agent-smith/rollup.db                      │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  3. ANALYZE                                             │
│  CLI runs default to a local raw report                 │
│  /agent-smith:analyze defaults to agent-backed LLM      │
│  → ~/.config/agent-smith/reports/<date>-analysis.md     │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  4. APPLY                                               │
│  Auto-apply safe changes (prompt wording)               │
│  Present structural changes for approval                │
│  → settings files, commands, and agent instructions     │
└─────────────────────────────────────────────────────────┘
```

Automatic analysis is disabled by default. You can opt in to background raw reports, or run analysis manually anytime. LLM-backed analysis is never run automatically unless you explicitly enable it.

When `--include-settings` is enabled, Agent Smith redacts obvious secret-bearing keys (API keys, tokens, passwords, client secrets) before sending the settings snapshot to the active agent.

### What Gets Collected

| Event | Hook | Trigger |
|-------|------|---------|
| `session_start` | SessionStart | Every session start |
| `session_stop` | Stop | Every session end (with duration) |
| `session_error` | OpenCode native plugin: `session.error` | OpenCode session crashes |
| `tool_failure` | Claude: PostToolUseFailure; OpenCode plugin: `tool.execute.after` | Tool errors (filters expected non-zero exits) |
| `command_failure` | Claude: PostToolUseFailure; Codex/OpenCode: PostToolUse | Bash command failures |
| `permission_denied` | Claude: PermissionRequest; OpenCode plugin: `permission.replied` | Permission denials |
| `permission_granted` | OpenCode plugin: `permission.replied` | Permission grants |
| `file_edited` | OpenCode plugin: `file.edited` | File edit telemetry for compaction/test context |
| `clarifying_question` | UserPromptSubmit | Vague/ambiguous prompts detected |
| `test_failure_loop` | Claude: PostToolUse; OpenCode plugin: `tool.execute.after` | 3+ consecutive test failures after edits |
| `context_compression` | Claude: PostCompact; OpenCode plugin: `session.compacted` and `experimental.session.compacting` | Context compression |

Not every host agent exposes every hook above. Today Codex supports session lifecycle, vague prompt guidance, Bash failure tracking, rollup/analysis, and schema validation. Claude Code also exposes tool failures, permission denials, edit-triggered test loops, compact events, stop failures, tool attempts, and subagent lifecycle. OpenCode reaches its richer metric set through the native plugin.

When the host includes structured Bash failure payloads, Agent Smith records the command, exit code, stderr/stdout snippets, and turn or tool-use ids alongside the failure event to keep `events.jsonl` actionable.

All events are appended to `~/.config/agent-smith/events.jsonl` as structured JSONL with user-only file permissions.

### Session Cost

Token usage and estimated USD cost are calculated during `metrics-rollup.sh`, not during hooks. The session-start hook persists the transcript path, and rollup reads transcripts to aggregate token counts. Cost is recalculated on each rollup run so mid-session runs capture partial progress. Results are written to the `sessions` table in `rollup.db`.

### Data Location

```text
~/.config/agent-smith/
├── events.jsonl          # Raw metric events (append-only)
├── rollup.db             # SQLite database (queryable)
├── reports/              # Analysis reports
│   └── 2026-03-27-analysis.md
├── .session_start_ts_*   # Temporary: per-session timing
├── .cost_snapshot_*      # Temporary: per-session cost snapshots
├── .transcript_paths     # Temporary: session→transcript mapping
└── .test_fail_count_*    # Temporary: per-session consecutive test failures
```

## Development

### Plugin Structure

```text
agent-smith/
├── .claude-plugin/plugin.json    # Claude Code manifest
├── .codex-plugin/plugin.json     # Codex manifest
├── .codex/
│   └── hooks.json                # Codex repo-local hook registration
├── hooks.json                    # Legacy Codex hook copy kept in sync with .codex/hooks.json
├── assets/
│   └── agent-smith.svg           # Codex plugin icon
├── hooks/
│   ├── hooks.json                # Claude Code hook registration
│   ├── lib/metrics.sh            # Core metrics library
│   ├── lib/common.sh             # Logging utilities
│   ├── session-start.sh          # Session lifecycle
│   ├── session-stop.sh
│   ├── tool-failure.sh           # Error tracking
│   ├── permission-denied.sh
│   ├── vague-prompt.sh           # Prompt quality
│   ├── test-result.sh            # Test loop detection
│   ├── analyze-trigger.sh        # Auto-trigger analysis
│   └── compact.sh                # Context compression
├── scripts/
│   ├── metrics-rollup.sh         # JSONL → SQLite
│   ├── analyze-config.sh         # Metrics → Report
│   ├── refresh-schemas.sh        # Refresh current-agent schema cache
│   ├── validate-agent-config.sh  # Validate current-agent config files
│   └── lib/agent-tool.sh         # Current-agent detection helpers
├── skills/
│   ├── analyze-config/SKILL.md   # Analysis skill
│   ├── upgrade-settings/SKILL.md # Schema-driven settings upgrade skill
│   └── validate-schemas/SKILL.md # Schema validation skill
├── commands/analyze.md           # /agent-smith:analyze
├── commands/analyze-fast.md      # /agent-smith:analyze-fast
├── commands/upgrade-settings.md  # /agent-smith:upgrade-settings
└── tests/lib/metrics.bats        # BATS test suite
```

### Hook Registration

- Claude Code: [`hooks/hooks.json`](hooks/hooks.json)
- Codex: repo-local [`.codex/hooks.json`](.codex/hooks.json)
- OpenCode: native plugin entrypoint at [`opencode-plugin/src/index.ts`](opencode-plugin/src/index.ts)

### Running Tests

```bash
brew install bats-core   # if needed
make test
# or
bats --print-output-on-failure \
  tests/lib/metrics.bats \
  tests/hooks/security.bats \
  tests/hooks/integration.bats \
  tests/scripts/schema_tools.bats
```

### Linting

```bash
brew install jq shellcheck shfmt
npm install --global markdownlint-cli
make lint
```

### Releases

Agent Smith now uses [`VERSION`](VERSION) as the single release source of truth.

```bash
# one-command release: bump, commit, tag, push, and publish notes
make release VERSION=1.0.1
```

If you edit [`VERSION`](VERSION) by hand, run `make sync-version` to push that value into the Claude and Codex manifests plus [`opencode-plugin/package.json`](opencode-plugin/package.json).

`make release` requires a clean git worktree and an authenticated `gh` session. If you only want to bump versioned release files without publishing yet, use `make set-version VERSION=1.0.1`.

### Makefile Helpers

```bash
# Run skills through any agent
make agent-analyze TOOL=claude
make agent-validate-schemas TOOL=codex
make agent-upgrade-settings TOOL=codex
make agent-loop TOOL=opencode        # validate-schemas then analyze-config

# Ergonomic aliases
make claude-analyze
make codex-validate-schemas
make codex-upgrade-settings
make opencode-loop

# Override session window
make agent-analyze TOOL=codex SESSIONS=100

# Local schema tools
make refresh-schemas
make validate-agent-config
```

`TOOL=claude`, `TOOL=codex`, and `TOOL=opencode` are accepted anywhere this repo exposes a tool selector.

## License

MIT
