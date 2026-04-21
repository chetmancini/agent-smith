SHELL := /bin/bash

.DEFAULT_GOAL := quick-help

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
GEMINI_CLI := $(if $(AGENT_CLI),$(AGENT_CLI),gemini)
CODEX_CLI := $(if $(AGENT_CLI),$(AGENT_CLI),codex)
OPENCODE_CLI := $(if $(AGENT_CLI),$(AGENT_CLI),opencode)
VERSION ?=

.PHONY: help quick-help _help deps app-install opencode-install shell-test test app-test opencode-test app-format app-lint format-check typecheck app-typecheck opencode-typecheck build app-build opencode-build app-compile app-pack-check lint pre-push install-git-hooks version sync-version set-version release refresh-schemas validate-agent-config codex-install agent-analyze agent-validate-schemas agent-upgrade-settings agent-loop claude-refresh-schemas claude-validate-agent-config claude-analyze claude-validate-schemas claude-upgrade-settings claude-loop codex-refresh-schemas codex-validate-agent-config codex-analyze codex-validate-schemas codex-upgrade-settings codex-loop gemini-refresh-schemas gemini-validate-agent-config gemini-analyze gemini-validate-schemas gemini-upgrade-settings gemini-loop opencode-refresh-schemas opencode-validate-agent-config opencode-analyze opencode-validate-schemas opencode-upgrade-settings opencode-loop

help:
	@$(MAKE) --no-print-directory _help HELP_MODE=full

quick-help:
	@$(MAKE) --no-print-directory _help HELP_MODE=quick

