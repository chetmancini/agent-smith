# agent-smith-opencode

OpenCode plugin for [Agent Smith](https://github.com/chetmancini/agent-smith) — self-tuning feedback loop with session metrics and analysis.

## Installation

### Via opencode.json (recommended)

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["agent-smith-opencode"]
}
```

### From local clone

If you've cloned the agent-smith repo:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./path/to/agent-smith/opencode-plugin"]
}
```

## Features

This plugin provides the supported OpenCode integration for Agent Smith:

| Event | Metric | Description |
|-------|--------|-------------|
| `session.created` | `session_start` | Session lifecycle tracking |
| `session.idle` | `session_stop` | Session end with reason |
| `session.error` | `session_error` | **OpenCode-only**: crashed sessions |
| `session.compacted` | `context_compression` | Context compression events |
| `permission.replied` | `permission_denied/granted` | Permission tracking |
| `file.edited` | `file_edited` | **OpenCode-only**: all file edits |
| `tool.execute.after` | `tool_failure` | Tool failure tracking |
| `tool.execute.after` | `test_failure_loop` | Auto-test runner after edits |
| `chat.message` | `clarifying_question` | Vague prompt detection |

### OpenCode-Exclusive Metrics

The native plugin captures events that have no Claude Code equivalent:

- **`session_error`** — Tracks sessions that crashed (not just completed)
- **`file_edited`** — Tracks all file edits with line change counts  
- **`permission_granted`** — Tracks permission grants (not just denials)

## How It Works

Metrics are written to `~/.config/agent-smith/events.jsonl`, the same location used by the shell hooks for Claude Code, Gemini CLI, and Codex. This means all your metrics from all agents end up in one unified database.

Run analysis with:

```bash
# From the agent-smith repo
make agent-analyze TOOL=opencode
```

Or use the `/agent-smith:analyze` slash command inside OpenCode.

## Development

```bash
cd opencode-plugin
bun install --frozen-lockfile
bun run typecheck
bun run build
```

## License

MIT
