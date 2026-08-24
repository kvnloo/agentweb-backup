#!/usr/bin/env bash
#
# ENG-1041: a `!`-negated dorny/paths-filter pattern must sit in a step that
# sets `predicate-quantifier: 'every'`.
#
#   bash .github/scripts/paths-filter-hygiene.test.sh
#
# Why this is a test and not a review habit
# -----------------------------------------
# dorny/paths-filter compiles EACH pattern in a filter into its own picomatch
# matcher and OR-combines them (`patterns.some(...)`; `predicate-quantifier`
# defaults to `some`) — verified in src/filter.ts at the pinned SHA. So a
# `!`-negated pattern written in a default filter is NOT an exclusion.
# picomatch returns TRUE for every path OUTSIDE the named one, so:
#
#     backend_src:
#       - 'backend/**'
#       - '!backend/**/__tests__/**'      # <-- matches README.md
#
# is true for README.md, and therefore the filter it sits in is permanently
# true. The narrowing reads exactly like an exclusion and silently becomes a
# widening. The only thing standing between those two outcomes is
# `predicate-quantifier: 'every'`, one line away from the patterns it governs.
#
# The consequence is not cosmetic. ENG-1041 split the deploy decision from the
# test decision precisely so a test-only diff would stop taking the single
# global staging lane; a negation that quietly inverts puts every PR in the
# repo back into that lane while the YAML still reads as a narrowing.
#
# Provenance
# ----------
# This assertion previously lived at the end of staging-deploy-gate.test.sh.
# That suite was deleted in #2588 because the `backend-staging-deploy` job it
# guarded was removed by ENG-1463 — but this last test was general, not about
# staging deploys, so it was lost with its host. It is restored here in a file
# whose SUBJECT is the rule, following the ENG-1412 precedent: a structural
# rule belongs with its subject, not in whatever file the bug was first caught
# in.
#
# Two deliberate changes from the version that was deleted:
#
#   1. It scanned only tests.yml. This scans every .github/workflows/*.yml, so
#      deploy.yml — which also uses paths-filter and was never covered — is
#      included, as is any workflow added later.
#   2. Offenders are reported as `file:step-id`, since "which step" is no
#      longer answerable from the suite name alone.
#
# Current exposure is zero: no workflow negates a pattern today, and none sets
# predicate-quantifier. That is the point. This exists so the hazard cannot be
# reintroduced silently, not because it is live.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOW_DIR="${SCRIPT_DIR}/../workflows"

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

WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

AUDITOR="${WORKDIR}/audit_filters.py"
cat >"${AUDITOR}" <<'PY'
import re
import sys

# Each argument is a workflow file. Print one `basename:step-id` per offending
# step; print nothing when every negation is correctly quantified.

def steps_of(lines):
    """Split a workflow into its step blocks.

    Indentation is DERIVED from each `steps:` key rather than assumed. The
    version this was recovered from hardcoded the 6-space entries that
    tests.yml happens to use, which is a fail-open in a fail-open detector: a
    workflow indented any other way is not parsed into steps at all, so it is
    silently never audited and the suite reports clean. YAML permits any width,
    and it permits a list whose items sit at the SAME indent as their key —
    both shapes are handled here. (CodeRabbit on #2594.)
    """
    steps = []
    cur = None
    steps_indent = None
    step_indent = None

    def close():
        nonlocal cur
        if cur is not None:
            steps.append(cur)
            cur = None

    for line in lines:
        stripped = line.strip()

        m_steps = re.match(r"^(\s*)steps:\s*$", line)
        if m_steps:
            close()
            steps_indent = len(m_steps.group(1))
            step_indent = None
            continue

        if steps_indent is None:
            continue

        # Blank lines belong to whatever step is open; they do not end it.
        if not stripped:
            if cur is not None:
                cur.append(line)
            continue

        indent = len(line) - len(line.lstrip())
        is_item = re.match(r"^\s*-\s+\S", line) is not None

        # The steps block ends at a key shallower than `steps:`, or at a
        # non-item sibling sitting at the same depth (the next job key).
        if indent < steps_indent or (indent == steps_indent and not is_item):
            close()
            steps_indent = None
            step_indent = None
            continue

        # The first item under `steps:` fixes the step depth; items deeper than
        # that are nested data (filter patterns), not new steps.
        if is_item and (step_indent is None or indent == step_indent):
            step_indent = indent
            close()
            cur = [line]
            continue

        if cur is not None:
            cur.append(line)

    close()
    return steps


