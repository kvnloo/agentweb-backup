#!/usr/bin/env bash
#
# Contract tests for the `backend-staging-deploy` job condition in
# .github/workflows/tests.yml (ENG-991).
#
# Unlike its sibling suites this one has no script under test — the thing it
# guards is a job-level `if:` expression, which GitHub evaluates and nothing in
# this repo can execute locally. So it parses the real workflow and asserts the
# clauses of that expression, which is a weaker proof than running it and is
# deliberately still worth having: this condition is the last gate in front of a
# job that holds production-adjacent AWS credentials and the single shared
# staging lane, and every way it can silently rot is a clause quietly going
# missing from one long boolean.
#
# The clause that motivated the file is the Dependabot guard, but it is NOT the
# valuable assertion. The valuable ones are the five pre-existing gates: if a
# later edit "simplifies" this expression and drops
# `needs.backend-tests-a.result == 'success'`, staging deploys without the
# backend suite having passed, no check turns red, and nobody finds out. That is
# the ENG-754/ENG-757 shape — a merge gate deleted by an edit that looks tidy.
#
# Run with:  bash .github/scripts/staging-deploy-gate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW="${SCRIPT_DIR}/../workflows/tests.yml"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

if [ ! -f "${WORKFLOW}" ]; then
  printf 'FATAL: workflow not found at %s\n' "${WORKFLOW}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Extractor
#
# Returns a named job's `if:` expression from the workflow, whitespace
# normalised onto one line so the block (`if: >-`) and inline forms compare
# identically — the fix reformatted this very expression from inline to block,
# and a test that could not survive that reformat would be testing the layout
# rather than the gate.
#
# Deliberately not PyYAML: it is not guaranteed on the runner image, and a
# missing import here would fail this job for a reason unrelated to the gate.
# ---------------------------------------------------------------------------
EXTRACTOR="${WORKDIR}/job_if.py"
cat >"${EXTRACTOR}" <<'PY'
import re
import sys

path, job = sys.argv[1], sys.argv[2]

with open(path, encoding="utf-8") as fh:
    lines = fh.read().split("\n")

try:
    start = next(i for i, l in enumerate(lines) if l.rstrip() == "jobs:")
except StopIteration:
    sys.stderr.write("no `jobs:` block\n")
    sys.exit(2)

header = "  %s:" % job
try:
    j = next(i for i in range(start + 1, len(lines)) if lines[i].rstrip() == header)
except StopIteration:
    sys.stderr.write("job not found: %s\n" % job)
    sys.exit(3)

# The job body runs until the next 2-space-indented token, which is either the
# next job header or the comment block introducing it. Step keys sit at 4+
# spaces, so nothing inside the job terminates this early.
body = []
for line in lines[j + 1:]:
    if re.match(r"^  \S", line):
        break
    body.append(line)

expr = None
for k, line in enumerate(body):
    m = re.match(r"^    if:\s*(.*)$", line)
    if not m:
        continue
    value = m.group(1).strip()
    if value in (">-", ">", "|", "|-", ""):
        collected = []
        for nxt in body[k + 1:]:
            if not nxt.strip():
                continue
            indent = len(nxt) - len(nxt.lstrip())
            if indent <= 4:
                break
            collected.append(nxt.strip())
        expr = " ".join(collected)
    else:
        expr = value
    break

sys.stdout.write(" ".join(expr.split()) if expr else "")
PY

job_if() {
  python3 "${EXTRACTOR}" "${WORKFLOW}" "$1"
}

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------
pass_test() {
  TESTS_RUN=$((TESTS_RUN + 1))
  printf '  ok   %s\n' "$1"
}

fail_test() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf '  FAIL %s\n' "$1"
  printf '       %s\n' "$2"
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  case "${haystack}" in
    *"${needle}"*) pass_test "${label}" ;;
    *) fail_test "${label}" "expected to find: ${needle}" ;;
  esac
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3" why="$4"
  case "${haystack}" in
    *"${needle}"*) fail_test "${label}" "must NOT contain '${needle}': ${why}" ;;
    *) pass_test "${label}" ;;
  esac
}

DEPLOY_IF="$(job_if backend-staging-deploy)"
if [ -z "${DEPLOY_IF}" ]; then
  printf 'FATAL: could not read the if: condition of backend-staging-deploy.\n' >&2
  printf 'A job with no condition runs unconditionally — that is the failure this suite exists to catch, not a parse detail to shrug at.\n' >&2
  exit 1
fi

printf 'staging-deploy-gate: backend-staging-deploy\n'
printf '  if: %s\n' "${DEPLOY_IF}"

# --- The five pre-existing gates. These are the load-bearing assertions. -----
assert_contains "${DEPLOY_IF}" "github.event.pull_request.draft == false" \
  "drafts do not deploy to staging"
assert_contains "${DEPLOY_IF}" "needs.detect-changes.outputs.backend == 'true'" \
  "only backend-touching PRs deploy (ENG-743 path filter)"
assert_contains "${DEPLOY_IF}" "needs.backend-tests-a.result == 'success'" \
  "agentMode suite must have PASSED, not merely not-failed"
assert_contains "${DEPLOY_IF}" "needs.backend-tests-b.result == 'success'" \
  "non-agentMode + coverage suite must have PASSED"
assert_contains "${DEPLOY_IF}" "needs.greptile-review.result == 'success'" \
  "Greptile gate must have PASSED (ENG-754)"

# --- The ENG-991 guard. ------------------------------------------------------
assert_contains "${DEPLOY_IF}" "github.event.pull_request.user.login != 'dependabot[bot]'" \
  "Dependabot PRs skip a deploy they cannot authenticate"

# `github.actor` is whoever triggered THIS run, so a human pushing to or
# reopening a Dependabot branch flips it to that human while the PR still runs
# with no secrets. The actor-based form therefore reintroduces the credential
# failure on precisely the push someone made trying to fix it.
assert_not_contains "${DEPLOY_IF}" "github.actor" \
  "guard keys on the PR author, never the triggering actor" \
  "github.actor is the triggering actor and changes when a human touches a Dependabot branch"

# --- Containment: the guard belongs on the deploy job and nowhere else. ------
# Dependabot PRs must still run the full backend suite and the Greptile gate.
# They change .github/workflows/tests.yml, which the `backend` filter counts as
# a backend change precisely so the CI path gates its own changes (ENG-743);
# skipping the tests for Dependabot would make that self-gating vacuous and let
# an action bump land having exercised nothing.
for job in backend-tests-a backend-tests-b greptile-review; do
  assert_not_contains "$(job_if "${job}")" "dependabot" \
    "${job} still runs for Dependabot PRs" \
    "Dependabot bumps must be tested and reviewed like any other PR"
done

# ---------------------------------------------------------------------------
printf '\nstaging-deploy-gate: %d run, %d failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