_help:
	@use_color=0; \
	if [ "$(CLICOLOR_FORCE)" = "1" ] || [ "$(FORCE_COLOR)" = "1" ] || \
	   { [ -z "$(NO_COLOR)" ] && [ -n "$(TERM)" ] && [ "$(TERM)" != "dumb" ]; }; then \
		use_color=1; \
	fi; \
	title_on=''; \
	title_off=''; \
	section_on=''; \
	row_on=''; \
	var_on=''; \
	note_on=''; \
	if [ "$$use_color" = "1" ]; then \
		title_on='\033[1m'; \
		title_off='\033[0m'; \
		section_on='\033[36m'; \
		row_on='\033[32m'; \
		var_on='\033[2m'; \
		note_on='\033[33m'; \
	fi; \
	print_title() { printf '%b%s%b\n' "$$title_on" "$$1" "$$title_off"; }; \
	print_section() { printf '\n%b%s%b\n' "$$section_on" "$$1" "$$title_off"; }; \
	print_row() { printf '  %b%-30s%b %s\n' "$$row_on" "$$1" "$$title_off" "$$2"; }; \
	print_var() { printf '  %b%s%b=%s %s\n' "$$var_on" "$$1" "$$title_off" "$$2" "$$3"; }; \
	if [ "$(HELP_MODE)" = "full" ] && [ "$(HELP_ASCII)" != "0" ] && [ -f "$(HELP_HEADER)" ]; then \
		if [ "$$use_color" = "1" ]; then \
			printf '\033[36m'; \
			cat "$(HELP_HEADER)"; \
			printf '\033[0m\n'; \
		else \
			cat "$(HELP_HEADER)"; \
			printf '\n'; \
		fi; \
	fi; \
	print_title "Agent Smith Make Targets"; \
	printf '\n'; \
	if [ "$(HELP_MODE)" = "quick" ]; then \
		print_section "Quick Start"; \
		print_row "make codex-install" "Install Agent Smith into Codex from this checkout"; \
		print_row "make deps" "Install Bun dependencies for the local packages"; \
		print_row "make refresh-schemas [TOOL=codex]" "Refresh all schema caches by default, or one with TOOL=claude|gemini|codex|opencode"; \
		print_row "make codex-refresh-schemas" "Alias example; use the same <tool>-refresh-schemas pattern for claude|codex|gemini|opencode"; \
		print_row "make validate-agent-config [TOOL=codex]" "Validate one installed agent config; set TOOL when auto-detect is ambiguous"; \
		print_row "make codex-upgrade-settings" "Alias example; use the same <tool>-upgrade-settings pattern for claude|codex|gemini|opencode"; \
		print_row "make codex-analyze" "Alias example; use the same <tool>-analyze pattern for claude|codex|gemini|opencode"; \
		printf '\n%b%s%b\n' "$$note_on" "Run \`make help\` for the full maintainer target list." "$$title_off"; \
	else \
		print_section "Help"; \
		print_row "make quick-help" "Show the compact quickstart surfaced by plain \`make\`"; \
		print_row "make help" "Show every maintained make target"; \
		print_section "End Users"; \
		print_row "make codex-install" "Install Agent Smith into Codex from this checkout"; \
		print_row "make deps" "Install Bun dependencies for the local packages"; \
		print_row "make refresh-schemas [TOOL=codex]" "Refresh all schema caches by default, or one with TOOL=claude|gemini|codex|opencode"; \
		print_row "make validate-agent-config [TOOL=codex]" "Validate one installed agent config; set TOOL when auto-detect is ambiguous"; \
		print_row "make agent-validate-schemas TOOL=codex" "Run the validate-schemas skill via Claude, Codex, or OpenCode"; \
		print_row "make agent-upgrade-settings TOOL=codex" "Run the settings upgrade skill via Claude, Codex, or OpenCode"; \
		print_row "make agent-analyze TOOL=codex" "Run the analyze-config skill via Claude, Codex, or OpenCode"; \
		print_row "make agent-loop TOOL=codex" "Run validate-schemas then analyze-config via Claude, Codex, or OpenCode"; \
		print_section "Agent Aliases"; \
		print_row "make claude-analyze" "Alias for make agent-analyze TOOL=claude"; \
		print_row "make claude-refresh-schemas" "Alias for make refresh-schemas TOOL=claude"; \
		print_row "make claude-validate-agent-config" "Alias for make validate-agent-config TOOL=claude"; \
		print_row "make claude-validate-schemas" "Alias for make agent-validate-schemas TOOL=claude"; \
		print_row "make claude-upgrade-settings" "Alias for make agent-upgrade-settings TOOL=claude"; \
		print_row "make claude-loop" "Alias for make agent-loop TOOL=claude"; \
		print_row "make codex-analyze" "Alias for make agent-analyze TOOL=codex"; \
		print_row "make codex-refresh-schemas" "Alias for make refresh-schemas TOOL=codex"; \
		print_row "make codex-validate-agent-config" "Alias for make validate-agent-config TOOL=codex"; \
		print_row "make codex-validate-schemas" "Alias for make agent-validate-schemas TOOL=codex"; \
		print_row "make codex-upgrade-settings" "Alias for make agent-upgrade-settings TOOL=codex"; \
		print_row "make codex-loop" "Alias for make agent-loop TOOL=codex"; \
		print_row "make gemini-analyze" "Alias for make agent-analyze TOOL=gemini"; \
		print_row "make gemini-refresh-schemas" "Alias for make refresh-schemas TOOL=gemini"; \
		print_row "make gemini-validate-agent-config" "Alias for make validate-agent-config TOOL=gemini"; \
		print_row "make gemini-validate-schemas" "Alias for make agent-validate-schemas TOOL=gemini"; \
		print_row "make gemini-upgrade-settings" "Alias for make agent-upgrade-settings TOOL=gemini"; \
		print_row "make gemini-loop" "Alias for make agent-loop TOOL=gemini"; \
		print_row "make opencode-analyze" "Alias for make agent-analyze TOOL=opencode"; \
		print_row "make opencode-refresh-schemas" "Alias for make refresh-schemas TOOL=opencode"; \
		print_row "make opencode-validate-agent-config" "Alias for make validate-agent-config TOOL=opencode"; \
		print_row "make opencode-validate-schemas" "Alias for make agent-validate-schemas TOOL=opencode"; \
		print_row "make opencode-upgrade-settings" "Alias for make agent-upgrade-settings TOOL=opencode"; \
		print_row "make opencode-loop" "Alias for make agent-loop TOOL=opencode"; \
		print_section "Validation"; \
		print_row "make shell-test" "Run the Bats suites for hooks, scripts, and metrics"; \
		print_row "make test" "Run all tests (Bats + TypeScript packages)"; \
		print_row "make app-test" "Run the standalone Agent Smith app test suite"; \
		print_row "make opencode-test" "Run the OpenCode plugin test suite"; \
		print_row "make lint" "Run the local lint suite used in CI"; \
		print_row "make format-check" "Run formatter checks for the standalone app"; \
		print_row "make app-format" "Apply the standalone app formatter"; \
		print_row "make app-lint" "Run the standalone app linter"; \
		print_row "make typecheck" "Run TypeScript checks for the app and OpenCode plugin"; \
		print_row "make app-typecheck" "Run TypeScript checks for the standalone app"; \
		print_row "make opencode-typecheck" "Run TypeScript checks for the OpenCode plugin"; \
		print_row "make pre-push" "Run the full local validation gate before pushing"; \
		print_section "Build And Package"; \
		print_row "make build" "Build the standalone app and the OpenCode plugin"; \
		print_row "make app-build" "Build the standalone Agent Smith Bun CLI bundle"; \
		print_row "make opencode-build" "Build the OpenCode plugin bundle"; \
		print_row "make app-compile" "Build a standalone executable for the current host"; \
		print_row "make app-pack-check" "Verify the npm package contents with a dry run"; \
		print_section "Version And Release"; \
		print_row "make version" "Print the current release version"; \
		print_row "make sync-version" "Sync package metadata to the checked-in VERSION"; \
		print_row "make set-version VERSION=1.0.1" "Update VERSION and sync release metadata"; \
		print_row "make release VERSION=1.0.1" "Bump, tag, push, and create a GitHub release"; \
		print_section "Contributor Maintenance"; \
		print_row "make app-install" "Install Bun dependencies for the standalone app"; \
		print_row "make opencode-install" "Install Bun dependencies for the OpenCode plugin"; \
		print_row "make install-git-hooks" "Install the repo-managed pre-push hook dispatcher"; \
		print_section "Variables"; \
		print_var "TOOL" "$(if $(TOOL),$(TOOL),<auto>)" "(accepted: claude|gemini|codex|opencode)"; \
		print_var "SESSIONS" "$(SESSIONS)" "(used by analyze and loop helpers)"; \
		print_var "HELP_ASCII" "$(HELP_ASCII)" "(set to 0 to hide the full help header image)"; \
		print_var "AGENT_CLI" "$(if $(AGENT_CLI),$(AGENT_CLI),<tool default>)" "(override the selected agent binary)"; \
		print_var "HELP_HEADER" "$(HELP_HEADER)" "(path to the ASCII header art)"; \
	fi