def step_id(step_lines):
    """The step's `id:`, in either of the two forms both workflows here use.

    tests.yml writes it on the dash line (`      - id: filter`); deploy.yml
    writes it as a sibling key (`        id: filter`). The version this was
    recovered from matched only the second, so it reported `<no id>` for the
    one step it was actually scanning — harmless when the suite name told you
    the file, useless now that the offender could be any workflow.
    """
    if step_lines:
        m = re.match(r"^\s*-\s+id:\s*(\S+)\s*$", step_lines[0])
        if m:
            return m.group(1)
    for line in step_lines:
        m = re.match(r"^\s+id:\s*(\S+)\s*$", line)
        if m:
            return m.group(1)
    return "<no id>"


def quantifier(step_lines):
    """The step's predicate-quantifier, defaulting to picomatch's `some`.

    Anchored to a real YAML key with nothing but whitespace before it, never a
    substring. This file's own header explains the setting in prose, and a
    workflow may well do the same in a comment — a substring check would be
    satisfied by the EXPLANATION of the fix rather than the fix.
    """
    for line in step_lines:
        m = re.match(r"^\s+predicate-quantifier:\s*['\"]?(\w+)['\"]?\s*$", line)
        if m:
            return m.group(1)
    return "some"


def has_negated_pattern(step_lines):
    return any(re.match(r"^\s+- ['\"]?!", line) for line in step_lines)


offenders = []
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().split("\n")
    name = path.rsplit("/", 1)[-1]
    for step in steps_of(lines):
        text = "\n".join(step)
        if "dorny/paths-filter" not in text:
            continue
        if has_negated_pattern(step) and quantifier(step) != "every":
            offenders.append("%s:%s" % (name, step_id(step)))

sys.stdout.write("\n".join(offenders))
PY

