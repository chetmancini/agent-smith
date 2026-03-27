#!/bin/bash
# Post-edit test hook: run the corresponding test file after editing a source file
# Exits 0 always — test failures are reported but never block the edit

set -euo pipefail

_script="${BASH_SOURCE[0]}"
[ -L "$_script" ] && _script="$(readlink "$_script")"
SCRIPT_DIR="$(cd "$(dirname "$_script")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"
source "${SCRIPT_DIR}/lib/metrics.sh"

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

if [ -z "$file_path" ] || [ ! -f "$file_path" ]; then
	exit 0
fi

extension=$(get_extension "$file_path")
dir=$(dirname "$file_path")
filename=$(basename "$file_path")
stem="${filename%.*}"

# Skip if the edited file is itself a test file
case "$extension" in
ts | tsx | js | jsx | mjs)
	if echo "$stem" | grep -qE '\.(test|spec)$' || echo "$dir" | grep -qE '(^|/)__tests__(/|$)'; then
		exit 0
	fi
	;;
py)
	if echo "$stem" | grep -qE '^test_|_test$'; then
		exit 0
	fi
	;;
go)
	if echo "$stem" | grep -q '_test$'; then
		exit 0
	fi
	;;
esac

# Try to find a matching test file from a list of candidates
find_test_file() {
	for candidate in "$@"; do
		if [ -f "$candidate" ]; then
			echo "$candidate"
			return 0
		fi
	done
	return 1
}

test_file=""
test_cmd=()
test_cmd_display=""

set_test_cmd() {
	test_cmd=("$@")
	printf -v test_cmd_display '%q ' "${test_cmd[@]}"
	test_cmd_display="${test_cmd_display% }"
}

case "$extension" in
ts | tsx | js | jsx | mjs)
	# Determine the parallel test extension (tsx -> tsx, ts -> ts, etc.)
	test_ext="$extension"
	alt_ext=""
	if [ "$extension" = "tsx" ]; then
		alt_ext="ts"
	elif [ "$extension" = "jsx" ]; then
		alt_ext="js"
	fi

	candidates=(
		"${dir}/${stem}.test.${test_ext}"
		"${dir}/${stem}.spec.${test_ext}"
		"${dir}/__tests__/${stem}.test.${test_ext}"
		"${dir}/__tests__/${stem}.${test_ext}"
		"tests/${stem}.test.${test_ext}"
		"test/${stem}.test.${test_ext}"
	)
	if [ -n "${alt_ext:-}" ]; then
		candidates+=(
			"${dir}/${stem}.test.${alt_ext}"
			"${dir}/${stem}.spec.${alt_ext}"
		)
	fi

	test_file=$(find_test_file "${candidates[@]}") || true

	if [ -n "$test_file" ]; then
		project_root=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")
		if [ -f "$project_root/vitest.config.ts" ] || [ -f "$project_root/vitest.config.js" ] || [ -f "$project_root/vitest.config.mts" ]; then
			set_test_cmd npx vitest run "$test_file" --reporter=verbose
		elif [ -f "$project_root/jest.config.ts" ] || [ -f "$project_root/jest.config.js" ] || [ -f "$project_root/jest.config.json" ]; then
			set_test_cmd npx jest "$test_file" --passWithNoTests
		elif grep -q '"vitest"' "$project_root/package.json" 2>/dev/null; then
			set_test_cmd npx vitest run "$test_file" --reporter=verbose
		elif grep -q '"jest"' "$project_root/package.json" 2>/dev/null; then
			set_test_cmd npx jest "$test_file" --passWithNoTests
		fi
	fi
	;;

py)
	candidates=(
		"${dir}/test_${stem}.py"
		"${dir}/${stem}_test.py"
		"tests/test_${stem}.py"
		"test/test_${stem}.py"
		"tests/${stem}_test.py"
	)
	test_file=$(find_test_file "${candidates[@]}") || true

	if [ -n "$test_file" ] && command_exists pytest; then
		set_test_cmd pytest "$test_file" -x -q --tb=short
	fi
	;;

go)
	# Go tests live alongside source in the same package directory
	test_file="${dir}/${stem}_test.go"
	if [ -f "$test_file" ] && command_exists go; then
		set_test_cmd go test "$dir" -run . -count=1
	else
		test_file=""
	fi
	;;

rs)
	# Rust: inline tests or integration tests under tests/
	project_root=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")
	if command_exists cargo && [ -f "$project_root/Cargo.toml" ]; then
		if grep -q '#\[cfg(test)\]' "$file_path" 2>/dev/null || [ -d "$project_root/tests" ]; then
			# Run only the tests related to this file's module name
			test_file="$file_path"
			set_test_cmd cargo test
		fi
	fi
	;;

rb)
	candidates=(
		"spec/${stem}_spec.rb"
		"spec/${dir#*/}/${stem}_spec.rb"
		"test/${stem}_test.rb"
		"test/${dir#*/}/${stem}_test.rb"
	)
	test_file=$(find_test_file "${candidates[@]}") || true

	if [ -n "$test_file" ]; then
		if command_exists rspec && echo "$test_file" | grep -q '_spec\.rb$'; then
			set_test_cmd rspec "$test_file" --format progress
		elif command_exists ruby; then
			set_test_cmd ruby -Itest "$test_file"
		fi
	fi
	;;
esac

if [ -z "$test_file" ] || [ "${#test_cmd[@]}" -eq 0 ]; then
	exit 0
fi

log_info "Testing: $(basename "$file_path") -> $(basename "$test_file")"

if "${test_cmd[@]}" >&2; then
	log_info "Tests passed"
	metrics_on_test_result 1 "$test_cmd_display" "$file_path"
else
	log_warn "Tests failed — review output above"
	metrics_on_test_result 0 "$test_cmd_display" "$file_path"
fi

exit 0
