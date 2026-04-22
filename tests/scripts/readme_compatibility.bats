#!/usr/bin/env bats

setup() {
	load '../setup_suite'
}

@test "top-level README documents workflow parity alongside telemetry parity" {
	run grep -F "| Install path in this repo | ✓ | ✓ | ✓ | ✓ | ✓ |" "$PROJECT_ROOT/README.md"
	[ "$status" -eq 0 ]

	run grep -F '| `agent-smith doctor` coverage | ✓ | ✓ | ✓ | ✓ | ✓ |' "$PROJECT_ROOT/README.md"
	[ "$status" -eq 0 ]

	run grep -F "| Slash commands | ✓ |  | ✓ | ✓ | ✓ |" "$PROJECT_ROOT/README.md"
	[ "$status" -eq 0 ]

	run grep -F "Pi support installs this checkout as a Pi package, which exposes the repo extension, bundled schema validation, and slash-command aliases across working directories" "$PROJECT_ROOT/README.md"
	[ "$status" -eq 0 ]

	run grep -F "Pi currently records context compression without the Claude/Gemini auto-vs-manual trigger split" "$PROJECT_ROOT/README.md"
	[ "$status" -eq 0 ]
}

@test "agent-smith app README keeps Gemini in doctor scope" {
	run grep -F -- "- \`doctor\`: verify Claude, Gemini, Codex, OpenCode, and Pi integration state when their binaries are installed" \
		"$PROJECT_ROOT/agent-smith-app/README.md"

	[ "$status" -eq 0 ]
}
