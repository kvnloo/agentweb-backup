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
# paths-filter step extractor (ENG-1041)
#
# The deploy decision stopped being expressible as one `if:` clause: it is now
# an `if:` clause reading a job output that a `dorny/paths-filter` step
# computes. Reading only the `if:` would leave the half that actually decides
# whether staging deploys unasserted.
#
# `audit` mode exists for one specific fail-open. dorny/paths-filter compiles
# EACH pattern in a filter into its own picomatch matcher and OR-combines them
# (`patterns.some(...)`; `predicate-quantifier` defaults to `some`) — verified
# in src/filter.ts at the pinned SHA. So a `!`-negated pattern written in a
# default filter is not an exclusion: picomatch returns TRUE for every path
# outside the named one, so `'backend/**'` + `'!backend/**/__tests__/**'` is
# true for README.md, and the filter it sits in is permanently true. A
# narrowing that reads correctly would silently become a widening that deploys
# staging on every PR in the repo. The only thing standing between those two
# outcomes is `predicate-quantifier: 'every'`, one line away from the patterns
# it governs, so it gets its own assertion rather than trust.
# ---------------------------------------------------------------------------
STEP_EXTRACTOR="${WORKDIR}/filter_steps.py"
cat >"${STEP_EXTRACTOR}" <<'PY'
import re
import sys

path, mode = sys.argv[1], sys.argv[2]
arg = sys.argv[3] if len(sys.argv) > 3 else ""

with open(path, encoding="utf-8") as fh:
    lines = fh.read().split("\n")

# Steps are the 6-space `      - ` entries; their bodies sit at 8+ spaces, so
# any shallower non-blank line closes the block.
steps = []
cur = None
for line in lines:
    if re.match(r"^      - \S", line):
        if cur is not None:
            steps.append(cur)
        cur = [line]
    elif cur is not None:
        if line.strip() and (len(line) - len(line.lstrip())) <= 5:
            steps.append(cur)
            cur = None
        else:
            cur.append(line)
if cur is not None:
    steps.append(cur)

filters = []
for s in steps:
    text = "\n".join(s)
    if "dorny/paths-filter" not in text:
        continue
    sid = ""
    for line in s:
        m = re.match(r"^        id:\s*(\S+)\s*$", line)
        if m:
            sid = m.group(1)
            break
    filters.append((sid, s, text))

# Anchored to the real YAML key at its `with:`-child indent, never a substring.
# A prose mention of predicate-quantifier in one of this file's own explanatory
# comments would otherwise satisfy the check, and those comments sit inside the
# step block — so the loosely-written version of this test passes on a workflow
# that has the comment and not the setting.
def quantifier(step_lines):
    for line in step_lines:
        m = re.match(r"^          predicate-quantifier:\s*['\"]?(\w+)['\"]?\s*$", line)
        if m:
            return m.group(1)
    return "some"


def has_negated_pattern(step_lines):
    return any(re.match(r"^\s+- ['\"]?!", line) for line in step_lines)


def filter_patterns(step_lines, filter_name):
    """Return the scalar patterns belonging to one named inline filter."""
    header = re.compile(r"^(\s*)%s:\s*$" % re.escape(filter_name))
    start = None
    indent = 0
    for index, line in enumerate(step_lines):
        match = header.match(line)
        if match:
            start = index + 1
            indent = len(match.group(1))
            break
    if start is None:
        return []

    patterns = []
    for line in step_lines[start:]:
        if line.strip() and len(line) - len(line.lstrip()) <= indent:
            break
        match = re.match(r"^\s+-\s+(['\"]?)(.+?)\1\s*$", line)
        if match:
            patterns.append(match.group(2))
    return patterns


if mode == "step":
    for sid, _s, text in filters:
        if sid == arg:
            sys.stdout.write(text)
            sys.exit(0)
    sys.exit(4)

if mode == "quant":
    for sid, s, _text in filters:
        if sid == arg:
            sys.stdout.write(quantifier(s))
            sys.exit(0)
    sys.exit(4)

