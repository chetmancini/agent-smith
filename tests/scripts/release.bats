#!/usr/bin/env bats

setup() {
	load '../setup_suite'
	export TEST_TMPDIR
	TEST_TMPDIR="$(mktemp -d)"
}

teardown() {
	rm -rf "$TEST_TMPDIR"
}

create_fake_git() {
	local fakebin="$1"
	mkdir -p "$fakebin"
	cat >"${fakebin}/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${FAKE_GIT_LOG}"

case "$1" in
diff)
	if [[ "${FAKE_GIT_DIRTY:-0}" == "1" ]]; then
		exit 1
	fi
	exit 0
	;;
fetch)
	if [[ "${FAKE_GIT_FETCH_FAIL:-0}" == "1" ]]; then
		exit 1
	fi
	exit 0
	;;
rev-parse)
	if [[ "${2:-}" == "--verify" && "${3:-}" == "--quiet" ]]; then
		ref="${4:-}"
		case "$ref" in
		refs/heads/main)
			[[ -n "${FAKE_GIT_LOCAL_MAIN:-}" ]]
			exit
			;;
		v*)
			[[ "${FAKE_GIT_TAG_EXISTS:-0}" == "1" ]]
			exit
			;;
		*)
			exit 1
			;;
		esac
	fi

	ref="${2:-}"
	case "$ref" in
	refs/heads/main)
		printf '%s\n' "${FAKE_GIT_LOCAL_MAIN:-}"
		;;
	refs/remotes/origin/main)
		printf '%s\n' "${FAKE_GIT_REMOTE_MAIN:-}"
		;;
	HEAD)
		printf '%s\n' "${FAKE_GIT_HEAD:-}"
		;;
	*)
		exit 0
		;;
	esac
	;;
add|commit|tag|push)
	exit 0
	;;
*)
	echo "unexpected git command: $*" >&2
	exit 99
	;;
esac
EOF
	chmod 700 "${fakebin}/git"
}

create_fake_gh() {
	local fakebin="$1"
	mkdir -p "$fakebin"
	cat >"${fakebin}/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_GH_LOG}"
exit 0
EOF
	chmod 700 "${fakebin}/gh"
}

create_fake_make() {
	local fakebin="$1"
	mkdir -p "$fakebin"
	cat >"${fakebin}/make" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_MAKE_LOG}"
exit "${FAKE_MAKE_EXIT_CODE:-0}"
EOF
	chmod 700 "${fakebin}/make"
}

create_release_repo() {
	local repo="$1"
	mkdir -p "${repo}/scripts"
	cp "${PROJECT_ROOT}/scripts/release.sh" "${repo}/scripts/release.sh"
cat >"${repo}/scripts/set-version.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_SET_VERSION_LOG}"
exit "${FAKE_SET_VERSION_EXIT_CODE:-0}"
EOF
	chmod 700 "${repo}/scripts/release.sh" "${repo}/scripts/set-version.sh"
}

@test "release aborts before mutations when local main is stale" {
	local repo fakebin
	repo="${TEST_TMPDIR}/repo"
	fakebin="${TEST_TMPDIR}/fakebin"
	local git_log gh_log make_log set_version_log
	git_log="${TEST_TMPDIR}/git.log"
	gh_log="${TEST_TMPDIR}/gh.log"
	make_log="${TEST_TMPDIR}/make.log"
	set_version_log="${TEST_TMPDIR}/set-version.log"

	create_release_repo "$repo"
	create_fake_git "$fakebin"
	create_fake_gh "$fakebin"
	create_fake_make "$fakebin"

	run env \
		PATH="${fakebin}:$PATH" \
		FAKE_GIT_LOG="${git_log}" \
		FAKE_GH_LOG="${gh_log}" \
		FAKE_MAKE_LOG="${make_log}" \
		FAKE_SET_VERSION_LOG="${set_version_log}" \
		FAKE_GIT_LOCAL_MAIN=abc123 \
		FAKE_GIT_REMOTE_MAIN=def456 \
		FAKE_GIT_HEAD=abc123 \
		bash "${repo}/scripts/release.sh" 1.2.3

	[ "$status" -eq 1 ]
	[[ "$output" == *"Local main does not match origin/main; aborting release."* ]]
	[[ "$(cat "${git_log}")" == *"fetch --quiet origin main"* ]]
	[ ! -e "${gh_log}" ]
	[ ! -e "${set_version_log}" ]
}

