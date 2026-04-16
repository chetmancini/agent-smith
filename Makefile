SHELL := /bin/bash

.DEFAULT_GOAL := help

BATS ?= bats
AGENT_CLI ?=
MARKDOWNLINT ?= markdownlint
SHELLCHECK ?= shellcheck
SHFMT ?= shfmt
SESSIONS ?= 50
TOOL ?=
HELP_ASCII ?= 1
HELP_HEADER ?= assets/agent-smith-ascii-cp-437.txt
APP_BUN ?= bun
TOOL_ARG := $(if $(TOOL),--tool $(TOOL),)
CLAUDE_CLI := $(if $(AGENT_CLI),$(AGENT_CLI),claude)
CODEX_CLI := $(if $(AGENT_CLI),$(AGENT_CLI),codex)
OPENCODE_CLI := $(if $(AGENT_CLI),$(AGENT_CLI),opencode)
VERSION ?=

.PHONY: help test app-test app-build lint version sync-version set-version release refresh-schemas validate-agent-config agent-analyze agent-validate-schemas agent-upgrade-settings agent-loop claude-analyze claude-validate-schemas claude-upgrade-settings claude-loop codex-analyze codex-validate-schemas codex-upgrade-settings codex-loop opencode-analyze opencode-validate-schemas opencode-upgrade-settings opencode-loop

