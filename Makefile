SHELL := /bin/bash

.DEFAULT_GOAL := help

BATS ?= bats
CLAUDE ?= claude
MARKDOWNLINT ?= markdownlint
SHELLCHECK ?= shellcheck
SHFMT ?= shfmt
SESSIONS ?= 50

.PHONY: help test lint refresh-schemas validate-agent-config claude-analyze claude-validate-schemas claude-loop

help:
	@printf "Targets:\n"
	@printf "  make test                     Run the Bats test suite\n"
	@printf "  make lint                     Run the local lint suite used in CI\n"
	@printf "  make refresh-schemas          Refresh the installed agent schema cache\n"
	@printf "  make validate-agent-config    Validate the installed agent config against the cached schema\n"
	@printf "  make claude-analyze           Run the analyze-config skill via Claude (dev helper)\n"
	@printf "  make claude-validate-schemas  Run the validate-schemas skill via Claude (dev helper)\n"
	@printf "  make claude-loop              Run validate-schemas then analyze-config via Claude (dev helper)\n"
	@printf "\nVariables:\n"
	@printf "  SESSIONS=%s\n" "$(SESSIONS)"
	@printf "  CLAUDE=%s\n" "$(CLAUDE)"

test:
	$(BATS) --print-output-on-failure tests/lib/metrics.bats tests/hooks/security.bats tests/hooks/integration.bats tests/scripts/schema_tools.bats

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

refresh-schemas:
	"$(SHELL)" scripts/refresh-schemas.sh

validate-agent-config:
	"$(SHELL)" scripts/validate-agent-config.sh --refresh

claude-analyze:
	CLAUDE="$(CLAUDE)" SESSIONS="$(SESSIONS)" "$(SHELL)" scripts/run-claude-skill.sh analyze-config

claude-validate-schemas:
	CLAUDE="$(CLAUDE)" "$(SHELL)" scripts/run-claude-skill.sh validate-schemas

claude-loop:
	CLAUDE="$(CLAUDE)" SESSIONS="$(SESSIONS)" "$(SHELL)" scripts/run-claude-skill.sh loop
