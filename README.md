# Agent Smith

> "Never send a human to do a machine's job." Agent Smith, *The Matrix* (1999)
>
> [Clip on YouTube](https://www.youtube.com/watch?v=dJ4Bt2xtE9Q)
>
> ![Agent Smith poster](https://github.com/user-attachments/assets/401bb432-7be5-441a-8617-c1d1d2e52fde)

A self-tuning feedback loop plugin for Claude Code, Gemini CLI, Codex, and OpenCode.
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

**Codex:** Agent Smith now ships a repo marketplace at [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json) plus an install helper that lays down the personal marketplace entry, links the plugin source into `~/.codex/plugins/agent-smith`, enables `features.codex_hooks = true`, and trusts this checkout in `~/.codex/config.toml`.

From a local clone:

```bash
bun run ./agent-smith-app/src/cli.ts install-codex
```

Or:

```bash
make codex-install
```

That automates everything Agent Smith can safely write itself. One manual Codex step remains:

1. Restart Codex.
2. Open the Plugin Directory.
3. Choose your personal marketplace.
4. Install `Agent Smith`.
5. Run `make app-doctor` (or `bun run ./agent-smith-app/src/cli.ts doctor`).

Codex loads automatic hook telemetry from the repo-local [`.codex/hooks.json`](.codex/hooks.json) file, so the checkout still needs to stay trusted.

```bash
make agent-analyze TOOL=codex
make agent-validate-schemas TOOL=codex
make agent-upgrade-settings TOOL=codex
```

**Gemini CLI:** Agent Smith now ships a hook-based Gemini extension at [`gemini-extension/`](gemini-extension). It currently reuses the existing repo-root shell hooks and scripts, so treat it as a local-checkout integration for now.

From a local clone:

```bash
gemini extensions link ./gemini-extension
```

That gives Gemini the existing shell-hook telemetry path without introducing the new native runtime.

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

- **Bun** `>=1.3.0` — required for the standalone app, the OpenCode plugin, and `make pre-push`
- **jq** — `brew install jq`
- **sqlite3** — ships with macOS
- **python3** — for Codex TOML parsing during schema validation

### Usage

Claude Code starts collecting metrics as soon as its hook manifest loads. Gemini CLI starts collecting metrics after the local [`gemini-extension/`](gemini-extension) hook extension is linked. OpenCode starts collecting metrics when the native `agent-smith-opencode` plugin loads. In Codex, skills work after the plugin is installed from the marketplace, and automatic hook-based metrics collection works when `features.codex_hooks = true` and the repo-local [`.codex/hooks.json`](.codex/hooks.json) file is available in a trusted project.

**Slash command** (inside Claude, Codex, and OpenCode today):
```text
/agent-smith:analyze
/agent-smith:analyze-fast
/agent-smith:upgrade-settings
```

Gemini currently ships the hook-based extension surface plus the shared shell scripts below. Command parity can come later.

**Manual scripts:**
```bash
bash scripts/metrics-rollup.sh                          # Process events into SQLite
bash scripts/analyze-config.sh --sessions 50             # Local raw report (default)
bash scripts/analyze-config.sh --llm --sessions 50       # Agent-backed report for the active tool
bash scripts/analyze-config.sh --llm --include-settings   # Include redacted settings snapshot
bash scripts/refresh-schemas.sh                          # Refresh all schema caches
bash scripts/refresh-schemas.sh --tool gemini            # Refresh only the Gemini CLI schema cache
bash scripts/validate-agent-config.sh --tool gemini --refresh
```

**Standalone TypeScript app** (new migration path):
```bash
make app-doctor
make demo
make app-cli APP_CMD=watch APP_ARGS='--tail 10'
bun run ./agent-smith-app/src/cli.ts emit session_start --tool codex --session-id demo --metadata '{"cwd":"/tmp/project"}'
bun run ./agent-smith-app/src/cli.ts rollup
bun run ./agent-smith-app/src/cli.ts report
bun run ./agent-smith-app/src/cli.ts improve --tool codex
bun run ./agent-smith-app/src/cli.ts loop --tool codex
bun run ./agent-smith-app/src/cli.ts watch --tail 10
bun run ./agent-smith-app/src/cli.ts demo
bun run ./agent-smith-app/src/cli.ts install-codex
bun run ./agent-smith-app/src/cli.ts doctor
bun run ./agent-smith-app/src/cli.ts refresh-schemas --tool codex
bun run ./agent-smith-app/src/cli.ts validate-agent-config --tool codex --refresh
bun run ./agent-smith-app/src/cli.ts upgrade-settings --tool codex
```

**Standalone app distribution checks:**
```bash
make app-build
make app-compile
make app-pack-check
```

**Schema validation** (refresh all schemas by default, validate one agent at a time):
```bash
bash scripts/refresh-schemas.sh
bash scripts/validate-agent-config.sh --tool codex --refresh
```

**Schema upgrade planning** (scoped to the calling agent):
```bash
make agent-upgrade-settings TOOL=codex
```

Or ask your agent to use the `validate-schemas`, `upgrade-settings`, or `analyze-config` skills directly. The shell scripts remain available, but the Bun CLI now has native `refresh-schemas`, `validate-agent-config`/`validate-schemas`, and `upgrade-settings`/`update-settings` commands for the same workflow.

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

| Feature                            | Claude Code | Gemini CLI | Codex | OpenCode |
|------------------------------------|:-----------:|:----------:|:-----:|:--------:|
| Session lifecycle                  | ✓           | ✓          | ✓     | ✓        |
| Bash failure tracking              | ✓           | ✓          | ✓     | ✓        |
| Vague prompt guidance              | ✓           | ✓          | ✓     | ✓        |
| Rollup & analysis                  | ✓           | ✓          | ✓     | ✓        |
| Schema validation                  | ✓           | ✓          | ✓     | ✓        |
| Tool failures                      | ✓           | ✓          |       | ✓        |
| Permission denials                 | ✓           | ✓          |       | ✓        |
| Permission grants                  |             |            |       | ✓        |
| Session errors                     |             |            |       | ✓        |
| File-edited telemetry              |             |            |       | ✓        |
| Context compression                | ✓           | ✓          |       | ✓        |
| Edit-triggered test-loop detection | ✓           | ✓          |       | ✓        |

Schema validation and upgrade planning are available for all four agents. As of April 15, 2026, Codex still exposes a narrower hook surface than Claude Code, and Agent Smith only sees `Bash` in current Codex tool-scoped hooks. Gemini currently reaches the cells above through the hook-based extension, while OpenCode reaches its richer metric surface through the native npm plugin. Metrics are tagged by initiating agent, and analysis stays scoped per-agent.

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

`make demo` now runs an isolated sandbox under `.context/full-loop-demo/`, simulates Claude working through a tiny Bun todo app, emits synthetic tool attempts and failures, rolls the stream into SQLite, generates report and improve artifacts, applies safe loop recommendations inside the sandbox repo, and keeps the watch open until you press `q`. Inside tmux it opens a side pane for the `Claude Working` log; outside tmux it falls back to the embedded pane in the TUI.

When `--include-settings` is enabled, Agent Smith redacts obvious secret-bearing keys (API keys, tokens, passwords, client secrets) before sending the settings snapshot to the active agent.

### What Gets Collected

| Event | Hook | Trigger |
|-------|------|---------|
| `session_start` | SessionStart | Every session start |
| `session_stop` | Claude: Stop; Gemini: AfterAgent | Per-turn end snapshot (with duration) |
| `session_error` | OpenCode native plugin: `session.error` | OpenCode session crashes |
| `tool_failure` | Claude: PostToolUseFailure; Gemini: AfterTool `run_shell_command`; OpenCode plugin: `tool.execute.after` | Tool errors (filters expected non-zero exits) |
| `command_failure` | Claude: PostToolUseFailure; Gemini/Codex/OpenCode: post-tool shell payloads | Bash command failures |
| `permission_denied` | Claude: PermissionRequest; Gemini: Notification `ToolPermission`; OpenCode plugin: `permission.replied` | Permission denials |
| `permission_granted` | OpenCode plugin: `permission.replied` | Permission grants |
| `file_edited` | OpenCode plugin: `file.edited` | File edit telemetry for compaction/test context |
| `clarifying_question` | Claude: UserPromptSubmit; Gemini: BeforeAgent | Vague/ambiguous prompts detected |
| `test_failure_loop` | Claude: PostToolUse; Gemini: AfterTool `write_file` or `replace`; OpenCode plugin: `tool.execute.after` | 3+ consecutive test failures after edits |
| `context_compression` | Claude: PostCompact; Gemini: PreCompress; OpenCode plugin: `session.compacted` and `experimental.session.compacting` | Context compression |

Not every host agent exposes every hook above. Today Codex supports session lifecycle, vague prompt guidance, Bash failure tracking, rollup/analysis, and schema validation. Gemini CLI now covers session lifecycle, shell failures, permission prompts, edit-triggered test loops, vague prompt guidance, and compaction through the hook-based extension. Claude Code also exposes tool failures, permission denials, edit-triggered test loops, compact events, stop failures, tool attempts, and subagent lifecycle. OpenCode reaches its richer metric set through the native plugin.

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
├── agent-smith-app/
│   ├── src/cli.ts                # Standalone TS CLI entrypoint
│   ├── src/lib/rollup.ts         # JSONL -> SQLite ingestion
│   ├── src/lib/report.ts         # Query/report helpers
│   ├── src/lib/watch.ts          # Live watch foundation for future TUI
│   └── tests/*.test.ts           # Bun test coverage for the new app
├── .claude-plugin/plugin.json    # Claude Code manifest
├── .codex-plugin/plugin.json     # Codex manifest
├── gemini-extension/             # Gemini CLI hook-based extension
├── .agents/plugins/marketplace.json # Codex repo marketplace
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
│   ├── refresh-schemas.sh        # Refresh all schema caches or one selected tool
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

The new `agent-smith-app/` package is where the unified TypeScript runtime can grow. For now it coexists with the shell scripts and OpenCode plugin rather than replacing them.

### Hook Registration

- Claude Code: [`hooks/hooks.json`](hooks/hooks.json)
- Gemini CLI: [`gemini-extension/hooks/hooks.json`](gemini-extension/hooks/hooks.json)
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
  tests/scripts/schema_tools.bats \
  tests/scripts/run_agent_skill.bats \
  tests/scripts/release.bats \
  tests/scripts/codex_hook_layout.bats
```

### Local Validation Before Push

```bash
make pre-push
```

`make pre-push` installs Bun dependencies for the tracked TypeScript packages, then runs repo linting, formatter checks, type checks, the full test suite, and both package builds. This is the command agents should run before pushing or updating a PR.

To block pushes automatically for this clone:

```bash
make install-git-hooks
```

That installs a shared git `pre-push` dispatcher which resolves the current worktree's tracked [`.githooks/pre-push`](.githooks/pre-push).

### Linting

```bash
brew install jq shellcheck shfmt
npm install --global markdownlint-cli
make lint
make format-check
make typecheck
```

### Releases

Agent Smith now uses [`VERSION`](VERSION) as the single release source of truth.

```bash
# one-command release: run tests, bump, commit, tag, push, and publish notes
make release VERSION=1.0.1
```

If you edit [`VERSION`](VERSION) by hand, run `make sync-version` to push that value into the Claude, Gemini, and Codex manifests plus [`agent-smith-app/package.json`](agent-smith-app/package.json) and [`opencode-plugin/package.json`](opencode-plugin/package.json).

`make release` requires a clean git worktree, a freshly fetched local `main` that exactly matches `origin/main`, and an authenticated `gh` session. Before it mutates version files or creates tags, it runs `make release-test` (`make deps` + `make test`) and does not reuse the broader `make pre-push` hook path. Run it from `main` after `git pull --ff-only origin main`. If you only want to bump versioned release files without publishing yet, use `make set-version VERSION=1.0.1`.

The GitHub release flow does not publish the standalone CLI package to npm for you. After cutting the repo release, publish it separately from `agent-smith-app/` when you are ready:

```bash
cd agent-smith-app
npm publish
```

### Makefile Helpers

```bash
# Run skills through any agent
make agent-analyze TOOL=claude
make agent-analyze TOOL=gemini
make agent-validate-schemas TOOL=codex
make agent-upgrade-settings TOOL=codex
make agent-loop TOOL=opencode        # validate-schemas then analyze-config

# Override session window
make agent-analyze TOOL=codex SESSIONS=100

# Local schema tools
make refresh-schemas                  # Refresh all schema caches
make refresh-schemas TOOL=codex       # Refresh one schema cache
make validate-agent-config TOOL=codex

# Full repo validation before push
make pre-push
make install-git-hooks
```

The Makefile keeps a single parameterized interface: use `TOOL=claude|gemini|codex|opencode` for the agent-backed `agent-*`, `refresh-schemas`, and `validate-agent-config` targets.

## License

MIT
