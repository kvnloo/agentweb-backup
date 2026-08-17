#!/usr/bin/env bash
#
# Tests for .github/scripts/dependabot-integrity-check.sh (ENG-1287).
#
# Run with:  bash .github/scripts/dependabot-integrity-check.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/dependabot-integrity-check.sh"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

install_mock_gh() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ]; then
  exit_code="$(cat "${MOCK_EXIT}" 2>/dev/null || echo 0)"
  if [ "${exit_code}" = "1" ]; then
    echo "mock gh: simulated total transient failure" >&2
    exit 1
  fi
  if [ "${exit_code}" = "2" ]; then
    cat "${MOCK_PARTIAL}" 2>/dev/null || true
    echo "mock gh: simulated partial-pagination failure (later page errored)" >&2
    exit 1
  fi
  cat "${MOCK_FILES}"
  exit 0
fi
echo "mock gh: unhandled invocation: $*" >&2
exit 99
MOCK
  chmod +x "${WORKDIR}/bin/gh"
}

files_untouched() {
  cat <<'EOF'
[
  {"filename": "package.json"},
  {"filename": "package-lock.json"}
]
EOF
}

files_touches_scripts_dir() {
  cat <<'EOF'
[
  {"filename": "package.json"},
  {"filename": ".github/scripts/dependabot-only-pr.sh"}
]
EOF
}

files_touches_workflow() {
  cat <<'EOF'
[
  {"filename": ".github/workflows/tests.yml"}
]
EOF
}

files_touches_greptile_json() {
  cat <<'EOF'
[
  {"filename": "greptile.json"}
]
EOF
}

files_touches_unrelated_dotgithub_file() {
  # A path that merely STARTS with a similar string but isn't actually under
  # .github/ must not be a false positive (prefix matching, not substring).
  cat <<'EOF'
[
  {"filename": ".github-actions-notes.md"}
]
EOF
}

files_empty() {
  echo '[]'
}

run_script() {
  set +e
  LAST_OUTPUT=$(
    PATH="${WORKDIR}/bin:${PATH}" \
    MOCK_FILES="${WORKDIR}/files.json" \
    MOCK_EXIT="${WORKDIR}/exit_code" \
    MOCK_PARTIAL="${WORKDIR}/files_partial.json" \
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

install_mock_gh
echo 0 >"${WORKDIR}/exit_code"

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

TEST_REPO=''
run_script
check 'missing REPO fails loudly' 1 'REPO'

TEST_REPO='AgentWebPro/agentweb'
TEST_PR_NUMBER=''
run_script
check 'missing PR_NUMBER fails loudly' 1 'PR_NUMBER'

TEST_PR_NUMBER='2427'
files_untouched >"${WORKDIR}/files.json"
run_script
check 'an ordinary dependency-bump diff (no .github/ touched) passes' 0 'Untampered'

files_touches_scripts_dir >"${WORKDIR}/files.json"
run_script
check 'a diff touching .github/scripts/ fails closed' 1 \
  'a Dependabot-authored PR modified CI-security-relevant path'
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "${LAST_OUTPUT}" == *'.github/scripts/dependabot-only-pr.sh'* ]]; then
  printf 'PASS: %s\n' 'the specific guarded path is named in the failure output'
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  output: %s\n' 'the specific guarded path is named in the failure output' "${LAST_OUTPUT}"
fi

files_touches_workflow >"${WORKDIR}/files.json"
run_script
check 'a diff touching .github/workflows/ fails closed' 1 \
  'a Dependabot-authored PR modified CI-security-relevant path'

files_touches_greptile_json >"${WORKDIR}/files.json"
run_script
check 'a diff touching greptile.json fails closed' 1 \
  'a Dependabot-authored PR modified CI-security-relevant path'

files_touches_unrelated_dotgithub_file >"${WORKDIR}/files.json"
run_script
check 'a filename that merely starts with a similar string (not actually under .github/) is NOT a false positive' 0 \
  'Untampered'

files_empty >"${WORKDIR}/files.json"
run_script
check 'zero changed files fails loudly rather than vacuously passing' 1 \
  'zero changed files'

files_untouched >"${WORKDIR}/files.json"
echo 1 >"${WORKDIR}/exit_code"
run_script
check 'a total API failure fails closed, not treated as untampered' 1 \
  'DEPENDABOT_INTEGRITY_CHECK_FAILED'
echo 0 >"${WORKDIR}/exit_code"

# Partial-pagination failure: non-empty output, non-zero exit. Must be
# treated as a failure, never as "here is the complete file list" — same
# class of bug caught live in greptile-request-review.sh this same session.
files_touches_unrelated_dotgithub_file >"${WORKDIR}/files_partial.json"
files_untouched >"${WORKDIR}/files.json"
echo 2 >"${WORKDIR}/exit_code"
run_script
check 'a partial-pagination failure (non-empty output, non-zero exit) fails closed, not treated as a complete untampered list' 1 \
  'DEPENDABOT_INTEGRITY_CHECK_FAILED'
echo 0 >"${WORKDIR}/exit_code"

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