if mode == "patterns":
    filter_name = sys.argv[4] if len(sys.argv) > 4 else ""
    for sid, s, _text in filters:
        if sid == arg:
            sys.stdout.write("\n".join(filter_patterns(s, filter_name)))
            sys.exit(0)
    sys.exit(4)

if mode == "audit":
    bad = []
    for sid, s, _text in filters:
        if has_negated_pattern(s) and quantifier(s) != "every":
            bad.append(sid or "<no id>")
    sys.stdout.write("\n".join(bad))
    sys.exit(0)

sys.exit(5)
PY

filter_step() {
  python3 "${STEP_EXTRACTOR}" "${WORKFLOW}" step "$1"
}

filter_quantifier() {
  python3 "${STEP_EXTRACTOR}" "${WORKFLOW}" quant "$1"
}

filter_patterns() {
  python3 "${STEP_EXTRACTOR}" "${WORKFLOW}" patterns "$1" "$2"
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
assert_contains "${DEPLOY_IF}" "needs.detect-changes.outputs.backend_deployable == 'true'" \
  "only deployable-backend PRs deploy (ENG-743 path filter, narrowed by ENG-1041)"
assert_contains "${DEPLOY_IF}" "needs.backend-tests-a.result == 'success'" \
  "agentMode suite must have PASSED, not merely not-failed"
assert_contains "${DEPLOY_IF}" "needs.backend-tests-b.result == 'success'" \
  "non-agentMode + coverage suite must have PASSED"

# ENG-1371: the `needs.greptile-review.result == 'success'` clause was dropped
# with the job when Greptile was retired as a vendor. The shape that ENG-754
# actually bought is unchanged and still asserted above: every gate here reads
# `result == 'success'`, never "did not fail", so a skipped or cancelled
# upstream can never be mistaken for a pass.
assert_not_contains "${DEPLOY_IF}" "greptile" \
  "no reference to the retired Greptile gate remains in the deploy condition" \
  "the greptile-review job no longer exists; a needs: on it would make this job unreachable"

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
# Dependabot PRs must still run the full backend suite.
# They change .github/workflows/tests.yml, which the `backend` filter counts as
# a backend change precisely so the CI path gates its own changes (ENG-743);
# skipping the tests for Dependabot would make that self-gating vacuous and let
# an action bump land having exercised nothing.
for job in backend-tests-a backend-tests-b; do
  assert_not_contains "$(job_if "${job}")" "dependabot" \
    "${job} still runs for Dependabot PRs" \
    "Dependabot bumps must be tested like any other PR"
done

# --- ENG-1041: the deploy decision and the test decision are separate. -------
# `backend` answers "should this diff be tested"; `backend_deployable` answers
# "should this diff reach the staging environment". They were one boolean, so a
# PR changing only test files ran a full build → package → S3 → EB deploy and,
# worse, held `concurrency: backend-staging-deploy` — a group keyed on nothing
# but its own name, with `cancel-in-progress: false`, i.e. the single global
# non-preemptable staging lane every other backend PR queues behind.
assert_not_contains "${DEPLOY_IF}" "outputs.backend == 'true'" \
  "deploy does not gate on the bare backend output" \
  "the bare 'backend' output is true for a test-only diff — re-coupling them puts test-only PRs back in the global staging lane"

# The mirror assertion, and the more dangerous direction to get wrong: the test
# suites must NOT inherit the narrowing. Gating them on deployability would stop
# running tests on PRs whose whole purpose is changing tests.
for job in backend-tests-a backend-tests-b; do
  job_expr="$(job_if "${job}")"
  assert_contains "${job_expr}" "needs.detect-changes.outputs.backend == 'true'" \
    "${job} still runs on any backend diff, test-only included"
  assert_not_contains "${job_expr}" "backend_deployable" \
    "${job} is not narrowed to deployable paths" \
    "a test-only PR must still be tested; gating the suites on deployability would stop testing test changes"
done

# --- The filter step behind that output. -------------------------------------
DEPLOY_FILTER="$(filter_step filter_deploy || true)"
if [ -z "${DEPLOY_FILTER}" ]; then
  fail_test "detect-changes has a dorny/paths-filter step with id 'filter_deploy'" \
    "not found — backend_deployable would have no source, and an undefined output is the empty string, which silently never equals 'true' and disables staging deploys entirely"
else
  # Read as a parsed YAML key, not a substring: this file's own comments
  # explain the setting, and a substring check would be satisfied by the
  # explanation of the fix rather than the fix.
  assert_contains "$(filter_quantifier filter_deploy)" "every" \
    "the deploy filter requires EVERY pattern to match"
  assert_contains "${DEPLOY_FILTER}" "'backend/**'" \
    "the deploy decision still starts from the whole backend tree"
  assert_contains "${DEPLOY_FILTER}" "'!backend/**/__tests__/**'" \
    "test directories are excluded from the deploy decision"
  # ENG-743, restated against the new output. The `backend` filter counts this
  # workflow and eb-deploy.sh as backend changes precisely so a change to the
  # deploy path is exercised by the deploy path on its own PR. Narrowing the
  # deploy decision without carrying these forward would ship the next
  # backend-staging-deploy fix unexercised.
  DEPLOY_CI_PATTERNS="$(filter_patterns filter_deploy deploy_ci)"
  DEPLOY_CI_COUNT="$(printf '%s\n' "${DEPLOY_CI_PATTERNS}" | grep -c . || true)"
  if [ "${DEPLOY_CI_COUNT}" -eq 1 ]; then
    pass_test "deploy_ci uses one pattern under the EVERY quantifier"
  else
    fail_test "deploy_ci uses one pattern under the EVERY quantifier" \
      "found ${DEPLOY_CI_COUNT}: separate entries require every deployment-path file to change in the same PR"
  fi
  assert_contains "${DEPLOY_CI_PATTERNS}" ".github/{workflows/tests.yml,scripts/eb-deploy.sh}" \
    "one brace pattern independently matches either deploy-path file (ENG-743)"
  if printf '%s\n' "${DEPLOY_CI_PATTERNS}" | grep -Fxq ".github/workflows/tests.yml"; then
    fail_test "tests.yml is not a separate deploy_ci entry" \
      "under predicate-quantifier: every, separate entries require tests.yml AND eb-deploy.sh to change together"
  else
    pass_test "tests.yml is not a separate deploy_ci entry"
  fi
  if printf '%s\n' "${DEPLOY_CI_PATTERNS}" | grep -Fxq ".github/scripts/eb-deploy.sh"; then
    fail_test "eb-deploy.sh is not a separate deploy_ci entry" \
      "under predicate-quantifier: every, separate entries require tests.yml AND eb-deploy.sh to change together"
  else
    pass_test "eb-deploy.sh is not a separate deploy_ci entry"
  fi
fi

# --- The fail-open guard, stated generally so it also covers future filters. --
NEGATION_OFFENDERS="$(python3 "${STEP_EXTRACTOR}" "${WORKFLOW}" audit)"
if [ -z "${NEGATION_OFFENDERS}" ]; then
  pass_test "every '!'-negated pattern sits in a predicate-quantifier: every step"
else
  fail_test "every '!'-negated pattern sits in a predicate-quantifier: every step" \
    "these paths-filter steps negate a pattern under the default 'some' quantifier, which makes their filter TRUE for every path outside the excluded one: ${NEGATION_OFFENDERS}"
fi

# --- The output has to be declared, or the `if:` reads an empty string. -------
WORKFLOW_TEXT="$(cat "${WORKFLOW}")"
assert_contains "${WORKFLOW_TEXT}" "steps.filter_deploy.outputs" \
  "backend_deployable is derived from the filter_deploy step"

# ---------------------------------------------------------------------------
printf '\nstaging-deploy-gate: %d run, %d failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