@test "release aborts before mutations when HEAD is not up-to-date main" {
	local repo fakebin
	repo="${TEST_TMPDIR}/repo"
	fakebin="${TEST_TMPDIR}/fakebin"
	local git_log gh_log make_log set_version_log
	git_log="${TEST_TMPDIR}/git.log"
	gh_log="${TEST_TMPDIR}/gh.log"
	make_log="${TEST_TMPDIR}/make.log"
	set_version_log="${TEST_TMPDIR}/set-version.log"

	create_release_repo "$repo"
	create_fake_git "$fakebin"
	create_fake_gh "$fakebin"
	create_fake_make "$fakebin"

	run env \
		PATH="${fakebin}:$PATH" \
		FAKE_GIT_LOG="${git_log}" \
		FAKE_GH_LOG="${gh_log}" \
		FAKE_MAKE_LOG="${make_log}" \
		FAKE_SET_VERSION_LOG="${set_version_log}" \
		FAKE_GIT_LOCAL_MAIN=abc123 \
		FAKE_GIT_REMOTE_MAIN=abc123 \
		FAKE_GIT_HEAD=def456 \
		bash "${repo}/scripts/release.sh" 1.2.3

	[ "$status" -eq 1 ]
	[[ "$output" == *"Release must run from the up-to-date main branch."* ]]
	[[ "$(cat "${git_log}")" == *"fetch --quiet origin main"* ]]
	[ ! -e "${gh_log}" ]
	[ ! -e "${make_log}" ]
	[ ! -e "${set_version_log}" ]
}

@test "release aborts before mutations when release tests fail" {
	local repo fakebin
	repo="${TEST_TMPDIR}/repo"
	fakebin="${TEST_TMPDIR}/fakebin"
	local git_log gh_log make_log set_version_log
	git_log="${TEST_TMPDIR}/git.log"
	gh_log="${TEST_TMPDIR}/gh.log"
	make_log="${TEST_TMPDIR}/make.log"
	set_version_log="${TEST_TMPDIR}/set-version.log"

	create_release_repo "$repo"
	create_fake_git "$fakebin"
	create_fake_gh "$fakebin"
	create_fake_make "$fakebin"

	run env \
		PATH="${fakebin}:$PATH" \
		FAKE_GIT_LOG="${git_log}" \
		FAKE_GH_LOG="${gh_log}" \
		FAKE_MAKE_LOG="${make_log}" \
		FAKE_MAKE_EXIT_CODE=1 \
		FAKE_SET_VERSION_LOG="${set_version_log}" \
		FAKE_GIT_LOCAL_MAIN=abc123 \
		FAKE_GIT_REMOTE_MAIN=abc123 \
		FAKE_GIT_HEAD=abc123 \
		bash "${repo}/scripts/release.sh" 1.2.3

	[ "$status" -eq 1 ]
	[[ "$(cat "${make_log}")" == *"release-test"* ]]
	[[ "$(cat "${make_log}")" != *"pre-push"* ]]
	[ ! -e "${gh_log}" ]
	[ ! -e "${set_version_log}" ]
}

@test "release runs release tests and stages the Codex marketplace manifest" {
	local repo fakebin
	repo="${TEST_TMPDIR}/repo"
	fakebin="${TEST_TMPDIR}/fakebin"
	local git_log gh_log make_log set_version_log
	git_log="${TEST_TMPDIR}/git.log"
	gh_log="${TEST_TMPDIR}/gh.log"
	make_log="${TEST_TMPDIR}/make.log"
	set_version_log="${TEST_TMPDIR}/set-version.log"

	create_release_repo "$repo"
	create_fake_git "$fakebin"
	create_fake_gh "$fakebin"
	create_fake_make "$fakebin"

	run env \
		PATH="${fakebin}:$PATH" \
		FAKE_GIT_LOG="${git_log}" \
		FAKE_GH_LOG="${gh_log}" \
		FAKE_MAKE_LOG="${make_log}" \
		FAKE_SET_VERSION_LOG="${set_version_log}" \
		FAKE_GIT_LOCAL_MAIN=abc123 \
		FAKE_GIT_REMOTE_MAIN=abc123 \
		FAKE_GIT_HEAD=abc123 \
		bash "${repo}/scripts/release.sh" 1.2.3

	[ "$status" -eq 0 ]
	[[ "$(cat "${make_log}")" == *"release-test"* ]]
	[[ "$(cat "${make_log}")" != *"pre-push"* ]]
	[[ "$(cat "${git_log}")" == *".agents/plugins/marketplace.json"* ]]
	[[ "$(cat "${set_version_log}")" == *"1.2.3"* ]]
	[[ "$(cat "${gh_log}")" == *"release create v1.2.3 --generate-notes"* ]]
}
