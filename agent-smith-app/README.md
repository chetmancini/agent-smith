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
bun run src/cli.ts watch --tail 10
bun run src/cli.ts doctor
bun run src/cli.ts paths
```

## Current Scope

- `emit`: append typed JSONL events
- `rollup`: ingest JSONL into SQLite with incremental byte offsets
- `report`: summarize the SQLite store for humans or scripts
- `watch`: stream live events across tools and projects
- `doctor`: verify Claude, Codex, and OpenCode integration state when their binaries are installed

## Next Likely Migrations

- Port shell event emitters to call `agent-smith emit`
- Move analysis/report generation into this package
- Add richer watch renderers, including a future TUI