deps:
	@$(MAKE) app-install
	@$(MAKE) opencode-install

app-install:
	cd agent-smith-app && $(APP_BUN) install --frozen-lockfile

opencode-install:
	cd opencode-plugin && $(APP_BUN) install --frozen-lockfile

shell-test:
	$(BATS) --print-output-on-failure tests/lib/metrics.bats tests/hooks/security.bats tests/hooks/integration.bats tests/scripts/schema_tools.bats tests/scripts/run_agent_skill.bats tests/scripts/release.bats tests/scripts/codex_hook_layout.bats

test:
	@$(MAKE) shell-test
	@$(MAKE) app-test
	@$(MAKE) opencode-test

app-test:
	cd agent-smith-app && $(APP_BUN) test

opencode-test:
	cd opencode-plugin && $(APP_BUN) test

app-format:
	cd agent-smith-app && $(APP_BUN) run format

app-lint:
	cd agent-smith-app && $(APP_BUN) run lint

app-build:
	cd agent-smith-app && $(APP_BUN) run build

opencode-build:
	cd opencode-plugin && $(APP_BUN) run build

build:
	@$(MAKE) app-build
	@$(MAKE) opencode-build

app-compile:
	cd agent-smith-app && $(APP_BUN) run build:compile

app-pack-check:
	cd agent-smith-app && $(APP_BUN) run pack:check

