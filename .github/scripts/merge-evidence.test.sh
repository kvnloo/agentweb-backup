#!/usr/bin/env bash
#
# Tests for .github/scripts/merge-evidence.sh (ENG-757).
#
# `gh` is replaced with a scripted mock on PATH, so every branch of the gate
# runs for real without touching GitHub. Run with:
#
#   bash .github/scripts/merge-evidence.test.sh
#
# Every fixture below is a trimmed copy of a real payload captured from this
# repo on 2026-07-31:
#   - the draft-run fixture is agentweb#2231 at 4b933aee (six of seven jobs
#     `skipped`, `Detect changed projects` the only one that ran)
#   - the healthy fixture is agentweb#2235 at 573238f1 (`Require Greptile
#     Review` success, `CI script tests` skipped by path filter)
#
# The final case is a regression proof: it runs the *previous* procedure
# (`gh pr checks`, whose exit code agents branched on) against the draft-run
# fixture and asserts it exited 0. That is the false green this change removes.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE_SCRIPT="${SCRIPT_DIR}/merge-evidence.sh"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

HEAD='4b933aeec6d204c9a452f9e5bdbf5a196a1cf375'

# ---------------------------------------------------------------------------
# Mock gh
# ---------------------------------------------------------------------------
#
# Fixtures live in $MERGE_EVIDENCE_MOCK_DIR:
#   pr_view.json     body for `gh pr view --json ...`
#   pr_view_exit     optional exit code for that call (default 0)
#   checkruns.json   body for `gh api .../check-runs`
#   checkruns_exit   optional exit code for that call (default 0)
#   pr_checks.txt    stdout for `gh pr checks` (regression case only)
#   pr_checks_exit   exit code for `gh pr checks` (regression case only)

install_mock_gh() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
MOCK_DIR="${MERGE_EVIDENCE_MOCK_DIR:?MERGE_EVIDENCE_MOCK_DIR must be set}"

sub="${1:-}"
sub2="${2:-}"

emit_file() {
  # $1 = fixture name, $2 = exit-code fixture name, $3 = fallback body
  code=0
  [ -f "${MOCK_DIR}/$2" ] && code=$(cat "${MOCK_DIR}/$2")
  if [ "$code" != "0" ]; then
    printf 'mock gh: simulated API failure\n' >&2
    exit "$code"
  fi
  cat "${MOCK_DIR}/$1" 2>/dev/null || printf '%s' "$3"
}

if [ "$sub" = "pr" ] && [ "$sub2" = "view" ]; then
  emit_file pr_view.json pr_view_exit '{}'
  exit 0
fi

if [ "$sub" = "pr" ] && [ "$sub2" = "checks" ]; then
  code=0
  [ -f "${MOCK_DIR}/pr_checks_exit" ] && code=$(cat "${MOCK_DIR}/pr_checks_exit")
  cat "${MOCK_DIR}/pr_checks.txt" 2>/dev/null
  exit "$code"
fi

if [ "$sub" = "api" ]; then
  emit_file checkruns.json checkruns_exit '{"total_count":0,"check_runs":[]}'
  exit 0
fi

printf 'mock gh: unexpected invocation: %s\n' "$*" >&2
exit 64
MOCK
  chmod +x "${WORKDIR}/bin/gh"
  PATH="${WORKDIR}/bin:${PATH}"
  export PATH
}

# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------

new_fixture_dir() {
  mktemp -d "${WORKDIR}/fixture.XXXXXX"
}

# pr_view <dir> <mergeable> [isDraft] [state] [headSha]
pr_view() {
  local dir="$1" mergeable="$2" draft="${3:-false}" state="${4:-OPEN}" sha="${5:-${HEAD}}"
  cat >"${dir}/pr_view.json" <<EOF
{"number":2231,"state":"${state}","isDraft":${draft},"mergeable":"${mergeable}",
 "mergeStateStatus":"CLEAN","headRefOid":"${sha}"}
EOF
}