# --- The rule, against the real workflows. -----------------------------------
shopt -s nullglob
WORKFLOWS=("${WORKFLOW_DIR}"/*.yml)
shopt -u nullglob

if [ "${#WORKFLOWS[@]}" -eq 0 ]; then
  fail "there are workflows to audit" \
    "no .yml found under ${WORKFLOW_DIR} — this suite would pass vacuously"
else
  pass "found ${#WORKFLOWS[@]} workflow file(s) to audit"

  OFFENDERS="$(python3 "${AUDITOR}" "${WORKFLOWS[@]}")"
  if [ -z "${OFFENDERS}" ]; then
    pass "every '!'-negated pattern sits in a predicate-quantifier: every step"
  else
    fail "every '!'-negated pattern sits in a predicate-quantifier: every step" \
      "these paths-filter steps negate a pattern under the default 'some'" \
      "quantifier, which makes their filter TRUE for every path outside the" \
      "excluded one:" \
      "${OFFENDERS}"
  fi
fi

# --- Self-checks. ------------------------------------------------------------
# A detector that cannot fail is worth nothing, and this one currently has no
# real offender to prove itself against — every workflow passes, so a broken
# auditor and a clean repo are indistinguishable without these.

mk_workflow() {
  # $1 destination, $2 quantifier line (may be empty), $3 pattern line,
  # $4 indent of the step's `-` (default 6). `steps:` always sits at 4, so 4
  # exercises the same-indent-as-its-key list form that YAML also allows.
  local dest="$1" quant="$2" pattern="$3" si="${4:-6}"
  local dash body
  dash="$(printf '%*s' "${si}" '')"
  body="$(printf '%*s' "$((si + 2))" '')"
  {
    printf 'jobs:\n'
    printf '  detect:\n'
    printf '    runs-on: ubuntu-slim\n'
    printf '    steps:\n'
    printf '%s- id: filter\n' "${dash}"
    printf '%suses: dorny/paths-filter@ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d # v4.0.3\n' "${body}"
    printf '%swith:\n' "${body}"
    [ -n "${quant}" ] && printf '%s  %s\n' "${body}" "${quant}"
    printf '%s  filters: |\n' "${body}"
    printf '%s    backend_src:\n' "${body}"
    printf "%s      - 'backend/**'\n" "${body}"
    printf '%s      %s\n' "${body}" "${pattern}"
  } >"${dest}"
}

# Negation under the default quantifier — the exact fail-open this exists for.
mk_workflow "${WORKDIR}/bad.yml" "" "- '!backend/**/__tests__/**'"
if [ -n "$(python3 "${AUDITOR}" "${WORKDIR}/bad.yml")" ]; then
  pass "self-check: a negation under the default quantifier is flagged"
else
  fail "self-check: a negation under the default quantifier is flagged" \
    "the auditor passed a step it must reject — it would report this repo" \
    "clean whether or not the hazard is present"
fi

# The same negation, correctly quantified.
mk_workflow "${WORKDIR}/good.yml" "predicate-quantifier: 'every'" "- '!backend/**/__tests__/**'"
if [ -z "$(python3 "${AUDITOR}" "${WORKDIR}/good.yml")" ]; then
  pass "self-check: a negation under 'every' is accepted"
else
  fail "self-check: a negation under 'every' is accepted" \
    "the auditor rejected a correctly-quantified step, so the rule cannot be" \
    "satisfied and would block the very fix it asks for"
fi

# No negation at all: quantifier is irrelevant, and today's real workflows are
# all this shape. Without this the suite would pass on an auditor that flags
# every paths-filter step it sees.
mk_workflow "${WORKDIR}/none.yml" "" "- 'backend/other/**'"
if [ -z "$(python3 "${AUDITOR}" "${WORKDIR}/none.yml")" ]; then
  pass "self-check: a filter with no negation is left alone"
else
  fail "self-check: a filter with no negation is left alone" \
    "the auditor flagged a step that negates nothing"
fi

# Indentation must not be a way out. The recovered version hardcoded the
# 6-space entries tests.yml uses, so a workflow indented any other way parsed
# to zero steps and was reported clean without ever being audited — the same
# silent fail-open this suite exists to catch, one level up. (CodeRabbit on
# #2594.) Both alternatives below are valid YAML.
mk_workflow "${WORKDIR}/deep.yml" "" "- '!backend/**/__tests__/**'" 8
if [ -n "$(python3 "${AUDITOR}" "${WORKDIR}/deep.yml")" ]; then
  pass "self-check: a hazard in a deeper-indented step list is still found"
else
  fail "self-check: a hazard in a deeper-indented step list is still found" \
    "step parsing is pinned to one indent width, so a workflow written any" \
    "other way is never audited and reports clean"
fi

# List items may sit at the same indent as the key that owns them.
mk_workflow "${WORKDIR}/flush.yml" "" "- '!backend/**/__tests__/**'" 4
if [ -n "$(python3 "${AUDITOR}" "${WORKDIR}/flush.yml")" ]; then
  pass "self-check: a hazard in a steps list flush with its key is still found"
else
  fail "self-check: a hazard in a steps list flush with its key is still found" \
    "a list indented level with 'steps:' is valid YAML and must still be audited"
fi

# Prose must not satisfy the rule. The deleted version called this out
# explicitly: a comment mentioning predicate-quantifier sits INSIDE the step
# block, so a substring check passes on a workflow that has the explanation and
# not the setting.
mk_workflow "${WORKDIR}/comment.yml" "# predicate-quantifier: 'every' would fix this" "- '!backend/**/__tests__/**'"
if [ -n "$(python3 "${AUDITOR}" "${WORKDIR}/comment.yml")" ]; then
  pass "self-check: a commented-out quantifier does not satisfy the rule"
else
  fail "self-check: a commented-out quantifier does not satisfy the rule" \
    "a comment describing the fix was accepted as the fix"
fi

# ---------------------------------------------------------------------------
printf '\npaths-filter-hygiene: %d run, %d failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
