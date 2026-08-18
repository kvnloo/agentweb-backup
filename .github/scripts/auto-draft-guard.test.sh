#!/usr/bin/env bash
#
# Contract tests for the `auto-draft-guard` job and its interaction with
# `detect-changes` in .github/workflows/tests.yml (ENG-1283).
#
# Like staging-deploy-gate.test.sh (ENG-991), this has no script under test —
# the thing it guards is a set of job-level `if:`/`needs:`/`concurrency`
# clauses, which GitHub evaluates and nothing in this repo can execute
# locally. It parses the real workflow and asserts those clauses.
#
# What this protects against: ENG-1283 collapses a push-fix-push-fix cycle on
# an already-ready PR into one heavy CI + one Greptile run by auto-converting
# the PR back to draft on `synchronize`. The #2360 incident (a push, `gh pr
# ready`, and auto-merge landing within 5s) happened because a
# cancel-in-progress concurrency group did not distinguish a draft-time run
# from a ready run on the same ref; the fix put the draft flag in every
# group name. This new job reuses that exact pattern — a test that silently
# lets it drift back to a bare `${{ github.ref }}` group would reopen #2360
# for the one new code path this issue adds.
#
# Run with:  bash .github/scripts/auto-draft-guard.test.sh

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
# Extractor — same job-body-slicing approach as staging-deploy-gate.test.sh,
# extended to also read `needs:` and the `concurrency.group:` value.
# ---------------------------------------------------------------------------
EXTRACTOR="${WORKDIR}/job_fields.py"
cat >"${EXTRACTOR}" <<'PY'
import re
import sys

path, job, field = sys.argv[1], sys.argv[2], sys.argv[3]

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

body = []
for line in lines[j + 1:]:
    if re.match(r"^  \S", line):
        break
    body.append(line)


def block_or_inline(key_re, body_lines):
    for k, line in enumerate(body_lines):
        m = re.match(key_re, line)
        if not m:
            continue
        value = m.group(1).strip()
        if value in (">-", ">", "|", "|-", ""):
            collected = []
            base_indent = None
            for nxt in body_lines[k + 1:]:
                if not nxt.strip():
                    continue
                indent = len(nxt) - len(nxt.lstrip())
                if base_indent is None:
                    if indent <= 4:
                        break
                    base_indent = indent
                elif indent < base_indent:
                    break
                collected.append(nxt.strip())
            return " ".join(collected)
        return value
    return None


if field == "if":
    expr = block_or_inline(r"^    if:\s*(.*)$", body)
    sys.stdout.write(" ".join(expr.split()) if expr else "")
elif field == "needs":
    expr = block_or_inline(r"^    needs:\s*(.*)$", body)
    sys.stdout.write(expr or "")
elif field == "concurrency_group":
    # `concurrency:` is a mapping; `group:` is its nested child at 6 spaces.
    in_block = False
    for line in body:
        if re.match(r"^    concurrency:\s*$", line):
            in_block = True
            continue
        if in_block:
            m = re.match(r"^      group:\s*(.*)$", line)
            if m:
                sys.stdout.write(" ".join(m.group(1).strip().split()))
                sys.exit(0)
            if line.strip() and (len(line) - len(line.lstrip())) <= 4:
                break
    sys.stdout.write("")
else:
    sys.exit(5)
PY

job_if() {
  python3 "${EXTRACTOR}" "${WORKFLOW}" "$1" if
}

job_needs() {
  python3 "${EXTRACTOR}" "${WORKFLOW}" "$1" needs
}

job_concurrency_group() {
  python3 "${EXTRACTOR}" "${WORKFLOW}" "$1" concurrency_group
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
    *) fail_test "${label}" "expected to find: ${needle}   (got: ${haystack})" ;;
  esac
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3" why="$4"
  case "${haystack}" in
    *"${needle}"*) fail_test "${label}" "must NOT contain '${needle}': ${why}" ;;
    *) pass_test "${label}" ;;
  esac
}

# --- auto-draft-guard: only fires on the one push that matters (criterion 1/2) ---
GUARD_IF="$(job_if auto-draft-guard)"
if [ -z "${GUARD_IF}" ]; then
  printf 'FATAL: could not read the if: condition of auto-draft-guard.\n' >&2
  exit 1