help:
	@if [ "$(CLICOLOR_FORCE)" = "1" ] || [ "$(FORCE_COLOR)" = "1" ] || \
	   { [ -z "$(NO_COLOR)" ] && [ -n "$(TERM)" ] && [ "$(TERM)" != "dumb" ]; }; then \
		if [ "$(HELP_ASCII)" != "0" ] && [ -f "$(HELP_HEADER)" ]; then \
			printf '\033[36m'; \
			cat "$(HELP_HEADER)"; \
			printf '\033[0m\n'; \
		fi; \
		printf '\033[1mAgent Smith Make Targets\033[0m\n\n'; \
		printf '\033[36mCore\033[0m\n'; \
		printf '  \033[32m%-30s\033[0m %s\n' "make test" "Run all tests (Bats + TypeScript packages)"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make app-test" "Run the standalone Agent Smith app test suite"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make app-build" "Build the standalone Agent Smith app CLI"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make lint" "Run the local lint suite used in CI"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make version" "Print the current release version"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make set-version VERSION=1.0.1" "Update VERSION and sync release metadata"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make release VERSION=1.0.1" "Bump, tag, push, and create a GitHub release"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make refresh-schemas" "Refresh the installed agent schema cache"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make validate-agent-config" "Validate the installed agent config against the cached schema"; \
		printf '\n\033[36mAgent Helpers\033[0m\n'; \
		printf '  \033[32m%-30s\033[0m %s\n' "make agent-analyze TOOL=codex" "Run the analyze-config skill via Claude, Codex, or OpenCode"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make agent-validate-schemas TOOL=codex" "Run the validate-schemas skill via Claude, Codex, or OpenCode"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make agent-upgrade-settings TOOL=codex" "Run the settings upgrade skill via Claude, Codex, or OpenCode"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make agent-loop TOOL=codex" "Run validate-schemas then analyze-config via Claude, Codex, or OpenCode"; \
		printf '\n\033[36mAliases\033[0m\n'; \
		printf '  \033[32m%-30s\033[0m %s\n' "make claude-analyze" "Alias for make agent-analyze TOOL=claude"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make claude-validate-schemas" "Alias for make agent-validate-schemas TOOL=claude"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make claude-upgrade-settings" "Alias for make agent-upgrade-settings TOOL=claude"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make claude-loop" "Alias for make agent-loop TOOL=claude"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make codex-analyze" "Alias for make agent-analyze TOOL=codex"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make codex-validate-schemas" "Alias for make agent-validate-schemas TOOL=codex"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make codex-upgrade-settings" "Alias for make agent-upgrade-settings TOOL=codex"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make codex-loop" "Alias for make agent-loop TOOL=codex"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make opencode-analyze" "Alias for make agent-analyze TOOL=opencode"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make opencode-validate-schemas" "Alias for make agent-validate-schemas TOOL=opencode"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make opencode-upgrade-settings" "Alias for make agent-upgrade-settings TOOL=opencode"; \
		printf '  \033[32m%-30s\033[0m %s\n' "make opencode-loop" "Alias for make agent-loop TOOL=opencode"; \
		printf '\n\033[33mVariables\033[0m\n'; \
		printf '  \033[2mTOOL\033[0m=%s %s\n' "$(if $(TOOL),$(TOOL),<auto>)" "(accepted: claude|codex|opencode)"; \
		printf '  \033[2mSESSIONS\033[0m=%s %s\n' "$(SESSIONS)" "(used by analyze and loop helpers)"; \
		printf '  \033[2mHELP_ASCII\033[0m=%s %s\n' "$(HELP_ASCII)" "(set to 0 to hide the header image)"; \
		printf '  \033[2mAGENT_CLI\033[0m=%s %s\n' "$(if $(AGENT_CLI),$(AGENT_CLI),<tool default>)" "(override the selected agent binary)"; \
		printf '  \033[2mHELP_HEADER\033[0m=%s %s\n' "$(HELP_HEADER)" "(path to the ASCII header art)"; \
	else \
		if [ "$(HELP_ASCII)" != "0" ] && [ -f "$(HELP_HEADER)" ]; then \
			cat "$(HELP_HEADER)"; \
			printf '\n'; \
		fi; \
		printf 'Agent Smith Make Targets\n\n'; \
		printf 'Core\n'; \
		printf '  %-30s %s\n' "make test" "Run all tests (Bats + TypeScript packages)"; \
		printf '  %-30s %s\n' "make app-test" "Run the standalone Agent Smith app test suite"; \
		printf '  %-30s %s\n' "make app-build" "Build the standalone Agent Smith app CLI"; \
		printf '  %-30s %s\n' "make lint" "Run the local lint suite used in CI"; \
		printf '  %-30s %s\n' "make version" "Print the current release version"; \
		printf '  %-30s %s\n' "make set-version VERSION=1.0.1" "Update VERSION and sync release metadata"; \
		printf '  %-30s %s\n' "make release VERSION=1.0.1" "Bump, tag, push, and create a GitHub release"; \
		printf '  %-30s %s\n' "make refresh-schemas" "Refresh the installed agent schema cache"; \
		printf '  %-30s %s\n' "make validate-agent-config" "Validate the installed agent config against the cached schema"; \
		printf '\nAgent Helpers\n'; \
		printf '  %-30s %s\n' "make agent-analyze TOOL=codex" "Run the analyze-config skill via Claude, Codex, or OpenCode"; \
		printf '  %-30s %s\n' "make agent-validate-schemas TOOL=codex" "Run the validate-schemas skill via Claude, Codex, or OpenCode"; \
		printf '  %-30s %s\n' "make agent-upgrade-settings TOOL=codex" "Run the settings upgrade skill via Claude, Codex, or OpenCode"; \
		printf '  %-30s %s\n' "make agent-loop TOOL=codex" "Run validate-schemas then analyze-config via Claude, Codex, or OpenCode"; \
		printf '\nAliases\n'; \
		printf '  %-30s %s\n' "make claude-analyze" "Alias for make agent-analyze TOOL=claude"; \
		printf '  %-30s %s\n' "make claude-validate-schemas" "Alias for make agent-validate-schemas TOOL=claude"; \
		printf '  %-30s %s\n' "make claude-upgrade-settings" "Alias for make agent-upgrade-settings TOOL=claude"; \
		printf '  %-30s %s\n' "make claude-loop" "Alias for make agent-loop TOOL=claude"; \
		printf '  %-30s %s\n' "make codex-analyze" "Alias for make agent-analyze TOOL=codex"; \
		printf '  %-30s %s\n' "make codex-validate-schemas" "Alias for make agent-validate-schemas TOOL=codex"; \
		printf '  %-30s %s\n' "make codex-upgrade-settings" "Alias for make agent-upgrade-settings TOOL=codex"; \
		printf '  %-30s %s\n' "make codex-loop" "Alias for make agent-loop TOOL=codex"; \
		printf '  %-30s %s\n' "make opencode-analyze" "Alias for make agent-analyze TOOL=opencode"; \
		printf '  %-30s %s\n' "make opencode-validate-schemas" "Alias for make agent-validate-schemas TOOL=opencode"; \
		printf '  %-30s %s\n' "make opencode-upgrade-settings" "Alias for make agent-upgrade-settings TOOL=opencode"; \
		printf '  %-30s %s\n' "make opencode-loop" "Alias for make agent-loop TOOL=opencode"; \
		printf '\nVariables\n'; \
		printf '  TOOL=%s %s\n' "$(if $(TOOL),$(TOOL),<auto>)" "(accepted: claude|codex|opencode)"; \
		printf '  SESSIONS=%s %s\n' "$(SESSIONS)" "(used by analyze and loop helpers)"; \
		printf '  HELP_ASCII=%s %s\n' "$(HELP_ASCII)" "(set to 0 to hide the header image)"; \
		printf '  AGENT_CLI=%s %s\n' "$(if $(AGENT_CLI),$(AGENT_CLI),<tool default>)" "(override the selected agent binary)"; \
		printf '  HELP_HEADER=%s %s\n' "$(HELP_HEADER)" "(path to the ASCII header art)"; \
	fi

test:
	$(BATS) --print-output-on-failure tests/lib/metrics.bats tests/hooks/security.bats tests/hooks/integration.bats tests/scripts/schema_tools.bats tests/scripts/run_agent_skill.bats tests/scripts/codex_hook_layout.bats
	cd agent-smith-app && $(APP_BUN) test
	cd opencode-plugin && bun test

app-test:
	cd agent-smith-app && $(APP_BUN) test

