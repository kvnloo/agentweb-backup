#!/usr/bin/env bash
#
# Structural invariants for the `greptile-review` job's Dependabot bypass
# (ENG-1282).
#
# greptile.json excludes dependabot[bot] from Greptile review
# (excludeAuthors), so Greptile will NEVER post a verdict for a Dependabot
# PR. Without the bypass steps in .github/workflows/tests.yml,
# greptile-gate.sh would poll its full 10-minute timeout and report
# `unavailable` on EVERY Dependabot PR forever — a required check that can
# never pass, silently blocking all dependency bumps.
#
# This can't be exercised by greptile-gate.test.sh (that suite mocks the
# script's own inputs, not the surrounding workflow YAML), and nobody can
# open a PR authored by the real `dependabot[bot]` to prove it live. So the
# properties are asserted statically here, the same way
# agentweb-customer-portal/.github/scripts/workflow-invariants.test.sh pins
# this repo's Greptile/test-build coupling: every property below, if
# silently broken, leaves the workflow valid and every OTHER test green
# while Dependabot PRs go permanently red.
#
#   bash .github/scripts/greptile-dependabot-bypass.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW="$(cd "${SCRIPT_DIR}/.." && pwd)/workflows/tests.yml"

TESTS_RUN=0
TESTS_FAILED=0

pass() { TESTS_RUN=$((TESTS_RUN + 1)); printf 'ok    %s\n' "$1"; }
fail() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL  %s\n' "$1"
  shift
  for line in "$@"; do printf '      %s\n' "${line}"; done
}

if [ ! -f "${WORKFLOW}" ]; then
  printf 'FAIL  tests.yml not found at %s\n' "${WORKFLOW}"
  exit 1
fi

# Isolate the greptile-review job block (up to the next top-level job key).
JOB_BLOCK="$(awk '
  $0 == "  greptile-review:" { in_job = 1; print; next }
  in_job && /^  [a-z]/       { exit }
  in_job                     { print }
' "${WORKFLOW}")"

if [ -z "${JOB_BLOCK}" ]; then
  fail "could not locate the greptile-review job in tests.yml at all." \
       "Either the job was renamed (update this test) or something is badly broken."
else
  pass "greptile-review job block located"
fi

if printf '%s\n' "${JOB_BLOCK}" | grep -qF "id: dependabot_skip"; then
  pass "a dependabot_skip step exists"
else
  fail "no step with id: dependabot_skip found in greptile-review." \
       "Without it, excludeAuthors in greptile.json (which stops Greptile from" \
       "ever reviewing a Dependabot PR) leaves the required check polling for a" \
       "verdict that will never arrive — every Dependabot PR goes permanently red."
fi

if printf '%s\n' "${JOB_BLOCK}" | grep -qF "user.login == 'dependabot[bot]'"; then
  pass "the skip step is gated on the PR author being dependabot[bot]"
else
  fail "no step condition matches on user.login == 'dependabot[bot]'." \
       "Author-based (github.event.pull_request.user.login), not actor-based —" \
       "see backend-staging-deploy's existing bypass for why: a human pushing to" \
       "fix a Dependabot branch must not gain or lose the bypass."
fi

if printf '%s\n' "${JOB_BLOCK}" | grep -qF "user.login != 'dependabot[bot]'"; then
  pass "the real gate step (id: gate) is skipped for dependabot[bot]"
else
  fail "the 'gate' step (running greptile-gate.sh) has no != 'dependabot[bot]' guard." \
       "Without it, the real gate step still runs and polls for 10 minutes on" \
       "every Dependabot PR even though the skip step already decided the verdict."
fi

OUTPUTS_LINE="$(printf '%s\n' "${JOB_BLOCK}" | grep -F 'verdict: ' | head -n 1)"
if printf '%s' "${OUTPUTS_LINE}" | grep -qF 'steps.gate.outputs.verdict' \
  && printf '%s' "${OUTPUTS_LINE}" | grep -qF 'steps.dependabot_skip.outputs.verdict'; then
  pass "the job's verdict output reads from BOTH the gate step and the skip step"
else
  fail "the job-level 'verdict' output does not reference both steps.gate and steps.dependabot_skip." \
       "Found: '${OUTPUTS_LINE}'" \
       "Whichever step didn't run (they're mutually exclusive by author) must still" \
       "surface its sibling's verdict, or the output is empty for one branch."
fi

FAIL_STEP="$(awk '
  /Fail the gate unless Greptile returned 5\/5/ { found = 1; next }
  found && /if:/ { print; exit }
' "${WORKFLOW}")"
if printf '%s' "${FAIL_STEP}" | grep -qF 'steps.gate.outputs.verdict' \
  && printf '%s' "${FAIL_STEP}" | grep -qF 'steps.dependabot_skip.outputs.verdict'; then
  pass "the 'Fail the gate unless...' step also checks both step outputs"
else
  fail "the fail-step's if: condition does not reference both steps.gate and steps.dependabot_skip." \
       "Found: '${FAIL_STEP}'" \
       "If this only checks steps.gate.outputs.verdict, a Dependabot PR (where that" \
       "step never ran) reads verdict as empty, empty != 'pass' is true, and the job" \
       "fails anyway — the bypass would be a no-op."
fi

# greptile.json must actually carry the exclusion this whole bypass exists
# to compensate for, or the workflow complexity above is protecting against
# a config that no longer matches it.
GREPTILE_JSON="$(cd "${SCRIPT_DIR}/../.." && pwd)/greptile.json"
if [ -f "${GREPTILE_JSON}" ] && grep -qF '"dependabot[bot]"' "${GREPTILE_JSON}"; then
  pass "greptile.json still excludes dependabot[bot] (the premise this bypass depends on)"
else
  fail "greptile.json no longer excludes dependabot[bot], but the workflow bypass is still here." \
       "Either restore excludeAuthors in greptile.json, or remove the now-pointless" \
       "dependabot_skip step (a bypass for an exclusion that doesn't exist is dead code)."
fi

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
