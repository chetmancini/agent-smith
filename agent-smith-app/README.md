# Agent Smith App

Standalone TypeScript CLI for the next Agent Smith runtime.

This package is intentionally separate from the OpenCode plugin so the core
telemetry, rollup, report, and watch surfaces can evolve without dragging the
plugin packaging model or shell hook contracts along with them.

## Distribution

Install the published CLI with Bun or npm:

```bash
bun add --global agent-smith-app
# or
npm install --global agent-smith-app

agent-smith doctor
```

The published package runs through Bun, so Bun `>=1.3.0` must be installed on
the target machine. If you want a self-contained executable that does not
require Bun, build one locally:

```bash
bun run build:compile
./dist/agent-smith doctor
```

## Commands

```bash
bun run src/cli.ts emit session_start --tool codex --session-id abc123 --metadata '{"cwd":"/tmp/project"}'
bun run src/cli.ts rollup
bun run src/cli.ts report
bun run src/cli.ts improve --tool codex
bun run src/cli.ts loop --tool codex
bun run src/cli.ts watch
bun run src/cli.ts demo
bun run src/cli.ts watch --tail 500
bun run src/cli.ts watch --view events --tail 20
bun run src/cli.ts doctor
bun run src/cli.ts paths
```

For package validation before publishing:

```bash
bun run build
bun run pack:check
```

## Current Scope

- `emit`: append typed JSONL events
- `rollup`: ingest JSONL into SQLite with incremental byte offsets
- `report`: summarize the SQLite store with operator-focused health, active sessions, hotspots, and recent failures
- `improve`: assemble telemetry plus schema/config evidence and ask the active agent for structured recommendations
- `loop`: run bounded analysis -> apply -> evaluate iterations using the active agent, auto-applying only actions marked safe unless you opt into unsafe actions
- `watch`: launch a multi-pane TUI by default on a real terminal, with session/event text fallbacks for scripts
- `demo`: run an isolated full-loop sandbox that simulates Claude fixing a tiny todo app, emits tool-call telemetry, writes reports, drives the loop, and animates the TUI
- `doctor`: verify Claude, Codex, and OpenCode integration state when their binaries are installed

## Next Likely Migrations

- Port shell event emitters to call `agent-smith emit`
- Add a future TUI once the session/operator vocabulary settles
