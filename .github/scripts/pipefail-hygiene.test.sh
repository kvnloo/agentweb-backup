#!/usr/bin/env bash
#
# ENG-1412: no script may pipe into a reader that exits early.
#
# Kept byte-identical in agentweb and agentweb-customer-portal, which share
# eb-deploy.sh. Change it in one repo and copy it to the other.
#
#   bash .github/scripts/pipefail-hygiene.test.sh
#
# Why this is a test and not a review habit
# -----------------------------------------
# `grep -q` and `head` exit the moment they have what they need, closing the
# read end of the pipe. If the writer has not finished, it takes EPIPE/SIGPIPE
# and exits 141. Under `set -o pipefail` — which every script here sets — 141
# becomes the PIPELINE's status. So:
#
#   if printf '%s' "${content}" | grep -qF "${needle}"; then   # <-- match LOST
#
# takes the FALSE branch on a successful match. The bug is silent, timing
# dependent, and inverts whatever safety property the branch was guarding.
#
# It is not theoretical. On agentweb#2523 this fired in CI in
# eb-config-conflict.sh, where `contains_any` missed the instance-config side of
# a mixed .ebextensions file and the gate EXITED 0 — declaring safe the exact
# change shape that once left main undeployable for ~50 minutes:
#
#   .github/scripts/eb-config-conflict.sh: line 156: printf: write error: Broken pipe
#
# The same shape sat in eb-deploy.sh in front of the terminal-rejection check
# (a lost match there means a deploy reports success on an update EB refused —
# the ENG-734/837 false green), in deploy-failure-alert.sh under `set -e` where
# a 141 would abort the alerter and lose the Slack notification for a failed
# production deploy, and — worst — in staging-deploy-gate.test.sh, where the
# false branch calls `pass_test`, so the assertion would report OK exactly when
# the condition it guards against was true.
#
# Every one of those reads fine in review. A grep does not, which is why this
# lives in CI. ENG-1277 fixed one instance of this by hand; it came back.
#
# The fix is always to remove the pipe, not to tolerate it:
#   printf '%s' "$x" | grep -qF "$n"    ->  grep -qF "$n" <<<"$x"
#   printf '%s' "$x" | head -n 1        ->  "${x%%$'\n'*}"
#   jq '...' f | head -n 1              ->  jq 'first(...)' f
#
# A pipeline that genuinely does not care about the status may end in
# `|| true`, which makes the tolerance explicit and visible.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$(basename "${BASH_SOURCE[0]}")"

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

# A reader that stops before its input does. `grep -q` in any flag order
# (-q, -qF, -Fxq, -qiE ...), and `head` in any form.
# A pipeline is not a line. Shell continues one across a newline after a
# trailing `\` and — with no backslash at all — after a trailing `|`:
#
#     printf '%s' "${content}" |
#       grep -qF "${needle}"
#
# Matching physical lines misses that form completely (raised by CodeRabbit on
# #2530/#1061). Checked both continuation styles rather than assuming: the
# backslash form was already caught, because its second line begins with
# `| grep -qF` and matches on its own. The pipe-at-end-of-line form was not.
#
# So join continuations into logical lines first, keeping the line number of
# where each STARTS so a failure still points somewhere useful. Comments are
# never joined: `#` ends at the newline, and gluing one to the line below would
# invent a pipeline that does not exist.
logical_lines() {
  awk '
    {
      line = $0
      sub(/[[:space:]]+$/, "", line)
      trimmed = line
      sub(/^[[:space:]]+/, "", trimmed)
      if (trimmed ~ /^#/) {
        if (buf != "") { print start ":" buf; buf = "" }
        print NR ":" line
        next
      }
      if (buf == "") start = NR
      cont = (line ~ /\\$/) || (line ~ /\|$/)
      sub(/\\$/, "", line)
      buf = (buf == "" ? line : buf " " line)
      if (cont) next
      print start ":" buf
      buf = ""
    }
    END { if (buf != "") print start ":" buf }
  ' "$1"
}

# Validated against 12 real lines from this directory, matching and
# non-matching alike. Note `-[a-zA-Z]*q[a-zA-Z]*`: the q is not necessarily the
# LAST flag letter — `-qF`, `-qiE` and `-Fxq` all appear in this repo, and an
# earlier version of this expression anchored q at the end and therefore matched
# none of them. It reported 16 clean files while every one of them was dirty.
# That is why the self-check at the bottom exists.
EARLY_EXIT_READER='\|[[:space:]]*(grep([[:space:]]+-[a-zA-Z]+)*[[:space:]]+-[a-zA-Z]*q[a-zA-Z]*|head)([[:space:]]|$)'

shopt -s nullglob
for script in "${SCRIPT_DIR}"/*.sh; do
  base="$(basename "${script}")"
  [ "${base}" = "${SELF}" ] && continue

  # The hazard only exists where a lost status can be read as a verdict.
  grep -qE 'set -[a-z]*o pipefail|set -o pipefail' "${script}" || continue

  # Strip comment-only lines so prose describing the bug does not trip it, and
  # allow an explicit `|| true` as a documented tolerance.
  offenders="$(logical_lines "${script}" \
    | grep -vE '^[0-9]+:[[:space:]]*#' \
    | grep -vE '\|\|[[:space:]]*true[[:space:]]*\)?[[:space:]]*$' \
    | grep -E "${EARLY_EXIT_READER}" \
    || true)"

  if [ -z "${offenders}" ]; then
    pass "${base}: no pipeline feeds an early-exiting reader"
  else
    fail "${base}: pipes into a reader that exits early, under pipefail." \
         "Under 'set -o pipefail' the writer's EPIPE becomes the pipeline's" \
         "status, so a successful match reads as a failure and the branch" \
         "inverts. Use a here-string, parameter expansion, or jq first()." \
         "See the header of this file for the CI incident (agentweb#2523)." \
         "${offenders}"
  fi
done

# The rule is worthless if it cannot fail, so prove it can. A temporary file
# carrying the exact shape must be rejected by the same expression.
probe="$(mktemp)"
trap 'rm -f "${probe}"' EXIT
cat >"${probe}" <<'PROBE'
set -euo pipefail
if printf '%s' "${content}" | grep -qF "${needle}"; then :; fi
if printf '%s\n' "${x}" | grep -Fxq "${y}"; then :; fi
v="$(printf '%s\n' "${x}" | head -n 1)"
printf '%s' "${content}" \
  | grep -qiE "${needle}"
printf '%s' "${content}" |
  grep -qF "${needle}"
PROBE
n_flagged="$(logical_lines "${probe}" | grep -cE "${EARLY_EXIT_READER}" || true)"
if [ "${n_flagged}" = "5" ]; then
  pass "the rule actually detects the shape it exists to ban"
else
  fail "the detector flagged ${n_flagged} of 5 known-bad pipelines." \
       "The probe carries -qF, -Fxq and 'head -n 1' precisely because an" \
       "earlier expression anchored the q at the end of the flag group and" \
       "matched none of them, reporting every file clean. A detector that" \
       "cannot fail is the same thing as no detector. The last two are" \
       "split across lines — one by backslash, one by a trailing pipe — and" \
       "the second escaped the detector entirely before normalisation."
fi

printf '\n%s tests, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ]
