# OpenCode Plugin Development

Development guide for the `agent-smith-opencode` npm plugin.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0 (or Node.js >= 18)
- OpenCode installed for testing

## Setup

```bash
cd opencode-plugin
bun install
```

## Development Workflow

### Type-check

```bash
bun run typecheck
```

### Build

```bash
bun run build
```

This creates `dist/index.js` — the bundled plugin ready for distribution.

### Test locally

**Option 1: Point OpenCode at the local directory**

Add to your `opencode.json`:

```json
{
  "plugin": ["/absolute/path/to/agent-smith/opencode-plugin"]
}
```

OpenCode will run `bun install` in this directory at startup and load `dist/index.js`.

**Option 2: Link globally**

```bash
cd opencode-plugin
npm link

# Then in your opencode.json:
# "plugin": ["agent-smith-opencode"]
```

### Verify metrics are flowing

After making changes, run OpenCode and check:

```bash
# Watch the metrics file
tail -f ~/.config/agent-smith/events.jsonl | jq .

# Or run rollup to see aggregated data
cd .. && bash scripts/metrics-rollup.sh
sqlite3 ~/.config/agent-smith/rollup.db "SELECT * FROM events ORDER BY ts DESC LIMIT 10;"
```

## Project Structure

```
opencode-plugin/
├── src/
│   ├── index.ts              # Plugin entry point (exports AgentSmithPlugin)
│   └── lib/
│       ├── metrics.ts        # JSONL emission to ~/.config/agent-smith/events.jsonl
│       ├── test-runner.ts    # Auto-test runner after file edits
│       └── vague-prompt.ts   # Vague prompt detection patterns
├── dist/
│   └── index.js              # Built output (bundled by Bun)
├── package.json
├── tsconfig.json
└── README.md
```

## Plugin Hooks Used

| Hook | Purpose |
|------|---------|
| `event` | Session lifecycle, permissions, file edits, compaction |
| `permission.ask` | Track permission requests |
| `tool.execute.after` | Track tool failures, run post-edit tests |
| `chat.message` | Detect vague prompts, inject clarification |
| `experimental.session.compacting` | Inject context during compaction |

See the [OpenCode Plugin Docs](https://opencode.ai/docs/plugins/) for the full hook API.

## Publishing

### Prepare release

```bash
# Bump version in package.json
bun run build
bun run typecheck
```

### Publish to npm

```bash
npm publish
```

The `prepublishOnly` script runs the build automatically.

### Versioning

Keep the version in sync with the main `agent-smith` version in the root `VERSION` file when possible.

## Comparison with Shell Hooks

The native plugin provides richer telemetry than the shell hooks in `.opencode-plugin/hooks.json`:

| Metric | Native Plugin | Shell Hooks |
|--------|:-------------:|:-----------:|
| `session_start` | ✓ | ✓ |
| `session_stop` | ✓ | ✓ |
| `session_error` | ✓ | ✗ |
| `tool_failure` | ✓ | Bash-only |
| `permission_denied` | ✓ | ✓ |
| `permission_granted` | ✓ | ✗ |
| `file_edited` | ✓ | ✗ |
| `clarifying_question` | ✓ | ✓ |
| `test_failure_loop` | ✓ | ✓ |
| `context_compression` | ✓ | ✓ |

Choose one OpenCode integration path per setup. The native plugin and shell shim both write into the same `events.jsonl` stream, so enabling both for the same sessions will double-count overlapping metrics during rollup.
