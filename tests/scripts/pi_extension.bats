#!/usr/bin/env bats

setup() {
	load '../setup_suite'
}

@test "Pi extension aliases forward full registered command names" {
	run grep -F 'pi.sendUserMessage(`/${commandName}${suffix}`);' "$PROJECT_ROOT/.pi/extensions/agent-smith/index.ts"
	[ "$status" -eq 0 ]

	run grep -F 'pi.sendUserMessage(`/${targetPrompt}${suffix}`);' "$PROJECT_ROOT/.pi/extensions/agent-smith/index.ts"
	[ "$status" -ne 0 ]
}
