# Agent Smith

A self-modifying feedback loop plugin for Claude Code. Collects session metrics, analyzes patterns, and produces tuning recommendations to continuously improve agent reliability and autonomy.

## How It Works

Agent Smith implements a closed-loop improvement cycle:

```text
┌─────────────────────────────────────────────────────────┐
│  1. COLLECT                                             │
│  Hooks emit metrics on every session:                   │
│  tool failures, permission denials, test loops,         │
│  vague prompts, session lifecycle                       │
│  → ~/.config/agent-smith/events.jsonl                 │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  2. ROLLUP                                              │
│  JSONL events → SQLite database                         │
│  Incremental, resumable, auto-rotating                  │
│  → ~/.config/agent-smith/rollup.db                    │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  3. ANALYZE                                             │
│  SQL queries produce a local report by default          │
│  Claude LLM analysis is explicit opt-in                 │
│  Generates tuning report with specific suggestions      │
│  → ~/.config/agent-smith/reports/<date>-analysis.md   │
└────────────────────────┬────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│  4. APPLY                                               │
│  Auto-apply safe changes (prompt wording)               │
│  Present structural changes for approval                │
│  → settings.json, commands/*.md, CLAUDE.md              │
└─────────────────────────────────────────────────────────┘
```text

Automatic analysis is disabled by default. You can opt in to background raw reports, or run analysis manually anytime. LLM-backed analysis is never run automatically unless you explicitly enable it.

## Installation

### Local (development)

```bash
claude --plugin-dir path/to/agent-smith
```text

### From a Git repo

```bash
claude plugin add https://github.com/chetmancini/agent-smith
```text

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
```text

Or run the scripts directly:

```bash
# Process events into SQLite
bash path/to/agent-smith/scripts/metrics-rollup.sh

# Generate a local raw report (default, no LLM)
bash path/to/agent-smith/scripts/analyze-config.sh --sessions 50

# Generate an LLM-backed report (explicit opt-in)
bash path/to/agent-smith/scripts/analyze-config.sh --llm --sessions 50

# Include your local Claude settings snapshot in the LLM prompt (explicit opt-in)
bash path/to/agent-smith/scripts/analyze-config.sh --llm --include-settings --sessions 50
```text

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
```text

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

## License

MIT