# checkruns <dir> <json array of {name,status,conclusion}>
checkruns() {
  local dir="$1" runs="$2" total
  total="$(printf '%s' "${runs}" | jq 'length')"
  printf '{"total_count":%s,"check_runs":%s}\n' "${total}" "${runs}" >"${dir}/checkruns.json"
}

# The real agentweb#2231 draft run: everything draft-gated skipped, the two
# path-gated jobs skipped too, only Detect changed projects executed.
DRAFT_RUN_RUNS='[
  {"name":"Require Greptile Review","status":"completed","conclusion":"skipped"},
  {"name":"Partner portal tests","status":"completed","conclusion":"skipped"},
  {"name":"Backend deploy to staging (after tests pass)","status":"completed","conclusion":"skipped"},
  {"name":"CI script tests","status":"completed","conclusion":"skipped"},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"skipped"},
  {"name":"Backend tests (all other + coverage)","status":"completed","conclusion":"skipped"},
  {"name":"Detect changed projects","status":"completed","conclusion":"success"}
]'

# The real agentweb#2235 ready run, with the in-progress jobs landed green.
HEALTHY_RUNS='[
  {"name":"CI script tests","status":"completed","conclusion":"skipped"},
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Partner portal tests","status":"completed","conclusion":"skipped"},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"success"},
  {"name":"Backend tests (all other + coverage)","status":"completed","conclusion":"success"},
  {"name":"Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Detect changed projects","status":"completed","conclusion":"success"}
]'

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------

LAST_EXIT=0
LAST_OUTPUT=''

run_gate() {
  local dir="$1"
  LAST_OUTPUT="$(MERGE_EVIDENCE_MOCK_DIR="${dir}" \
    REPO='AgentWebPro/agentweb' \
    PR_NUMBER='2231' \
    GH_TOKEN='mock' \
    bash "${GATE_SCRIPT}" 2>&1)"
  LAST_EXIT=$?
}

check() {
  local desc="$1" expected_exit="$2" expected_substr="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "${LAST_EXIT}" != "${expected_exit}" ]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL  %s\n      expected exit %s, got %s\n      output: %s\n' \
      "${desc}" "${expected_exit}" "${LAST_EXIT}" "${LAST_OUTPUT}"
    return
  fi
  if [ -n "${expected_substr}" ] && ! printf '%s' "${LAST_OUTPUT}" | grep -qF "${expected_substr}"; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL  %s\n      expected output to contain: %s\n      output: %s\n' \
      "${desc}" "${expected_substr}" "${LAST_OUTPUT}"
    return
  fi
  printf 'ok    %s\n' "${desc}"
}

install_mock_gh

# ---------------------------------------------------------------------------
# AC1 — a conflicted PR cannot present as passing
# ---------------------------------------------------------------------------

# The incident shape: the base moved, so the merge ref cannot be built. Note the
# head SHA is UNCHANGED and the check-runs at it are the green-looking draft run,
# which is exactly why binding evidence to the head SHA alone does not save us.
d="$(new_fixture_dir)"
pr_view "${d}" 'CONFLICTING'
checkruns "${d}" "${DRAFT_RUN_RUNS}"
run_gate "${d}"
check 'AC1: conflicted PR is NO_EVIDENCE, never green' 3 'NO_EVIDENCE'

d="$(new_fixture_dir)"
pr_view "${d}" 'CONFLICTING'
checkruns "${d}" "${HEALTHY_RUNS}"
run_gate "${d}"
check 'AC1: conflicted PR is NO_EVIDENCE even with a fully green run at head' 3 'merge ref'

d="$(new_fixture_dir)"
pr_view "${d}" 'UNKNOWN'
checkruns "${d}" "${HEALTHY_RUNS}"
run_gate "${d}"
check 'AC1: mergeability still computing is PENDING, never green' 2 'PENDING'

# ---------------------------------------------------------------------------
# AC3 — a draft-time run where all jobs skipped never satisfies the gate
# ---------------------------------------------------------------------------

