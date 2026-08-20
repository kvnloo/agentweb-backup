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
# Extract just the `package-ecosystem: github-actions` update block, not the
# whole file.
#
# CAUGHT BY CODE RABBIT (PR #2497): the grouping and preserved-setting checks
# originally grepped the full file. With one update block that is equivalent,
# but it silently stops being a contract about the github-actions block
# specifically the moment a second `updates:` entry exists (e.g. an `npm`
# block) -- a later edit could drop `open-pull-requests-limit: 3` from
# github-actions while adding it to the new block, and every assertion below
# would still pass, having matched the WRONG block. Bounding capture to the
# github-actions entry, ending at the next `  - package-ecosystem:` line (or
# EOF), makes each assertion actually about the block ENG-1042 changed.
# ---------------------------------------------------------------------------

BLOCK="${SCRIPT_DIR}/../.dependabot-config.test.block.tmp"
trap 'rm -f "${BLOCK}"' EXIT

awk '
  /^  - package-ecosystem:/ {
    capturing = ($0 == "  - package-ecosystem: github-actions") ? 1 : 0
  }
  capturing { print }
' "${CONFIG}" >"${BLOCK}"

if [ ! -s "${BLOCK}" ]; then
  printf 'FATAL: no package-ecosystem: github-actions update block found in %s\n' "${CONFIG}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
#
# grep -Pzo over the whole target (NUL-delimited, so it's one "line") lets a
# pattern match across newlines with the (?s) flag where needed, while plain
# ^/$-anchored patterns still match per physical line as usual.
# ---------------------------------------------------------------------------

assert_match() {
  local desc="$1" pattern="$2" target="${3:-${CONFIG}}"
  TESTS_RUN=$((TESTS_RUN + 1))
  if grep -Pzo "${pattern}" "${target}" >/dev/null 2>&1; then
    printf 'PASS: %s\n' "${desc}"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL: %s\n  expected pattern not found in %s: %s\n' "${desc}" "${target}" "${pattern}"
  fi
}

# ---------------------------------------------------------------------------
# New behavior: grouping (ENG-1042 AC1 + AC3), scoped to the github-actions
# update block.
# ---------------------------------------------------------------------------

assert_match 'a groups stanza exists under the github-actions update block' \
  '(?m)^    groups:$' "${BLOCK}"

assert_match 'the group is named github-actions' \
  '(?m)^      github-actions:$' "${BLOCK}"

assert_match 'the group matches every action via a wildcard pattern' \
  '(?ms)^      github-actions:\n        patterns:\n          - "\*"$' "${BLOCK}"

# The rationale comment sits in the file's shared header (above `updates:`,
# alongside the ENG-895 rationale it extends), not inside any one update
# block, so this stays a whole-file check deliberately -- there is nowhere
# inside the block itself for a header comment to live.
assert_match 'a comment near the grouping states the CI-cost rationale, so it is not "cleaned up" as redundant' \
  '(?i)groups?.{0,200}(CI cost|runner-minutes?|batch)|((CI cost|runner-minutes?|batch).{0,200}groups?)'

# ---------------------------------------------------------------------------
# Preserved behavior: cadence, limit, SHA-pinning policy (ENG-1042 AC4,
# ENG-895), scoped to the github-actions update block -- these already pass
# on origin/main and must keep passing after grouping lands, proving the
# change is additive, not a rewrite.
# ---------------------------------------------------------------------------

assert_match 'the weekly Monday cadence is unchanged' \
  '(?m)^      interval: weekly$' "${BLOCK}"
assert_match 'the weekly Monday cadence is unchanged (day)' \
  '(?m)^      day: monday$' "${BLOCK}"

assert_match 'the open-pull-requests-limit of 3 is unchanged' \
  '(?m)^    open-pull-requests-limit: 3$' "${BLOCK}"

assert_match 'the ci commit-message prefix is unchanged' \
  '(?m)^      prefix: ci$' "${BLOCK}"

assert_match 'the Auto label is unchanged' \
  '(?m)^      - Auto$' "${BLOCK}"

# The ENG-895 reference is in the shared file header, same reasoning as the
# CI-cost comment above -- deliberately whole-file, not block-scoped.
assert_match 'the ENG-895 SHA-pinning rationale header is preserved, not replaced' \
  'ENG-895'

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
