#!/usr/bin/env bash
#
# Tests for .github/scripts/greptile-verdict-policy.sh (ENG-1277 follow-up,
# 2026-08-18).
#
# Pure decision, no `gh`/network involved — the verdict string is the only
# input, so no mocking is needed.
#
# Run with:  bash .github/scripts/greptile-verdict-policy.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/greptile-verdict-policy.sh"

TESTS_RUN=0
TESTS_FAILED=0

pass() { printf '  PASS %s\n' "$1"; }

run() {
  # run <verdict> — invokes the script, capturing exit code and combined output.
  set +e
  LAST_OUTPUT="$(bash "${SCRIPT}" "$1" 2>&1)"
  LAST_EXIT=$?
  set -e
}

check() {
  # check <description> <expected_exit> <expected substring>
  local desc="$1" expected_exit="$2" needle="$3"
  TESTS_RUN=$(( TESTS_RUN + 1 ))

  if [ "${LAST_EXIT}" -ne "${expected_exit}" ]; then
    printf '  FAIL %s\n       expected exit %s, got %s\n       output:\n%s\n' \
      "${desc}" "${expected_exit}" "${LAST_EXIT}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi

  # ENG-1277: here-string, not a pipe — avoids a SIGPIPE-under-pipefail race.
  if [ -n "${needle}" ] && ! grep -qF "${needle}" <<<"${LAST_OUTPUT}"; then
    printf '  FAIL %s\n       output did not contain: %s\n       output:\n%s\n' \
      "${desc}" "${needle}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi

  pass "${desc}"
}

printf 'greptile-verdict-policy.sh\n'

# ---------------------------------------------------------------------------
# pass -> the job passes, plainly. A genuine 5/5 landed for this exact head.
# ---------------------------------------------------------------------------

run 'pass'
check 'pass -> exit 0' 0 ''
check 'pass -> says PASS, not a warning' 0 'PASS'

# ---------------------------------------------------------------------------
# refused -> still a hard block. Greptile reviewed THIS head and scored it
# below the bar — a real negative signal, unchanged from before this policy.
# ---------------------------------------------------------------------------

run 'refused'
check 'refused -> exit 1 (still blocks)' 1 ''
check 'refused -> message says it is a real finding' 1 'reviewed this head'

# ---------------------------------------------------------------------------
# unavailable -> the actual policy change (2026-08-18): Greptile never
# returned ANY verdict for this head within the poll window. Do not block
# already-proven code on a service that is not answering.
# ---------------------------------------------------------------------------

run 'unavailable'
check 'unavailable -> exit 0 (does not block)' 0 ''
check 'unavailable -> emits a GitHub Actions warning annotation' 0 '::warning::'
check 'unavailable -> says it never answered, not that it found something' 0 'never returned a verdict'

# ---------------------------------------------------------------------------
# Fails closed on anything unrecognized — a typo or a new verdict string this
# script does not know about must never silently pass.
# ---------------------------------------------------------------------------

run 'some-typo-or-future-verdict'
check 'unrecognized verdict -> exit 1 (fail closed)' 1 ''
check 'unrecognized verdict -> names what it got' 1 'some-typo-or-future-verdict'

run ''
check 'empty verdict -> exit 1 (fail closed, not treated as unavailable)' 1 ''

# ---------------------------------------------------------------------------
# Missing argument entirely — a caller bug, not a normal verdict.
# ---------------------------------------------------------------------------

set +e
LAST_OUTPUT="$(bash "${SCRIPT}" 2>&1)"
LAST_EXIT=$?
set -e
check 'no argument at all -> exit 1 with a usage message' 1 'usage:'

# ---------------------------------------------------------------------------
# Extra arguments — the contract is exactly one verdict string. Silently
# accepting and ignoring extras would hide a caller bug that passes the wrong
# thing alongside the real verdict.
# ---------------------------------------------------------------------------

set +e
LAST_OUTPUT="$(bash "${SCRIPT}" 'pass' 'extra' 2>&1)"
LAST_EXIT=$?
set -e
check 'more than one argument -> exit 1 with a usage message' 1 'usage:'

# ---------------------------------------------------------------------------

printf '\n%s test(s), %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ]