# This is the ENG-757 case in its purest form: PR is ready, mergeable, and the
# only run at its head is the stale draft run in which nothing that matters ran.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${DRAFT_RUN_RUNS}"
run_gate "${d}"
check 'AC3: ready PR carrying only a draft-time all-skipped run is NO_EVIDENCE' 3 'NO_EVIDENCE'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${DRAFT_RUN_RUNS}"
run_gate "${d}"
check 'AC3: the reason names the draft-gated discriminator' 3 'Require Greptile Review'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' 'true'
checkruns "${d}" "${DRAFT_RUN_RUNS}"
run_gate "${d}"
check 'AC3: an actually-draft PR is NO_EVIDENCE' 3 'draft'

# ---------------------------------------------------------------------------
# AC4 — "no check has ever run against this head" is distinguishable from green
# ---------------------------------------------------------------------------

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[]'
run_gate "${d}"
check 'AC4: zero check-runs at head is NO_EVIDENCE, not green' 3 'no check has ever run'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${HEALTHY_RUNS}"
run_gate "${d}"
check 'AC4: a real green run prints PASS, a distinct verdict token' 0 'VERDICT: PASS'

# The discriminator is matched by exact name. If the job is renamed the gate
# must fail closed rather than silently lose its ability to spot a draft run.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Detect changed projects","status":"completed","conclusion":"success"},
  {"name":"Greptile Review","status":"completed","conclusion":"success"}
]'
run_gate "${d}"
check 'AC4: discriminator job absent is NO_EVIDENCE (fails closed on rename)' 3 'NO_EVIDENCE'

# ---------------------------------------------------------------------------
# AC5 — legitimate path-filter skips remain acceptable, and are named
# ---------------------------------------------------------------------------

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${HEALTHY_RUNS}"
run_gate "${d}"
check 'AC5: path-filter skips do not block a pass' 0 'VERDICT: PASS'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${HEALTHY_RUNS}"
run_gate "${d}"
check 'AC5: the pass explicitly names the path-filter-skipped jobs' 0 'CI script tests'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${HEALTHY_RUNS}"
run_gate "${d}"
check 'AC5: the pass distinguishes skipped-by-path from executed' 0 'skipped by path filter'

# ---------------------------------------------------------------------------
# AC2 — recovery is automatic once the conflict clears and a real run lands
# ---------------------------------------------------------------------------

# Same script, same PR, no flags, no cached state: only the live payload differs.
d="$(new_fixture_dir)"
pr_view "${d}" 'CONFLICTING'
checkruns "${d}" "${DRAFT_RUN_RUNS}"
run_gate "${d}"
check 'AC2: before — conflicted and blind' 3 'NO_EVIDENCE'

pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${HEALTHY_RUNS}"
run_gate "${d}"
check 'AC2: after — conflict resolved and a real run landed, no intervention' 0 'VERDICT: PASS'

# ---------------------------------------------------------------------------
# Ordinary states still report ordinarily
# ---------------------------------------------------------------------------

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Backend tests (agentMode)","status":"in_progress","conclusion":null},
  {"name":"Detect changed projects","status":"completed","conclusion":"success"}
]'
run_gate "${d}"
check 'a run still in flight is PENDING' 2 'PENDING'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"failure"},
  {"name":"Detect changed projects","status":"completed","conclusion":"success"}
]'
run_gate "${d}"
check 'a genuinely failing check is FAIL' 1 'VERDICT: FAIL'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"cancelled"},
  {"name":"Detect changed projects","status":"completed","conclusion":"success"}
]'
run_gate "${d}"
check 'a cancelled check is FAIL, not a pass' 1 'VERDICT: FAIL'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' 'false' 'MERGED'
checkruns "${d}" "${HEALTHY_RUNS}"
run_gate "${d}"
check 'a non-open PR is not evaluated as mergeable' 3 'MERGED'

# ---------------------------------------------------------------------------
# Fail loud when the evidence surface itself is unreadable
# ---------------------------------------------------------------------------

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
printf 'not json at all\n' >"${d}/checkruns.json"
run_gate "${d}"
check 'unparseable check-run payload fails loud, never passes' 4 'unparseable'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${HEALTHY_RUNS}"
printf '1' >"${d}/checkruns_exit"
run_gate "${d}"
check 'a GitHub API error fails loud, never passes' 4 'failed'

