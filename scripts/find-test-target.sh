#!/bin/bash
# Shared test target discovery for post-edit hooks and native integrations.
# Emits JSON:
#   {"found":false}
#   {"found":true,"test_file":"/abs/path","test_command":["npx","vitest","run",...]}

set -euo pipefail

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

emit_not_found() {
	jq -nc '{found:false}'
}

emit_found() {
	local test_file="$1"
	shift
	printf '%s\0' "$@" | jq -Rs --arg test_file "$test_file" \
		'{found:true,test_file:$test_file,test_command:(split("\u0000")[:-1])}'
}

find_project_root() {
	local dir="$1"
	local start_dir="$1"

	while [ -n "$dir" ] && [ "$dir" != "/" ]; do
		if [ -f "$dir/package.json" ] || [ -f "$dir/Cargo.toml" ] || [ -f "$dir/go.mod" ] || [ -d "$dir/.git" ]; then
			printf '%s\n' "$dir"
			return 0
		fi
		dir=$(dirname "$dir")
	done

	case "$start_dir" in
	"$PWD" | "$PWD"/*)
		printf '%s\n' "$PWD"
		;;
	*)
		printf '%s\n' "$start_dir"
		;;
	esac
}

find_test_file() {
	local candidate
	for candidate in "$@"; do
		if [ -f "$candidate" ]; then
			printf '%s\n' "$candidate"
			return 0
		fi
	done
	return 1
}

is_test_file() {
	local file_path="$1"
	local extension filename stem dir
	filename=$(basename "$file_path")
	extension="${filename##*.}"
	stem="${filename%.*}"
	dir=$(dirname "$file_path")

	case "$extension" in
	ts | tsx | js | jsx | mjs)
		[[ "$stem" =~ \.(test|spec)$ ]] || [[ "$dir" =~ (^|/)__tests__(/|$) ]]
		;;
	py)
		[[ "$stem" =~ ^test_ || "$stem" =~ _test$ ]]
		;;
	go)
		[[ "$stem" =~ _test$ ]]
		;;
	rb)
		[[ "$stem" =~ _spec$ || "$stem" =~ _test$ ]]
		;;
	*)
		return 1
		;;
	esac
}

select_js_command() {
	local project_root="$1"
	local test_file="$2"

	if [ -f "$project_root/vitest.config.ts" ] || [ -f "$project_root/vitest.config.js" ] || [ -f "$project_root/vitest.config.mts" ]; then
		printf '%s\n' "npx" "vitest" "run" "$test_file" "--reporter=verbose"
		return 0
	fi

	if [ -f "$project_root/jest.config.ts" ] || [ -f "$project_root/jest.config.js" ] || [ -f "$project_root/jest.config.json" ]; then
		printf '%s\n' "npx" "jest" "$test_file" "--passWithNoTests"
		return 0
	fi

	if grep -q '"vitest"' "$project_root/package.json" 2>/dev/null; then
		printf '%s\n' "npx" "vitest" "run" "$test_file" "--reporter=verbose"
		return 0
	fi

	if grep -q '"jest"' "$project_root/package.json" 2>/dev/null; then
		printf '%s\n' "npx" "jest" "$test_file" "--passWithNoTests"
		return 0
	fi

	return 1
}

main() {
	local file_path="${1:-}"
	[ -n "$file_path" ] || {
		emit_not_found
		return 0
	}
	[ -f "$file_path" ] || {
		emit_not_found
		return 0
	}

	if is_test_file "$file_path"; then
		emit_not_found
		return 0
	fi

	local dir filename extension stem project_root test_file relative_dir
	filename=$(basename "$file_path")
	extension="${filename##*.}"
	stem="${filename%.*}"
	dir=$(dirname "$file_path")
	project_root=$(find_project_root "$dir")

	case "$extension" in
	ts | tsx | js | jsx | mjs)
		local test_ext alt_ext
		test_ext="$extension"
		alt_ext=""
		if [ "$extension" = "tsx" ]; then
			alt_ext="ts"
		elif [ "$extension" = "jsx" ]; then
			alt_ext="js"
		fi

		local -a candidates
		candidates=(
			"${dir}/${stem}.test.${test_ext}"
			"${dir}/${stem}.spec.${test_ext}"
			"${dir}/__tests__/${stem}.test.${test_ext}"
			"${dir}/__tests__/${stem}.${test_ext}"
			"${project_root}/tests/${stem}.test.${test_ext}"
			"${project_root}/test/${stem}.test.${test_ext}"
		)
		if [ -n "$alt_ext" ]; then
			candidates+=(
				"${dir}/${stem}.test.${alt_ext}"
				"${dir}/${stem}.spec.${alt_ext}"
			)
		fi

		test_file=$(find_test_file "${candidates[@]}") || {
			emit_not_found
			return 0
		}

		local -a test_cmd=()
		local cmd_part
		while IFS= read -r cmd_part; do
			test_cmd+=("$cmd_part")
		done < <(select_js_command "$project_root" "$test_file") || true
		[ "${#test_cmd[@]}" -gt 0 ] || {
			emit_not_found
			return 0
		}

		emit_found "$test_file" "${test_cmd[@]}"
		return 0
		;;

	py)
		local -a candidates
		candidates=(
			"${dir}/test_${stem}.py"
			"${dir}/${stem}_test.py"
			"${project_root}/tests/test_${stem}.py"
			"${project_root}/test/test_${stem}.py"
			"${project_root}/tests/${stem}_test.py"
		)

		test_file=$(find_test_file "${candidates[@]}") || {
			emit_not_found
			return 0
		}

		if command_exists pytest; then
			emit_found "$test_file" "pytest" "$test_file" "-x" "-q" "--tb=short"
			return 0
		fi

		emit_not_found
		return 0
		;;

	go)
		test_file="${dir}/${stem}_test.go"
		if [ -f "$test_file" ] && command_exists go; then
			emit_found "$test_file" "go" "test" "$dir" "-run" "." "-count=1"
			return 0
		fi

		emit_not_found
		return 0
		;;

	rs)
		if command_exists cargo && [ -f "$project_root/Cargo.toml" ]; then
			if grep -q '#\[cfg(test)\]' "$file_path" 2>/dev/null || [ -d "$project_root/tests" ]; then
				emit_found "$file_path" "cargo" "test"
				return 0
			fi
		fi

		emit_not_found
		return 0
		;;

	rb)
		relative_dir="${dir#"${project_root}"/}"
		if [ "$relative_dir" = "$dir" ]; then
			relative_dir=""
		fi

		local -a candidates
		candidates=(
			"${project_root}/spec/${stem}_spec.rb"
			"${project_root}/test/${stem}_test.rb"
		)
		if [ -n "$relative_dir" ] && [ "$relative_dir" != "." ]; then
			candidates+=(
				"${project_root}/spec/${relative_dir}/${stem}_spec.rb"
				"${project_root}/test/${relative_dir}/${stem}_test.rb"
			)
		fi

		test_file=$(find_test_file "${candidates[@]}") || {
			emit_not_found
			return 0
		}

		if command_exists rspec && [[ "$test_file" =~ _spec\.rb$ ]]; then
			emit_found "$test_file" "rspec" "$test_file" "--format" "progress"
			return 0
		fi
		if command_exists ruby; then
			emit_found "$test_file" "ruby" "-Itest" "$test_file"
			return 0
		fi

		emit_not_found
		return 0
		;;

	*)
		emit_not_found
		return 0
		;;
	esac
}

main "$@"
