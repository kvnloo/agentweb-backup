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
#
# The leading `(^|[^|])` matters as much as the rest: without it, `||` matches.
# `validate || grep -qF x <<<"$y"` is an OR-list, not a pipeline — grep reads a
# here-string and nothing can break — but the second `|` of `||` is followed by
# ` grep -qF`, so an unanchored expression flags it and CI blocks a compliant
# script. Raised by CodeRabbit on #2530/#1061; the false positive predated the
# logical-line joining below, which merely made it reachable in more places.
#
# The quiet flag is found ANYWHERE in grep's argument list, not just in the last
# option token. `grep -q -F x` was already caught, but `grep -e "${n}" -q` and
# `grep --quiet` were not: the first puts a non-option word before the flag, the
# second is a long option. Both still exit on the first match, so both are
# hazards, and a detector that misses them gives false assurance. Raised by
# CodeRabbit on #1061. `[^|;&]*` keeps the search inside one command so a later
# command on the same logical line cannot lend it a `-q`.
EARLY_EXIT_READER='(^|[^|])\|[[:space:]]*(grep[[:space:]]+([^|;&]*[[:space:]])?(-[a-zA-Z]*q[a-zA-Z]*|--quiet)([[:space:]]|;|$)|head([[:space:]]|$))'

# Normalise into a FILE and prove it worked, so a broken scanner cannot present
# as a clean result. Echoes the path; non-zero if anything went wrong.
normalise() {
  local script="$1" out
  out="$(mktemp)" || return 1
  if ! logical_lines "${script}" >"${out}"; then rm -f "${out}"; return 1; fi
  # A non-empty script must normalise to something. Silent truncation is the
  # failure mode that would otherwise look identical to "no violations".
  if [ -s "${script}" ] && [ ! -s "${out}" ]; then rm -f "${out}"; return 1; fi
  printf '%s' "${out}"
}

# Drop comments and explicitly-tolerated pipelines, then match. Each step reads
# a file and its status is checked on its own: 1 means "nothing left", which is
# ordinary, and anything above 1 is a real error that must not pass for clean.
filter_and_match() {
  local norm="$1" a b rc
  a="$(mktemp)"; b="$(mktemp)"
  grep -vE '^[0-9]+:[[:space:]]*#' "${norm}" >"${a}"; rc=$?
  if [ "${rc}" -gt 1 ]; then rm -f "${a}" "${b}"; return "${rc}"; fi
  grep -vE '\|\|[[:space:]]*true[[:space:]]*\)?[[:space:]]*$' "${a}" >"${b}"; rc=$?
  if [ "${rc}" -gt 1 ]; then rm -f "${a}" "${b}"; return "${rc}"; fi
  grep -E "${EARLY_EXIT_READER}" "${b}"; rc=$?
  rm -f "${a}" "${b}"
  if [ "${rc}" -gt 1 ]; then return "${rc}"; fi
  return 0
}

shopt -s nullglob
for script in "${SCRIPT_DIR}"/*.sh; do
  base="$(basename "${script}")"
  [ "${base}" = "${SELF}" ] && continue

  # The hazard only exists where a lost status can be read as a verdict.
  grep -qE 'set -[a-z]*o pipefail|set -o pipefail' "${script}" || continue

  # Strip comment-only lines so prose describing the bug does not trip it, and
  # allow an explicit `|| true` as a documented tolerance.
  #
  # Done through files, one status at a time, rather than as a pipeline ending
  # in `|| true`. That form was the previous version here, and CodeRabbit was
  # right to call it out: `|| true` covers the WHOLE pipeline, and `grep` exits
  # 1 for "no matches", so an awk that failed outright produced empty output,
  # an empty offenders list, and a cheerful `ok` for a file that was never
  # actually read. A hygiene check that reports clean when its own scanner
  # broke is the exact defect this file exists to stop — one masked status
  # standing in for a verdict.
  #
  # pipefail alone would not have saved it either: it yields the RIGHTMOST
  # non-zero status, so a genuine error (2) upstream is hidden behind a normal
  # "no matches" (1) downstream. Hence a file and an explicit check per step,
  # with >1 treated as an error and 1 as the ordinary empty result.
  if ! scan_ok="$(normalise "${script}")"; then
    fail "${base}: could not normalise for scanning." \
         "The detector never examined this file. Reporting it clean would be" \
         "the same masked-status defect this suite exists to prevent."
    continue
  fi
  offenders="$(filter_and_match "${scan_ok}")"
  rc=$?
  rm -f "${scan_ok}"
  if [ "${rc}" -gt 1 ]; then
    fail "${base}: the scan itself errored (exit ${rc}), so nothing was verified."
    continue
  fi

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
if printf '%s' "${content}" | grep -e "${needle}" -q; then :; fi
if printf '%s' "${content}" | grep --quiet "${needle}"; then :; fi
PROBE
if probe_norm="$(normalise "${probe}")"; then
  n_flagged="$(grep -cE "${EARLY_EXIT_READER}" "${probe_norm}")" || n_flagged=0
  rm -f "${probe_norm}"
else
  n_flagged='normalisation-failed'
fi
if [ "${n_flagged}" = "7" ]; then
  pass "the rule actually detects the shape it exists to ban"
else
  fail "the detector flagged ${n_flagged} of 7 known-bad pipelines." \
       "The probe carries -qF, -Fxq and 'head -n 1' precisely because an" \
       "earlier expression anchored the q at the end of the flag group and" \
       "matched none of them, reporting every file clean. A detector that" \
       "cannot fail is the same thing as no detector. The last two are" \
       "split across lines — one by backslash, one by a trailing pipe — and" \
       "the second escaped the detector entirely before normalisation." \
       "The last two are 'grep -e X -q' and 'grep --quiet': the quiet flag" \
       "is not always the final option token, and both still exit early."
fi

# A detector that over-reports is not "safe by default" — it makes the check
# something people switch off, which is how the gate stops working. These are
# all SAFE and must not be flagged: an OR-list is not a pipeline, and a
# here-string has no pipe to break.
clean_probe="$(mktemp)"
trap 'rm -f "${probe}" "${clean_probe}"' EXIT
cat >"${clean_probe}" <<'CLEAN'
set -euo pipefail
if grep -qF "${needle}" <<<"${content}"; then :; fi
validate_thing || grep -qF "${needle}" <<<"${content}"
check_a || check_b || grep -q "${pattern}" <<<"${subject}"
some_cmd || head -n 1 <<<"${subject}"
run_something ||
  grep -qF "${needle}" <<<"${content}"
CLEAN
if clean_norm="$(normalise "${clean_probe}")"; then
  n_false="$(grep -vE '^[0-9]+:[[:space:]]*#' "${clean_norm}" | grep -cE "${EARLY_EXIT_READER}")" || n_false=0
  rm -f "${clean_norm}"
else
  n_false='normalisation-failed'
fi
if [ "${n_false}" = "0" ]; then
  pass "the rule does not fire on OR-lists or here-strings"
else
  fail "the detector flagged ${n_false} SAFE construct(s)." \
       "An OR-list continues across a newline after '||' just as a pipeline" \
       "does after '|', and its second '|' is followed by the reader name —" \
       "so an unanchored expression reads 'a || grep -q x <<<\$y' as a pipe" \
       "into grep. It is not one. Over-reporting turns this check into" \
       "something a future PR deletes rather than satisfies."
fi

printf '\n%s tests, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ]
