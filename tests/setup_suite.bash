#!/usr/bin/env bash
# Global test setup for bats tests

# Determine the tests root directory (where setup_suite.bash lives)
SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export TESTS_ROOT="${SETUP_DIR}"
export PROJECT_ROOT="$(cd "${SETUP_DIR}/.." && pwd)"
export HOOKS_DIR="${PROJECT_ROOT}/hooks"
export FIXTURES_DIR="${TESTS_ROOT}/fixtures"

# Load bats helpers when vendored, otherwise fall back to minimal assertions so
# the suite runs from a clean checkout.
if [ -f "${TESTS_ROOT}/test_helper/bats-support/load.bash" ] || [ -f "${TESTS_ROOT}/test_helper/bats-support/load" ]; then
    load "${TESTS_ROOT}/test_helper/bats-support/load"
fi

if [ -f "${TESTS_ROOT}/test_helper/bats-assert/load.bash" ] || [ -f "${TESTS_ROOT}/test_helper/bats-assert/load" ]; then
    load "${TESTS_ROOT}/test_helper/bats-assert/load"
else
    assert_success() {
        [ "${status}" -eq 0 ]
    }

    assert_output() {
        [ "${output}" = "$1" ]
    }
fi
