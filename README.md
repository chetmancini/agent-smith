# Agent Smith

> "Never send a human to do a machine's job." Agent Smith, *The Matrix* (1999)
>
> [Clip on YouTube](https://www.youtube.com/watch?v=dJ4Bt2xtE9Q)
>
> ![Agent Smith poster](https://github.com/user-attachments/assets/401bb432-7be5-441a-8617-c1d1d2e52fde)

A self-tuning feedback loop plugin for Claude Code and Codex. Collects session
metrics, analyzes patterns, and produces tuning recommendations to continuously
improve agent reliability and autonomy.

Codex support is available now, but it does not yet cover as many features as
the Claude Code plugin. The limiting factor is the current Codex hook surface:
it exposes fewer event types, so some Agent Smith signals remain Claude-only
for now. Metrics are tagged by initiating agent, and analysis should stay
scoped to that agent so Claude findings do not drive Codex config changes or
vice versa.

## How It Works

Agent Smith implements a closed-loop improvement cycle:

```text
┌─────────────────────────────────────────────────────────┐
│  1. COLLECT                                             │
│  Hooks emit metrics on every session:                   │
│  tool failures, permission denials, test loops,         │
│  vague prompts, session lifecycle                       │
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
│  SQL queries produce a local report by default          │
│  LLM analysis is explicit opt-in                        │
│  Generates tuning report with specific suggestions      │
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

## Installation

### Claude Code

```bash
claude --plugin-dir path/to/agent-smith
```

```bash
claude plugin add https://github.com/chetmancini/agent-smith
```

### Codex

Install or symlink the repo so Codex can see [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json) and the plugin-root [hooks.json](hooks.json).

Codex support is intentionally narrower than Claude Code support today. The
plugin is available and usable in Codex, but some metrics and automations still
depend on Claude-specific hook events that Codex does not currently expose.

Agent Smith now keeps both plugin manifests side by side:

- Claude Code: [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json)
- Codex: [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json)

Claude keeps its existing hook registration at [`hooks/hooks.json`](hooks/hooks.json). Codex uses the root-level [`hooks.json`](hooks.json).

## Support Matrix

- Claude Code: full support for session lifecycle, tool failures, permission denials, vague prompts, context compression, edit-triggered test-loop detection, rollup, and analysis.
- Codex: available now, with support for session lifecycle, Bash failure tracking, vague prompt guidance, rollup, and analysis through the Codex plugin manifest and hook shims.
- Codex limitations: the current Codex hook surface does not expose direct equivalents for Claude's `PermissionRequest`, `PostToolUseFailure`, or `PostCompact` signals, so permission-denial metrics, context-compression metrics, and edit-triggered test-loop detection remain Claude-only for now.

## What Gets Collected

| Event | Hook | Trigger |
|-------|------|---------|
| `session_start` | SessionStart | Every session start |
| `session_stop` | Stop | Every session end (with duration) |
| `tool_failure` | PostToolUseFailure | Tool errors (filters expected non-zero exits) |
| `command_failure` | PostToolUseFailure | Bash command failures |
| `permission_denied` | PermissionRequest | Permission denials |
| `clarifying_question` | UserPromptSubmit | Vague/ambiguous prompts detected |
| `test_failure_loop` | PostToolUse | 3+ consecutive test failures |
| `context_compression` | PostCompact | Context compression (auto or manual) |

All events above are appended to `~/.config/agent-smith/events.jsonl` as structured JSONL. The plugin hardens files it creates to user-only permissions.

### Session Cost

Session cost (token usage and estimated USD cost) is calculated during `metrics-rollup.sh`, not during hooks. The session-start hook persists the transcript path, and rollup reads the transcript to aggregate token counts from all assistant turns. Cost is recalculated on each rollup run so mid-session runs capture partial progress and later runs pick up new turns. Results are written directly to the `sessions` table in `rollup.db`.

## Usage

### Automatic

Metrics collection starts immediately when the plugin is loaded. Automatic analysis is off by default; set `AUTO_ANALYZE_ENABLED=1` to allow background report generation once the session threshold is reached.

### Manual analysis

Use the slash command:

```text
/agent-smith:analyze
```

Or run the scripts directly:

```bash
# Process events into SQLite
bash scripts/metrics-rollup.sh

# Generate a local raw report (default, no LLM)
bash scripts/analyze-config.sh --sessions 50

# Generate an LLM-backed report (explicit opt-in)
bash scripts/analyze-config.sh --llm --sessions 50

# Include your local Claude settings snapshot in the LLM prompt (explicit opt-in)
bash scripts/analyze-config.sh --llm --include-settings --sessions 50
```

When `--include-settings` is enabled, Agent Smith redacts obvious secret-bearing
keys such as API keys, tokens, passwords, and client secrets before sending the
settings snapshot to Claude. Non-sensitive settings remain visible so the
analysis can still reason about your current configuration.

### Schema validation

The plugin includes a `validate-schemas` skill that fetches official JSON schemas and validates your settings files. Claude Code or Codex can invoke it when you ask to validate settings or check schemas.

## Configuration

| Environment Variable | Default | Purpose |
|---------------------|---------|---------|
| `AGENT_METRICS_ENABLED` | `1` | Set to `0` to disable all metrics collection |
| `METRICS_DIR` | `~/.config/agent-smith` | Where metrics data is stored (created with private permissions) |
| `ANALYZE_THRESHOLD` | `50` | Sessions required before optional automatic analysis runs |
| `AUTO_ANALYZE_ENABLED` | `0` | Set to `1` to allow background report generation |
| `AUTO_ANALYZE_MODE` | `raw` | `raw` for local-only reports, `llm` to opt into Claude analysis |
| `AUTO_ANALYZE_INCLUDE_SETTINGS` | `0` | Set to `1` to include a redacted `~/.claude/settings*.json` snapshot in automatic LLM prompts |

## Data Location

All data lives in `~/.config/agent-smith/` and is hardened to user-only permissions when the plugin creates it:

```text
~/.config/agent-smith/
├── events.jsonl          # Raw metric events (append-only)
├── rollup.db             # SQLite database (queryable)
├── reports/              # Analysis reports
│   └── 2026-03-27-analysis.md
├── .session_start_ts_*   # Temporary: per-session timing
├── .cost_snapshot_*      # Temporary: per-session cost snapshots
├── .transcript_paths     # Temporary: session→transcript mapping
└── .test_fail_count      # Temporary: consecutive test failures
```

## Prerequisites

- **jq** — JSON processing (ships with Homebrew, `brew install jq`)
- **sqlite3** — Database queries (ships with macOS)
- **claude** CLI — Optional, only required for `--llm` analysis

## Plugin Structure

```text
agent-smith/
├── .claude-plugin/plugin.json    # Claude Code manifest
├── .codex-plugin/plugin.json     # Codex manifest
├── hooks.json                    # Codex hook registration
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
│   └── compact.sh              # Context compression
├── scripts/
│   ├── metrics-rollup.sh         # JSONL → SQLite
│   └── analyze-config.sh         # Metrics → Report
├── skills/
│   ├── analyze-config/SKILL.md   # Analysis skill
│   └── validate-schemas/SKILL.md # Schema validation skill
├── commands/analyze.md           # /agent-smith:analyze
└── tests/lib/metrics.bats        # BATS test suite
```

## Running Tests

```bash
# Install bats (if needed)
brew install bats-core

# Run tests
bats tests/lib/metrics.bats tests/hooks/security.bats
```

Or use the Makefile:

```bash
make test
```

## Linting

```bash
# Install local lint dependencies if needed
brew install jq shellcheck shfmt
npm install --global markdownlint-cli

# Run the same lint suite as CI
make lint
```

## Claude Entrypoints

The Makefile exposes direct Claude entrypoints that load this repo as a plugin:

```bash
# Run the analyze-config skill through Claude
make claude-analyze

# Run the validate-schemas skill through Claude
make claude-validate-schemas

# Run validate-schemas, then analyze-config, as one loop
make claude-loop
```

You can override the session window for the analysis targets:

```bash
make claude-analyze SESSIONS=100
make claude-loop SESSIONS=100
```

## License

MIT
