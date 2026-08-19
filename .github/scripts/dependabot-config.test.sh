#!/usr/bin/env bash
#
# Contract tests for .github/dependabot.yml's github-actions grouping
# (ENG-1042).
#
# Unlike its sibling suites in this directory, this one has no script under
# test -- dependabot.yml is pure declarative config that only GitHub's own
# Dependabot service interprets, and nothing in this repo can execute it
# locally (same situation as staging-deploy-gate.test.sh, which documents the
# same tradeoff). So this parses the real file and asserts its structure:
# that multiple github-actions releases in one week are configured to group
# into a single PR, and that grouping did NOT regress the weekly cadence, the
# PR limit, the commit-message prefix, the label, or the SHA-pinning
# rationale from ENG-895 -- the exact "no change to cadence/policy" clause in
# ENG-1042's acceptance criteria.
#
# What this does NOT and cannot prove: that a real week with multiple
# github-actions releases actually produces one PR from GitHub's Dependabot
# service, and that the resulting PR still updates both the SHA and the
# trailing version comment for every action it bumps (ENG-1042 AC1/AC2).
# That is live Dependabot behavior with no local harness -- the issue's own
# "Notes for whoever takes it" section says to verify it operationally,
# not to fake a simulation of it here.
#
# Deliberately grep, not PyYAML: same reasoning as staging-deploy-gate.test.sh
# -- PyYAML is not guaranteed on the runner image, and a missing import here
# would fail this job for a reason unrelated to the actual contract.
#
# Run with:  bash .github/scripts/dependabot-config.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${SCRIPT_DIR}/../dependabot.yml"

TESTS_RUN=0
TESTS_FAILED=0

if [ ! -f "${CONFIG}" ]; then
  printf 'FATAL: dependabot.yml not found at %s\n' "${CONFIG}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
#
# grep -Pzo over the whole file (NUL-delimited, so it's one "line") lets a
# pattern match across newlines with the (?s) flag where needed, while plain
# ^/$-anchored patterns still match per physical line as usual.
# ---------------------------------------------------------------------------

assert_match() {
  local desc="$1" pattern="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if grep -Pzo "${pattern}" "${CONFIG}" >/dev/null 2>&1; then
    printf 'PASS: %s\n' "${desc}"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL: %s\n  expected pattern not found in %s: %s\n' "${desc}" "${CONFIG}" "${pattern}"
  fi
}

# ---------------------------------------------------------------------------
# New behavior: grouping (ENG-1042 AC1 + AC3)
# ---------------------------------------------------------------------------

assert_match 'a groups stanza exists under the github-actions update block' \
  '(?m)^    groups:$'

assert_match 'the group is named github-actions' \
  '(?m)^      github-actions:$'

assert_match 'the group matches every action via a wildcard pattern' \
  '(?ms)^      github-actions:\n        patterns:\n          - "\*"$'

assert_match 'a comment near the grouping states the CI-cost rationale, so it is not "cleaned up" as redundant' \
  '(?i)groups?.{0,200}(CI cost|runner-minutes?|batch)|((CI cost|runner-minutes?|batch).{0,200}groups?)'

# ---------------------------------------------------------------------------
# Preserved behavior: cadence, limit, SHA-pinning policy (ENG-1042 AC4,
# ENG-895) -- these already pass on origin/main and must keep passing after
# grouping lands, proving the change is additive, not a rewrite.
# ---------------------------------------------------------------------------

assert_match 'the weekly Monday cadence is unchanged' \
  '(?m)^      interval: weekly$'
assert_match 'the weekly Monday cadence is unchanged (day)' \
  '(?m)^      day: monday$'

assert_match 'the open-pull-requests-limit of 3 is unchanged' \
  '(?m)^    open-pull-requests-limit: 3$'

assert_match 'the ci commit-message prefix is unchanged' \
  '(?m)^      prefix: ci$'

assert_match 'the Auto label is unchanged' \
  '(?m)^      - Auto$'

assert_match 'the ENG-895 SHA-pinning rationale header is preserved, not replaced' \
  'ENG-895'

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