app-build:
	cd agent-smith-app && $(APP_BUN) run build

lint:
	find . -name '*.json' -not -path './.git/*' -print0 | xargs -0 -n1 jq empty
	for file in skills/*/SKILL.md; do \
		echo "Checking $$file"; \
		awk '\
			NR == 1 { if ($$0 != "---") exit 1 } \
			NR > 1 && $$0 == "---" { end=1; exit } \
			!end && /^name:[[:space:]]+/ { name=1 } \
			!end && /^description:[[:space:]]+/ { desc=1 } \
			END { exit !(name && desc && end) } \
		' "$$file" || { \
			echo "Invalid skill frontmatter in $$file" >&2; \
			exit 1; \
		}; \
	done
	$(SHELLCHECK) -x -P SCRIPTDIR hooks/*.sh hooks/lib/*.sh scripts/*.sh scripts/lib/*.sh tests/setup_suite.bash
	$(SHFMT) -d hooks/*.sh hooks/lib/*.sh scripts/*.sh scripts/lib/*.sh tests/setup_suite.bash
	$(MARKDOWNLINT) README.md commands/**/*.md skills/**/*.md

version:
	@cat VERSION

sync-version:
	"$(SHELL)" scripts/set-version.sh --sync

set-version:
	@if [ -z "$(VERSION)" ]; then \
		echo "Usage: make set-version VERSION=1.0.1" >&2; \
		exit 1; \
	fi
	"$(SHELL)" scripts/set-version.sh "$(VERSION)"

release:
	@if [ -z "$(VERSION)" ]; then \
		echo "Usage: make release VERSION=1.0.1" >&2; \
		exit 1; \
	fi
	"$(SHELL)" scripts/release.sh "$(VERSION)"

refresh-schemas:
	"$(SHELL)" scripts/refresh-schemas.sh $(TOOL_ARG)

validate-agent-config:
	"$(SHELL)" scripts/validate-agent-config.sh $(TOOL_ARG) --refresh

agent-analyze:
	AGENT_CLI="$(AGENT_CLI)" AGENT_SMITH_TOOL="$(TOOL)" SESSIONS="$(SESSIONS)" "$(SHELL)" scripts/run-agent-skill.sh analyze-config $(TOOL_ARG)

agent-validate-schemas:
	AGENT_CLI="$(AGENT_CLI)" AGENT_SMITH_TOOL="$(TOOL)" "$(SHELL)" scripts/run-agent-skill.sh validate-schemas $(TOOL_ARG)

agent-upgrade-settings:
	AGENT_CLI="$(AGENT_CLI)" AGENT_SMITH_TOOL="$(TOOL)" "$(SHELL)" scripts/run-agent-skill.sh upgrade-settings $(TOOL_ARG)

agent-loop:
	AGENT_CLI="$(AGENT_CLI)" AGENT_SMITH_TOOL="$(TOOL)" SESSIONS="$(SESSIONS)" "$(SHELL)" scripts/run-agent-skill.sh loop $(TOOL_ARG)

claude-analyze:
	@$(MAKE) agent-analyze TOOL=claude AGENT_CLI="$(CLAUDE_CLI)" SESSIONS="$(SESSIONS)"

claude-validate-schemas:
	@$(MAKE) agent-validate-schemas TOOL=claude AGENT_CLI="$(CLAUDE_CLI)"

claude-upgrade-settings:
	@$(MAKE) agent-upgrade-settings TOOL=claude AGENT_CLI="$(CLAUDE_CLI)"

claude-loop:
	@$(MAKE) agent-loop TOOL=claude AGENT_CLI="$(CLAUDE_CLI)" SESSIONS="$(SESSIONS)"

codex-analyze:
	@$(MAKE) agent-analyze TOOL=codex AGENT_CLI="$(CODEX_CLI)" SESSIONS="$(SESSIONS)"

codex-validate-schemas:
	@$(MAKE) agent-validate-schemas TOOL=codex AGENT_CLI="$(CODEX_CLI)"

codex-upgrade-settings:
	@$(MAKE) agent-upgrade-settings TOOL=codex AGENT_CLI="$(CODEX_CLI)"

codex-loop:
	@$(MAKE) agent-loop TOOL=codex AGENT_CLI="$(CODEX_CLI)" SESSIONS="$(SESSIONS)"

opencode-analyze:
	@$(MAKE) agent-analyze TOOL=opencode AGENT_CLI="$(OPENCODE_CLI)" SESSIONS="$(SESSIONS)"

opencode-validate-schemas:
	@$(MAKE) agent-validate-schemas TOOL=opencode AGENT_CLI="$(OPENCODE_CLI)"

opencode-upgrade-settings:
	@$(MAKE) agent-upgrade-settings TOOL=opencode AGENT_CLI="$(OPENCODE_CLI)"

opencode-loop:
	@$(MAKE) agent-loop TOOL=opencode AGENT_CLI="$(OPENCODE_CLI)" SESSIONS="$(SESSIONS)"
