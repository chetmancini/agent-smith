# Agent Smith

> "Never send a human to do a machine's job." Agent Smith, *The Matrix* (1999)
>
> [Clip on YouTube](https://www.youtube.com/watch?v=dJ4Bt2xtE9Q)

A self-tuning feedback loop plugin for Claude Code. Collects session metrics, analyzes patterns, and produces tuning recommendations to continuously improve agent reliability and autonomy.

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
│  Claude LLM analysis is explicit opt-in                 │
│  Generates tuning report with specific suggestions      │
│  → ~/.config/agent-smith/reports/<date>-analysis.md     │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  4. APPLY                                               │
│  Auto-apply safe changes (prompt wording)               │
│  Present structural changes for approval                │
│  → settings.json, commands/*.md, CLAUDE.md              │
└─────────────────────────────────────────────────────────┘
```

Automatic analysis is disabled by default. You can opt in to background raw reports, or run analysis manually anytime. LLM-backed analysis is never run automatically unless you explicitly enable it.

## Installation

### Local (development)

```bash
claude --plugin-dir path/to/agent-smith
```

### From a Git repo

```bash
claude plugin add https://github.com/chetmancini/agent-smith
```

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

All events are appended to `~/.config/agent-smith/events.jsonl` as structured JSONL. The plugin hardens files it creates to user-only permissions.

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

### Schema validation

The plugin includes a `validate-schemas` skill that fetches official JSON schemas and validates your settings files. Claude will invoke it automatically when you ask to validate settings or check schemas.

## Configuration

| Environment Variable | Default | Purpose |
|---------------------|---------|---------|
| `AGENT_METRICS_ENABLED` | `1` | Set to `0` to disable all metrics collection |
| `METRICS_DIR` | `~/.config/agent-smith` | Where metrics data is stored (created with private permissions) |
| `ANALYZE_THRESHOLD` | `50` | Sessions required before optional automatic analysis runs |
| `AUTO_ANALYZE_ENABLED` | `0` | Set to `1` to allow background report generation |
| `AUTO_ANALYZE_MODE` | `raw` | `raw` for local-only reports, `llm` to opt into Claude analysis |
| `AUTO_ANALYZE_INCLUDE_SETTINGS` | `0` | Set to `1` to include `~/.claude/settings*.json` in automatic LLM prompts |

## Data Location

All data lives in `~/.config/agent-smith/` and is hardened to user-only permissions when the plugin creates it:

```text
~/.config/agent-smith/
├── events.jsonl          # Raw metric events (append-only)
├── rollup.db             # SQLite database (queryable)
├── reports/              # Analysis reports
│   └── 2026-03-27-analysis.md
├── .session_start_ts     # Temporary: session timing
└── .test_fail_count      # Temporary: consecutive test failures
```

## Prerequisites

- **jq** — JSON processing (ships with Homebrew, `brew install jq`)
- **sqlite3** — Database queries (ships with macOS)
- **claude** CLI — Optional, only required for `--llm` analysis

## Plugin Structure

```text
agent-smith/
├── .claude-plugin/plugin.json    # Plugin manifest
├── hooks/
│   ├── hooks.json                # Hook registration
│   ├── lib/metrics.sh            # Core metrics library
│   ├── lib/common.sh             # Logging utilities
│   ├── session-start.sh          # Session lifecycle
│   ├── session-stop.sh
│   ├── tool-failure.sh           # Error tracking
│   ├── permission-denied.sh
│   ├── vague-prompt.sh           # Prompt quality
│   ├── test-result.sh            # Test loop detection
│   └── analyze-trigger.sh        # Auto-trigger analysis
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

The Makefile also exposes direct Claude entrypoints that load this repo as a plugin:

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