fi
printf 'auto-draft-guard.test: auto-draft-guard\n'
printf '  if: %s\n' "${GUARD_IF}"

assert_contains "${GUARD_IF}" "github.event.action == 'synchronize'" \
  "only reacts to a new commit, never to opened/reopened/ready_for_review"
assert_contains "${GUARD_IF}" "github.event.pull_request.draft == false" \
  "never fires on a push to a PR that is already draft (nothing to convert, no wasted API call)"

# --- The mutation itself: real conversion, not a no-op that lies via output. ---
WORKFLOW_TEXT="$(cat "${WORKFLOW}")"
assert_contains "${WORKFLOW_TEXT}" "convertPullRequestToDraft" \
  "converts via the GraphQL mutation (REST PATCH /pulls does not support setting draft)"
assert_contains "${WORKFLOW_TEXT}" 'is_draft="$(jq -r' \
  "verifies the mutation actually reported isDraft=true before claiming success" \

# --- Concurrency: reuses the #2360 pattern exactly. --------------------------
GUARD_GROUP="$(job_concurrency_group auto-draft-guard)"
if [ -z "${GUARD_GROUP}" ]; then
  fail_test "auto-draft-guard has its own concurrency group" \
    "missing — without one, a rapid double-push could run the conversion twice concurrently"
else
  assert_contains "${GUARD_GROUP}" '${{ github.ref }}' \
    "auto-draft-guard's group is scoped per-PR-ref, like every other job here"
  assert_contains "${GUARD_GROUP}" '${{ github.event.pull_request.draft }}' \
    "auto-draft-guard's group carries the draft flag (#2360 fix pattern) so it can never collide with a differently-drafted run of anything else in this file"
fi

# The existing #2360 fix must survive this change untouched: every job's group
# still carries the draft flag from ITS OWN event payload.
for job in detect-changes backend-tests-a backend-tests-b ci-scripts-tests eb-config-conflict greptile-review partner-tests; do
  group="$(job_concurrency_group "${job}")"
  assert_contains "${group}" '${{ github.event.pull_request.draft }}' \
    "${job}'s concurrency group still carries the draft flag (#2360 regression guard, unmodified by ENG-1283)"
done

# --- detect-changes: gated on the new output, without losing the old gate. ---
DETECT_IF="$(job_if detect-changes)"
DETECT_NEEDS="$(job_needs detect-changes)"
printf '\nauto-draft-guard.test: detect-changes\n'
printf '  needs: %s\n' "${DETECT_NEEDS}"
printf '  if: %s\n' "${DETECT_IF}"

assert_contains "${DETECT_NEEDS}" "auto-draft-guard" \
  "detect-changes waits on auto-draft-guard so the conversion (if any) lands before the filter runs"
assert_contains "${DETECT_IF}" "always()" \
  "detect-changes explicitly opts out of the implicit success()-on-needs check, or it would wrongly skip on opened/reopened/ready_for_review (auto-draft-guard is itself skipped, not succeeded, on those events)"
assert_contains "${DETECT_IF}" "github.event.pull_request.draft == false" \
  "the pre-existing ENG-1277 draft gate is not lost by this edit"
assert_contains "${DETECT_IF}" "needs.auto-draft-guard.outputs.converted != 'true'" \
  "detect-changes (and everything that needs it) skips on exactly the push auto-draft-guard just converted"

# --- Containment: nothing downstream needs to know about auto-draft-guard  ---
# directly — they all key off detect-changes, which naturally cascade-skips
# (a custom `if:` is implicitly ANDed with success() of `needs:`, and a
# skipped job is not success()). Asserting that assumption stays true is the
# whole reason this suite doesn't also have to touch five more job bodies.
for job in backend-tests-a backend-tests-b ci-scripts-tests eb-config-conflict partner-tests greptile-review backend-staging-deploy; do
  needs="$(job_needs "${job}")"
  assert_contains "${needs}" "detect-changes" \
    "${job} still depends on detect-changes (so it inherits the cascade-skip, not a direct auto-draft-guard dependency)"
  assert_not_contains "${needs}" "auto-draft-guard" \
    "${job} does not need auto-draft-guard directly" \
    "the skip must propagate through detect-changes' own if:, not be duplicated onto every downstream job"
done

# ---------------------------------------------------------------------------
printf '\nauto-draft-guard.test: %d run, %d failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
