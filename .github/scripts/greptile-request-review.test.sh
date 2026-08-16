#!/usr/bin/env bash
#
# Tests for .github/scripts/greptile-request-review.sh (ENG-1282).
#
# `gh` is replaced with a scripted mock on PATH so every branch runs for real
# without posting to GitHub. Run with:
#
#   bash .github/scripts/greptile-request-review.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/greptile-request-review.sh"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

# ---------------------------------------------------------------------------
# Mock gh
# ---------------------------------------------------------------------------
#
# Records every invocation to $WORKDIR/gh-calls.log (one line per call, args
# joined by a literal TAB) and exits with $WORKDIR/gh-exit (default 0).

install_mock_gh() {
  mkdir -p "${WORKDIR}/bin"
  : >"${WORKDIR}/gh-calls.log"
  echo 0 >"${WORKDIR}/gh-exit"
  cat >"${WORKDIR}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${MOCK_LOG}"
exit "$(cat "${MOCK_EXIT}")"
MOCK
  chmod +x "${WORKDIR}/bin/gh"
}

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

run_script() {
  set +e
  LAST_OUTPUT=$(
    PATH="${WORKDIR}/bin:${PATH}" \
    MOCK_LOG="${WORKDIR}/gh-calls.log" \
    MOCK_EXIT="${WORKDIR}/gh-exit" \
    REPO="${TEST_REPO:-}" \
    PR_NUMBER="${TEST_PR_NUMBER:-}" \
    bash "${SCRIPT}" 2>&1
  )
  LAST_RC=$?
  set -e
}

check() {
  local desc="$1" expect_rc="$2" expect_substr="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "${LAST_RC}" -ne "${expect_rc}" ]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL: %s\n  expected exit %s, got %s\n  output: %s\n' \
      "${desc}" "${expect_rc}" "${LAST_RC}" "${LAST_OUTPUT}"
    return
  fi
  if [ -n "${expect_substr}" ] && [[ "${LAST_OUTPUT}" != *"${expect_substr}"* ]]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL: %s\n  expected output to contain: %s\n  actual output: %s\n' \
      "${desc}" "${expect_substr}" "${LAST_OUTPUT}"
    return
  fi
  printf 'PASS: %s\n' "${desc}"
}

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

install_mock_gh

TEST_REPO=''
TEST_PR_NUMBER='42'
run_script
check 'missing REPO fails loudly and names the variable' 1 'REPO'

TEST_REPO='AgentWebPro/agentweb'
TEST_PR_NUMBER=''
run_script
check 'missing PR_NUMBER fails loudly and names the variable' 1 'PR_NUMBER'

TEST_REPO='AgentWebPro/agentweb'
TEST_PR_NUMBER='2425'
echo 0 >"${WORKDIR}/gh-exit"
run_script
check 'happy path exits 0 and confirms the request' 0 'requested a fresh Greptile review'

if grep -qF 'pr comment 2425 --repo AgentWebPro/agentweb --body @greptileai' "${WORKDIR}/gh-calls.log"; then
  TESTS_RUN=$((TESTS_RUN + 1))
  printf 'PASS: %s\n' 'gh was called with the exact PR, repo, and @greptileai mention'
else
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  gh-calls.log: %s\n' \
    'gh was called with the exact PR, repo, and @greptileai mention' \
    "$(cat "${WORKDIR}/gh-calls.log")"
fi

# A push-per-push caller is exactly the cost this change removes: prove the
# script has no built-in dedupe, so that discipline lives in the caller
# (loop-sprint-worker.md / loop-pr-ops.md), not silently in this script.
: >"${WORKDIR}/gh-calls.log"
run_script
run_script
CALL_COUNT=$(grep -cF 'pr comment' "${WORKDIR}/gh-calls.log")
TESTS_RUN=$((TESTS_RUN + 1))
if [ "${CALL_COUNT}" -eq 2 ]; then
  printf 'PASS: %s\n' 'two calls post two comments (no silent dedupe to hide behind)'
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  expected 2 gh calls, got %s\n' \
    'two calls post two comments (no silent dedupe to hide behind)' "${CALL_COUNT}"
fi

TEST_REPO='AgentWebPro/agentweb'
TEST_PR_NUMBER='2425'
echo 1 >"${WORKDIR}/gh-exit"
run_script
check 'a gh failure fails loudly rather than reporting success' 1 'GREPTILE_REQUEST_REVIEW_FAILED'

# gh missing from PATH entirely. GitHub-hosted runners preinstall gh under
# /usr/bin, so an empty isolated directory is used rather than trusting any
# real system path to be gh-free. The script needs no external binary besides
# gh — `command -v` and everything else here are bash builtins — so this is
# safe.
EMPTY_PATH_DIR="${WORKDIR}/empty-path"
mkdir -p "${EMPTY_PATH_DIR}"
BASH_BIN="$(command -v bash)"
set +e
LAST_OUTPUT=$(PATH="${EMPTY_PATH_DIR}" REPO='AgentWebPro/agentweb' PR_NUMBER='1' "${BASH_BIN}" "${SCRIPT}" 2>&1)
LAST_RC=$?
set -e
check 'gh missing from PATH fails loudly' 1 'gh CLI is not on PATH'

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
