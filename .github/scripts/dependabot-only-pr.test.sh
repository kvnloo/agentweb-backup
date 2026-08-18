#!/usr/bin/env bash
#
# Tests for .github/scripts/dependabot-only-pr.sh (ENG-1282).
#
# `gh` is replaced with a scripted mock on PATH so every branch runs for real
# without touching GitHub.
#
# Run with:  bash .github/scripts/dependabot-only-pr.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/dependabot-only-pr.sh"

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
  if [ "${exit_code}" != "0" ]; then
    echo "mock gh: simulated API failure" >&2
    exit "${exit_code}"
  fi
  cat "${MOCK_COMMITS}"
  exit 0
fi
echo "mock gh: unhandled invocation: $*" >&2
exit 99
MOCK
  chmod +x "${WORKDIR}/bin/gh"
}

# Shape matches what was verified live against a real Dependabot PR
# (agentweb#2276): author.login resolves to dependabot[bot] AND
# commit.verification.verified is true, reason "valid".
commits_all_dependabot() {
  cat <<'EOF'
[
  {"sha": "aaa", "author": {"login": "dependabot[bot]"}, "commit": {"verification": {"verified": true, "reason": "valid"}}},
  {"sha": "bbb", "author": {"login": "dependabot[bot]"}, "commit": {"verification": {"verified": true, "reason": "valid"}}}
]
EOF
}

# Shape matches what was verified live on this org's own commit history:
# not every human commit is signed (several of harshmoney123's own show
# verified:false, reason:"unsigned") -- included here as the "ordinary,
# not an attack" mixed case.
commits_mixed() {
  cat <<'EOF'
[
  {"sha": "aaa", "author": {"login": "dependabot[bot]"}, "commit": {"verification": {"verified": true, "reason": "valid"}}},
  {"sha": "bbb", "author": {"login": "harshmoney123"}, "commit": {"verification": {"verified": false, "reason": "unsigned"}}},
  {"sha": "ccc", "author": {"login": "dependabot[bot]"}, "commit": {"verification": {"verified": true, "reason": "valid"}}}
]
EOF
}

# THE forgery Greptile caught: a human sets their local git author email to
# Dependabot's real, public noreply address (49699333+dependabot[bot]@
# users.noreply.github.com). GitHub resolves .author.login to
# "dependabot[bot]" exactly as it would for the genuine bot -- but the human
# cannot produce a signature GitHub attributes to dependabot[bot]'s own
# signing identity, so verification fails. Author-login-only would have
# waved this straight through; this is why verification is required too.
commits_forged_author() {
  cat <<'EOF'
[
  {"sha": "aaa", "author": {"login": "dependabot[bot]"}, "commit": {"author": {"email": "49699333+dependabot[bot]@users.noreply.github.com"}, "verification": {"verified": false, "reason": "unsigned"}}}
]
EOF
}

commits_unlinked_author() {
  cat <<'EOF'
[
  {"sha": "aaa", "author": null, "commit": {"author": {"email": "someone@example.com"}, "verification": {"verified": false, "reason": "unsigned"}}}
]
EOF
}

commits_empty() {
  echo '[]'
}

run_script() {
  set +e
  LAST_OUTPUT=$(
    PATH="${WORKDIR}/bin:${PATH}" \
    MOCK_COMMITS="${WORKDIR}/commits.json" \
    MOCK_EXIT="${WORKDIR}/exit_code" \
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

TEST_REPO='AgentWebPro/agentweb-customer-portal'
TEST_PR_NUMBER=''
run_script
check 'missing PR_NUMBER fails loudly' 1 'PR_NUMBER'

TEST_PR_NUMBER='1037'
commits_all_dependabot >"${WORKDIR}/commits.json"
run_script
check 'all-dependabot commit history passes' 0 'Bypass-eligible'

# THE exact scenario Greptile caught: a human commit sits in the history
# alongside dependabot commits (e.g. a human pushed, then dependabot pushed
# again later). Must fail, regardless of which commit is most recent.
commits_mixed >"${WORKDIR}/commits.json"
run_script
check 'a mixed human/dependabot history fails, even with dependabot commits present' 1 \
  'Not bypass-eligible'
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "${LAST_OUTPUT}" == *'1 of 3'* ]]; then
  printf 'PASS: %s\n' 'reports the exact non-dependabot commit count (1 of 3)'
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  output: %s\n' 'reports the exact non-dependabot commit count (1 of 3)' "${LAST_OUTPUT}"
fi

# THE forgery Greptile caught in a second review pass, on this same script:
# author.login alone is forgeable (self-declared git config, not
# authenticated). A forged-but-unsigned commit must fail even though
# .author.login reads exactly like the real thing.
commits_forged_author >"${WORKDIR}/commits.json"
run_script
check 'a forged author email with no valid Dependabot signature fails, not waved through' 1 \
  'Not bypass-eligible'

# An all-dependabot-author history where the signature itself is missing/
# invalid must ALSO fail -- verification is required, not merely present as
# an extra field that could be ignored.
commits_forged_author >"${WORKDIR}/commits_no_sig.json"
jq '.[0].commit.verification = {}' "${WORKDIR}/commits_no_sig.json" >"${WORKDIR}/commits.json"
run_script
check 'a missing verification object fails closed, not treated as verified' 1 \
  'Not bypass-eligible'

# An unlinked commit author (no GitHub account resolves the email) must
# fail closed -- never treated as "probably fine".
commits_unlinked_author >"${WORKDIR}/commits.json"
run_script
check 'an unlinked/unresolvable commit author fails closed, not treated as safe' 1 \
  'Not bypass-eligible'

# Zero commits is not a valid "all commits are dependabot" state -- it's an
# empty precondition that must never be treated as vacuously true.
commits_empty >"${WORKDIR}/commits.json"
run_script
check 'zero commits fails loudly rather than vacuously passing' 1 \
  'zero commits'

commits_all_dependabot >"${WORKDIR}/commits.json"
echo 1 >"${WORKDIR}/exit_code"
run_script
check 'a GitHub API failure fails closed, not treated as safe' 1 \
  'DEPENDABOT_ONLY_PR_CHECK_FAILED'
echo 0 >"${WORKDIR}/exit_code"

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
