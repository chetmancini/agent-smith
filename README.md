# Agent Smith

> "Never send a human to do a machine's job." Agent Smith, *The Matrix* (1999)
>
> [Clip on YouTube](https://www.youtube.com/watch?v=dJ4Bt2xtE9Q)
>
> ![Agent Smith poster](https://github.com/user-attachments/assets/401bb432-7be5-441a-8617-c1d1d2e52fde)

Agent configuration is hard, fragile, and always changing. Agent Smith outsources that tuning work to your agent: it gathers empirical data from watching real sessions and recommends concrete changes to prompts, settings, and workflow.

Get a feedback loop based on how Claude Code, Codex, Gemini CLI, or OpenCode actually behave on your real work instead of guessing what might help.

Agent Smith:

- Collects hook and plugin telemetry from supported hosts
- Pulls the latest configuration schemas
- Emits events to a user-level SQLite database
- Generates agent-backed analysis reports by agent or project
- Helps apply safe config improvements and surfaces larger changes for review

## Installation

### Prerequisites

- Bun `>=1.3.0`
- `jq`
- `sqlite3`
- `python3`

### Claude Code

```bash
claude plugins marketplace add chetmancini/agent-smith
claude plugins install agent-smith@agent-smith
```

### Codex

Install from a local clone:

```bash
bun run ./agent-smith-app/src/cli.ts install-codex
```

Or:

```bash
make codex-install
```

Then:

1. Restart Codex.
2. Open the Plugin Directory.
3. Choose your personal marketplace.
4. Install `Agent Smith`.
5. Run `make app-doctor`.

The installer enables `features.codex_hooks = true`, links the plugin into `~/.codex/plugins/agent-smith`, and configures the personal marketplace entry. The checkout still needs to stay trusted so Codex can load the repo-local [`.codex/hooks.json`](.codex/hooks.json).

### Gemini CLI

Gemini currently ships as a local-checkout hook extension:

```bash
gemini extensions link ./gemini-extension
```

This reuses the shared repo-root shell hooks and scripts.

### OpenCode

Add Agent Smith to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["agent-smith-opencode"]
}
```

For a local checkout instead of the published package:

```json
{
  "plugin": ["./path/to/agent-smith/opencode-plugin"]
}
```

## Comparison Matrix

| Feature | Claude Code | Gemini CLI | Codex | OpenCode |
| --- | :---: | :---: | :---: | :---: |
| Session lifecycle | ✓ | ✓ | ✓ | ✓ |
| Bash failure tracking | ✓ | ✓ | ✓ | ✓ |
| Vague prompt guidance | ✓ | ✓ | ✓ | ✓ |
| Rollup and analysis | ✓ | ✓ | ✓ | ✓ |
| Schema validation | ✓ | ✓ | ✓ | ✓ |
| Tool failures | ✓ | ✓ |  | ✓ |
| Permission denials | ✓ | ✓ |  | ✓ |
| Permission grants |  |  |  | ✓ |
| Session errors |  |  |  | ✓ |
| File-edited telemetry |  |  |  | ✓ |
| Context compression | ✓ | ✓ |  | ✓ |
| Edit-triggered test-loop detection | ✓ | ✓ |  | ✓ |

As of April 22, 2026, Codex still exposes a narrower hook surface than Claude Code. Gemini reaches the matrix above through the hook-based extension, while OpenCode reaches its richer telemetry surface through the native TypeScript plugin.

## Using Agent Smith

Claude Code, Codex, and OpenCode currently expose these slash commands:

```text
/agent-smith:analyze
/agent-smith:analyze-fast
/agent-smith:upgrade-settings
```

Gemini currently ships the hook extension plus the shared shell commands below. Slash-command parity can come later.

Useful commands:

```bash
bash scripts/metrics-rollup.sh
bash scripts/analyze-config.sh --sessions 50
bash scripts/analyze-config.sh --llm --sessions 50
bash scripts/refresh-schemas.sh
bash scripts/validate-agent-config.sh --tool codex --refresh
make agent-upgrade-settings TOOL=codex
make app-doctor
```

The standalone TypeScript CLI is the migration path for the shared runtime:

```bash
bun run ./agent-smith-app/src/cli.ts doctor
bun run ./agent-smith-app/src/cli.ts report
bun run ./agent-smith-app/src/cli.ts improve --tool codex
bun run ./agent-smith-app/src/cli.ts loop --tool codex
```

## How It Works

```text
        +-----------+
        |  COLLECT  |
        | hooks and |
        | plugins   |
        +-----------+
              |
              v
        +-----------+
        | ROLL UP   |
        | JSONL to  |
        | SQLite    |
        +-----------+
              |
              v
        +-----------+
        | ANALYZE   |
        | raw or    |
        | agent-led |
        +-----------+
              |
              v
        +-----------+
        |  APPLY    |
        | safe fixes|
        | + review  |
        +-----------+
              |
              v
        +-----------+
        |  BETTER   |
        |  AGENT    |
        |   LOOP    |
        +-----------+
              |
              +--------------------+
                                   |
                                   v
                              +-----------+
                              |  COLLECT  |
                              +-----------+
```

- Collect: hooks or plugins emit structured events into `~/.config/agent-smith/events.jsonl`.
- Roll up: the event stream is ingested into `~/.config/agent-smith/rollup.db`.
- Analyze: Agent Smith generates a raw local report or an agent-backed report in `~/.config/agent-smith/reports/`.
- Apply: safe changes can be applied automatically; larger configuration or workflow changes stay reviewable.

The default CLI path produces a local raw report. The slash command `/agent-smith:analyze` defaults to the smarter agent-backed path. Automatic analysis is disabled by default.

When `--include-settings` is enabled for agent-backed analysis, Agent Smith redacts obvious secret-bearing keys before sending the settings snapshot to the active agent.

### What Gets Collected

| Event | Typical trigger |
| --- | --- |
| `session_start` | Session begins |
| `session_stop` | Turn or session ends |
| `session_error` | OpenCode session crashes |
| `tool_failure` | Tool execution fails |
| `command_failure` | Shell command exits non-zero |
| `permission_denied` | Permission request is denied |
| `permission_granted` | OpenCode permission is granted |
| `file_edited` | OpenCode edit telemetry fires |
| `clarifying_question` | Prompt is vague or ambiguous |
| `test_failure_loop` | Repeated test failures after edits |
| `context_compression` | Host compacts or compresses context |

Not every host exposes every event. Metrics are tagged by initiating agent, and analysis stays scoped per agent.

When the host provides structured shell-failure payloads, Agent Smith records command text, exit code, output snippets, and turn or tool identifiers so the raw event stream stays actionable.

### Session Cost

Token usage and estimated USD cost are calculated during rollup, not during the hook itself. Session start stores the transcript path, and rollup re-reads transcripts so repeated runs can capture partial progress from an in-flight session.

## Data Location

```text
~/.config/agent-smith/
├── events.jsonl          # Raw metric events
├── rollup.db             # SQLite rollup database
├── reports/              # Generated analysis reports
├── .session_start_ts_*   # Temporary timing files
├── .cost_snapshot_*      # Temporary cost snapshots
├── .transcript_paths     # Transcript lookup state
└── .test_fail_count_*    # Consecutive test failure counters
```

## Development

### Repo Layout

| Path | Purpose |
| --- | --- |
| `agent-smith-app/` | Standalone TypeScript CLI and shared runtime |
| `.claude-plugin/` | Claude Code manifest |
| `.codex-plugin/` | Codex manifest |
| `gemini-extension/` | Gemini CLI extension |
| `opencode-plugin/` | Native OpenCode plugin |
| `.codex/hooks.json` | Repo-local Codex hook registration |
| `hooks/` | Shared shell hook scripts and libraries |
| `scripts/` | Rollup, analysis, schema, and helper scripts |
| `commands/` | Slash-command prompts |
| `skills/` | Agent Smith skills |
| `tests/` | Bats and integration tests |

### Maintainer Dependencies

- `bun` for the standalone app, the OpenCode plugin, and TypeScript checks
- `bats` for the shell test suites
- `jq` for JSON validation and release helpers
- `shellcheck` for shell linting
- `shfmt` for shell formatting checks
- `markdownlint` for README, command, and skill docs
- `gh` for GitHub release creation

### Validation

Run this before pushing or updating a PR:

```bash
make pre-push
```

To install the tracked git hook for this clone:

```bash
make install-git-hooks
```

Targeted local checks:

```bash
make test
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