d="$(new_fixture_dir)"
printf 'not json\n' >"${d}/pr_view.json"
checkruns "${d}" "${HEALTHY_RUNS}"
run_gate "${d}"
check 'unparseable PR payload fails loud, never passes' 4 'unparseable'

# A truncated page would silently hide the one job that failed.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
printf '{"total_count":40,"check_runs":%s}\n' "${HEALTHY_RUNS}" >"${d}/checkruns.json"
run_gate "${d}"
check 'a truncated check-run page fails loud, never passes' 4 'truncated'

# ---------------------------------------------------------------------------
# Regression proof — the previous procedure returns a false green here
# ---------------------------------------------------------------------------
#
# What agents actually did before this script: run `gh pr checks <n>` and branch
# on its exit code. Captured live on 2026-07-31 against agentweb#2231, whose
# only run is the all-skipped draft run: `gh pr checks` renders every skipped
# job as "skipping" and exits 0. Nothing distinguishes that from a real pass.

d="$(new_fixture_dir)"
cat >"${d}/pr_checks.txt" <<'EOF'
Backend deploy to staging (after tests pass)	skipping	0	https://github.com/...
Backend tests (agentMode)	skipping	0	https://github.com/...
Backend tests (all other + coverage)	skipping	0	https://github.com/...
CI script tests	skipping	0	https://github.com/...
Partner portal tests	skipping	0	https://github.com/...
Require Greptile Review	skipping	0	https://github.com/...
Detect changed projects	pass	26s	https://github.com/...
EOF
printf '0' >"${d}/pr_checks_exit"

old_logic() {
  MERGE_EVIDENCE_MOCK_DIR="${d}" gh pr checks 2231 --repo AgentWebPro/agentweb >/dev/null 2>&1
}
old_logic
old_exit=$?

TESTS_RUN=$((TESTS_RUN + 1))
if [ "${old_exit}" -eq 0 ]; then
  printf 'ok    regression proof: the old "gh pr checks" procedure exits 0 on the ENG-757 draft run (the false green)\n'
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL  regression proof: expected the old procedure to exit 0, got %s\n' "${old_exit}"
fi

# And the new gate refuses the identical state.
d2="$(new_fixture_dir)"
pr_view "${d2}" 'MERGEABLE'
checkruns "${d2}" "${DRAFT_RUN_RUNS}"
run_gate "${d2}"
check 'regression proof: the new gate refuses that same state' 3 'NO_EVIDENCE'

# ---------------------------------------------------------------------------
# Invariant guard — the discriminator must stay draft-gated ONLY
# ---------------------------------------------------------------------------
#
# The gate's ability to tell a draft skip from a path-filter skip rests entirely
# on `Require Greptile Review` being conditioned on draft state and nothing else.
# Add a path filter to that job and every assertion above still passes while the
# real gate quietly stops working, because a path-skipped discriminator is
# indistinguishable from a draft-skipped one. Assert the workflow here so the
# invariant breaks loudly, in CI, in the PR that breaks it.

WORKFLOW="$(cd "${SCRIPT_DIR}/../.." && pwd)/.github/workflows/tests.yml"
DISCRIMINATOR_IF="$(awk '
  /^  greptile-review:/ { in_job = 1; next }
  in_job && /^  [a-z]/  { exit }
  in_job && /^    if:/  { sub(/^    if: */, ""); print; exit }
' "${WORKFLOW}")"

TESTS_RUN=$((TESTS_RUN + 1))
if [ "${DISCRIMINATOR_IF}" = "github.event.pull_request.draft == false" ]; then
  printf "ok    invariant: the 'Require Greptile Review' job is gated on draft state alone\n"
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf "FAIL  invariant: 'Require Greptile Review' must be gated on draft state ALONE for the\n"
  printf "      draft-vs-path-filter distinction to hold. Found: '%s'\n" "${DISCRIMINATOR_IF}"
  printf "      If this job legitimately gained a path filter, merge-evidence.sh needs a new\n"
  printf "      discriminator — it can no longer tell a draft run from a path-skipped one.\n"
fi

printf '\n%s tests, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ]