format-check:
	@$(MAKE) app-format

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

typecheck:
	@$(MAKE) app-typecheck
	@$(MAKE) opencode-typecheck

app-typecheck:
	cd agent-smith-app && $(APP_BUN) run typecheck

opencode-typecheck:
	cd opencode-plugin && $(APP_BUN) run typecheck

pre-push:
	@$(MAKE) deps
	@$(MAKE) lint
	@$(MAKE) format-check
	@$(MAKE) app-lint
	@$(MAKE) typecheck
	@$(MAKE) test
	@$(MAKE) build

install-git-hooks:
	"$(SHELL)" scripts/install-git-hooks.sh

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

codex-install:
	$(APP_BUN) run ./agent-smith-app/src/cli.ts install-codex

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

claude-refresh-schemas:
	@$(MAKE) refresh-schemas TOOL=claude

claude-validate-agent-config:
	@$(MAKE) validate-agent-config TOOL=claude

claude-validate-schemas:
	@$(MAKE) agent-validate-schemas TOOL=claude AGENT_CLI="$(CLAUDE_CLI)"

claude-upgrade-settings:
	@$(MAKE) agent-upgrade-settings TOOL=claude AGENT_CLI="$(CLAUDE_CLI)"

claude-loop:
	@$(MAKE) agent-loop TOOL=claude AGENT_CLI="$(CLAUDE_CLI)" SESSIONS="$(SESSIONS)"

codex-analyze:
	@$(MAKE) agent-analyze TOOL=codex AGENT_CLI="$(CODEX_CLI)" SESSIONS="$(SESSIONS)"

codex-refresh-schemas:
	@$(MAKE) refresh-schemas TOOL=codex

codex-validate-agent-config:
	@$(MAKE) validate-agent-config TOOL=codex

codex-validate-schemas:
	@$(MAKE) agent-validate-schemas TOOL=codex AGENT_CLI="$(CODEX_CLI)"

codex-upgrade-settings:
	@$(MAKE) agent-upgrade-settings TOOL=codex AGENT_CLI="$(CODEX_CLI)"

codex-loop:
	@$(MAKE) agent-loop TOOL=codex AGENT_CLI="$(CODEX_CLI)" SESSIONS="$(SESSIONS)"

gemini-analyze:
	@$(MAKE) agent-analyze TOOL=gemini AGENT_CLI="$(GEMINI_CLI)" SESSIONS="$(SESSIONS)"

gemini-refresh-schemas:
	@$(MAKE) refresh-schemas TOOL=gemini

gemini-validate-agent-config:
	@$(MAKE) validate-agent-config TOOL=gemini

gemini-validate-schemas:
	@$(MAKE) agent-validate-schemas TOOL=gemini AGENT_CLI="$(GEMINI_CLI)"

gemini-upgrade-settings:
	@$(MAKE) agent-upgrade-settings TOOL=gemini AGENT_CLI="$(GEMINI_CLI)"

gemini-loop:
	@$(MAKE) agent-loop TOOL=gemini AGENT_CLI="$(GEMINI_CLI)" SESSIONS="$(SESSIONS)"

opencode-analyze:
	@$(MAKE) agent-analyze TOOL=opencode AGENT_CLI="$(OPENCODE_CLI)" SESSIONS="$(SESSIONS)"

opencode-refresh-schemas:
	@$(MAKE) refresh-schemas TOOL=opencode

opencode-validate-agent-config:
	@$(MAKE) validate-agent-config TOOL=opencode

opencode-validate-schemas:
	@$(MAKE) agent-validate-schemas TOOL=opencode AGENT_CLI="$(OPENCODE_CLI)"

opencode-upgrade-settings:
	@$(MAKE) agent-upgrade-settings TOOL=opencode AGENT_CLI="$(OPENCODE_CLI)"

opencode-loop:
	@$(MAKE) agent-loop TOOL=opencode AGENT_CLI="$(OPENCODE_CLI)" SESSIONS="$(SESSIONS)"
