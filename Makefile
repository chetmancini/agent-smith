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
APP_CMD ?=
APP_ARGS ?=
TOOL_ARG := $(if $(TOOL),--tool $(TOOL),)
VERSION ?=

.PHONY: help quick-help _help deps app-install opencode-install shell-test test release-test app-test opencode-test app-format app-lint format-check typecheck app-typecheck opencode-typecheck build app-build opencode-build app-compile app-pack-check lint pre-push install-git-hooks version sync-version set-version release app-cli app-doctor demo refresh-schemas validate-agent-config codex-install agent-analyze agent-validate-schemas agent-upgrade-settings agent-loop

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
		print_section "Core Commands"; \
		print_row "make codex-install" "Install Agent Smith into Codex from this checkout"; \
		print_row "make deps" "Install Bun dependencies for the local packages"; \
		print_row "make app-doctor [APP_ARGS=--json]" "Run the standalone TS CLI doctor from the repo root"; \
		print_row "make demo [APP_ARGS='--no-watch']" "Run the isolated full-loop demo"; \
		print_row "make refresh-schemas [TOOL=codex]" "Refresh all schema caches, or one with TOOL=claude|gemini|codex|opencode|pi"; \
		print_row "make validate-agent-config [TOOL=codex]" "Validate one installed agent config; set TOOL when auto-detect is ambiguous"; \
		print_row "make agent-validate-schemas TOOL=codex" "Run the validate-schemas skill via Claude, Gemini, Codex, OpenCode, or Pi"; \
		print_row "make agent-upgrade-settings TOOL=codex" "Run the settings upgrade skill via Claude, Gemini, Codex, OpenCode, or Pi"; \
		print_row "make agent-analyze TOOL=codex [SESSIONS=100]" "Run the analyze-config skill via Claude, Gemini, Codex, OpenCode, or Pi"; \
		print_row "make agent-loop TOOL=codex [SESSIONS=100]" "Validate schemas, then analyze via Claude, Gemini, Codex, OpenCode, or Pi"; \
		printf '\n%b%s%b\n' "$$note_on" "Run \`make help\` for the full maintainer target list." "$$title_off"; \
	else \
		print_section "Help"; \
		print_row "make quick-help" "Show the compact quickstart surfaced by plain \`make\`"; \
		print_row "make help" "Show every maintained make target"; \
		print_section "Core Commands"; \
		print_row "make codex-install" "Install Agent Smith into Codex from this checkout"; \
		print_row "make deps" "Install Bun dependencies for the local packages"; \
		print_row "make demo [APP_ARGS='--no-watch']" "Run the isolated full-loop sandbox demo"; \
		print_row "make app-doctor [APP_ARGS=--json]" "Run the standalone TS CLI doctor from the repo root"; \
		print_row "make refresh-schemas [TOOL=codex]" "Refresh all schema caches, or one with TOOL=claude|gemini|codex|opencode|pi"; \
		print_row "make validate-agent-config [TOOL=codex]" "Validate one installed agent config; set TOOL when auto-detect is ambiguous"; \
		print_row "make agent-validate-schemas TOOL=codex" "Run the validate-schemas skill via Claude, Gemini, Codex, OpenCode, or Pi"; \
		print_row "make agent-upgrade-settings TOOL=codex" "Run the settings upgrade skill via Claude, Gemini, Codex, OpenCode, or Pi"; \
		print_row "make agent-analyze TOOL=codex" "Run the analyze-config skill via Claude, Gemini, Codex, OpenCode, or Pi"; \
		print_row "make agent-loop TOOL=codex" "Run validate-schemas then analyze-config via Claude, Gemini, Codex, OpenCode, or Pi"; \
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
		print_row "make app-cli APP_CMD=doctor [APP_ARGS=--json]" "Run the standalone TS CLI from the repo root"; \
		print_row "make build" "Build the standalone app and the OpenCode plugin"; \
		print_row "make app-build" "Build the standalone Agent Smith Bun CLI bundle"; \
		print_row "make opencode-build" "Build the OpenCode plugin bundle"; \
		print_row "make app-compile" "Build a standalone executable for the current host"; \
		print_row "make app-pack-check" "Verify the npm package contents with a dry run"; \
		print_section "Version And Release"; \
		print_row "make version" "Print the current release version"; \
		print_row "make sync-version" "Sync package metadata to the checked-in VERSION"; \
		print_row "make set-version VERSION=1.0.1" "Update VERSION and sync release metadata"; \
		print_row "make release VERSION=1.0.1" "Run tests, then bump, tag, push, and create a GitHub release"; \
		print_section "Contributor Maintenance"; \
		print_row "make app-install" "Install Bun dependencies for the standalone app"; \
		print_row "make opencode-install" "Install Bun dependencies for the OpenCode plugin"; \
		print_row "make install-git-hooks" "Install the repo-managed pre-push hook dispatcher"; \
		print_section "Variables"; \
		print_var "TOOL" "$(if $(TOOL),$(TOOL),<auto>)" "(claude|gemini|codex|opencode|pi)"; \
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
	$(BATS) --print-output-on-failure tests/lib/metrics.bats tests/hooks/security.bats tests/hooks/integration.bats tests/scripts/schema_tools.bats tests/scripts/run_agent_skill.bats tests/scripts/release.bats tests/scripts/codex_hook_layout.bats tests/scripts/gemini_hook_layout.bats tests/scripts/readme_compatibility.bats

test:
	@$(MAKE) shell-test
	@$(MAKE) app-test
	@$(MAKE) opencode-test

release-test:
	@$(MAKE) deps
	@$(MAKE) test

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

demo:
	cd agent-smith-app && $(APP_BUN) run src/cli.ts demo $(APP_ARGS)

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

app-cli:
	@if [ -z "$(strip $(APP_CMD))" ]; then \
		echo "Usage: make app-cli APP_CMD=doctor [APP_ARGS=--json]" >&2; \
		exit 1; \
	fi
	$(APP_BUN) run ./agent-smith-app/src/cli.ts $(APP_CMD) $(APP_ARGS)

app-doctor:
	$(APP_BUN) run ./agent-smith-app/src/cli.ts doctor $(APP_ARGS)

agent-analyze:
	AGENT_CLI="$(AGENT_CLI)" AGENT_SMITH_TOOL="$(TOOL)" SESSIONS="$(SESSIONS)" "$(SHELL)" scripts/run-agent-skill.sh analyze-config $(TOOL_ARG)

agent-validate-schemas:
	AGENT_CLI="$(AGENT_CLI)" AGENT_SMITH_TOOL="$(TOOL)" "$(SHELL)" scripts/run-agent-skill.sh validate-schemas $(TOOL_ARG)

agent-upgrade-settings:
	AGENT_CLI="$(AGENT_CLI)" AGENT_SMITH_TOOL="$(TOOL)" "$(SHELL)" scripts/run-agent-skill.sh upgrade-settings $(TOOL_ARG)

agent-loop:
	AGENT_CLI="$(AGENT_CLI)" AGENT_SMITH_TOOL="$(TOOL)" SESSIONS="$(SESSIONS)" "$(SHELL)" scripts/run-agent-skill.sh loop $(TOOL_ARG)
