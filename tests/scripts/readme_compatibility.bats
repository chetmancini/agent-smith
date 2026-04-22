#!/usr/bin/env bats

setup() {
	load '../setup_suite'
}

@test "top-level README documents workflow parity alongside telemetry parity" {
	run grep -F "| Install path in this repo | ✓ | ✓ | ✓ | ✓ |" "$PROJECT_ROOT/README.md"
	[ "$status" -eq 0 ]

	run grep -F '| `agent-smith doctor` coverage | ✓ | ✓ | ✓ | ✓ |' "$PROJECT_ROOT/README.md"
	[ "$status" -eq 0 ]

	run grep -F "| Slash commands | ✓ |  | ✓ | ✓ |" "$PROJECT_ROOT/README.md"
	[ "$status" -eq 0 ]

	run grep -F "Gemini is supported for install, doctor, and the shared shell workflow through the hook extension, but slash-command parity is still pending." "$PROJECT_ROOT/README.md"
	[ "$status" -eq 0 ]
}

@test "agent-smith app README keeps Gemini in doctor scope" {
	run grep -F -- "- \`doctor\`: verify Claude, Gemini, Codex, and OpenCode integration state when their binaries are installed" \
		"$PROJECT_ROOT/agent-smith-app/README.md"

	[ "$status" -eq 0 ]
}
