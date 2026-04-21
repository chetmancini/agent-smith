# Agent Smith App

Standalone TypeScript CLI for the next Agent Smith runtime.

This package is intentionally separate from the OpenCode plugin so the core
telemetry, rollup, report, and watch surfaces can evolve without dragging the
plugin packaging model or shell hook contracts along with them.

## Commands

```bash
bun run src/cli.ts emit session_start --tool codex --session-id abc123 --metadata '{"cwd":"/tmp/project"}'
bun run src/cli.ts rollup
bun run src/cli.ts report
bun run src/cli.ts improve --tool codex
bun run src/cli.ts loop --tool codex
bun run src/cli.ts watch
bun run src/cli.ts watch --tail 500
bun run src/cli.ts watch --view events --tail 20
bun run src/cli.ts doctor
bun run src/cli.ts paths
```

## Current Scope

- `emit`: append typed JSONL events
- `rollup`: ingest JSONL into SQLite with incremental byte offsets
- `report`: summarize the SQLite store with operator-focused health, active sessions, hotspots, and recent failures
- `improve`: assemble telemetry plus schema/config evidence and ask the active agent for structured recommendations
- `loop`: run bounded analysis -> apply -> evaluate iterations using the active agent, auto-applying only actions marked safe unless you opt into unsafe actions
- `watch`: launch a multi-pane TUI by default on a real terminal, with session/event text fallbacks for scripts
- `doctor`: verify Claude, Codex, and OpenCode integration state when their binaries are installed

## Next Likely Migrations

- Port shell event emitters to call `agent-smith emit`
- Add a future TUI once the session/operator vocabulary settles
