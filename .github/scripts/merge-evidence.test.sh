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
#   checkruns.json     body for `gh api .../check-runs`
#   checkruns_exit     optional exit code for that call (default 0)
#   workflowruns.json  body for `gh api .../actions/runs?head_sha=`
#   workflowruns_exit  optional exit code for that call (default 0)
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
  # Dispatch on the endpoint: the gate reads workflow runs (to learn which
  # suites are superseded) and check-runs (the evidence itself).
  case "${sub2}" in
    *actions/runs*)
      emit_file workflowruns.json workflowruns_exit '{"total_count":0,"workflow_runs":[]}'
      ;;
    *pulls/*/files*)
      # ENG-915: the diff decides whether the backend suite was required here.
      # `--jq '.[].filename'` is applied by real gh, so the mock emits the
      # already-projected filename list the script consumes.
      #
      # The default is deliberately a NON-backend path. Every case written
      # before ENG-915 asserts on the draft/path-filter/supersession logic and
      # says nothing about the backend suite; defaulting to a backend file
      # would silently add "and the backend jobs must be green" to all of them,
      # so those fixtures would start failing for a reason they do not test.
      # Cases that mean to exercise the new rule set files.txt explicitly.
      emit_file files.txt files_exit 'partner-portal/src/App.tsx'
      ;;
    *compare/*)
      # ENG-1003: what the base branch gained since this PR diverged. Emitted
      # as raw JSON, not a projected list, because the gate reads two things
      # from it — the file list AND `ahead_by` — and a single `--jq` could only
      # project one of them.
      #
      # The default is an EMPTY file list, which the gate reads as "the base
      # moved but changed nothing this PR touches". Cases that mean to exercise
      # the overlap rule set compare.json explicitly. This default is only ever
      # consulted when mergeStateStatus is BEHIND, and every fixture written
      # before ENG-1003 is CLEAN, so it cannot alter their verdicts.
      emit_file compare.json compare_exit '{"ahead_by":0,"files":[]}'
      ;;
    *)
      emit_file checkruns.json checkruns_exit '{"total_count":0,"check_runs":[]}'
      ;;
  esac
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

# pr_view <dir> <mergeable> [isDraft] [state] [headSha] [mergeStateStatus] [baseRefName]
#
# The two trailing parameters are ENG-1003's and default to today's behaviour
# (CLEAN against main), so every fixture written before it keeps its verdict.
pr_view() {
  local dir="$1" mergeable="$2" draft="${3:-false}" state="${4:-OPEN}" sha="${5:-${HEAD}}"
  local merge_state="${6:-CLEAN}" base_ref="${7:-main}"
  cat >"${dir}/pr_view.json" <<EOF
{"number":2231,"state":"${state}","isDraft":${draft},"mergeable":"${mergeable}",
 "mergeStateStatus":"${merge_state}","headRefOid":"${sha}","baseRefName":"${base_ref}"}
EOF
}

# base_compare <dir> <ahead_by> <newline-separated paths the base gained>
# The `repos/{repo}/compare/{head}...{base}` body: `.files` is the diff from the
# merge base to the base branch head, i.e. exactly what landed on main while
# this PR was open (ENG-1003).
base_compare() {
  local dir="$1" ahead="$2" files="$3" json
  json="$(printf '%s\n' "${files}" | jq -R '{filename: .}' | jq -s \
    --argjson ahead "${ahead}" '{ahead_by: $ahead, files: [.[] | select(.filename != "")]}')"
  printf '%s\n' "${json}" >"${dir}/compare.json"
}

# checkruns <dir> <json array of {name,status,conclusion}>
checkruns() {
  local dir="$1" runs="$2" total
  total="$(printf '%s' "${runs}" | jq 'length')"
  printf '{"total_count":%s,"check_runs":%s}\n' "${total}" "${runs}" >"${dir}/checkruns.json"
}

# changed_files <dir> <newline-separated paths>
# The projection real `gh api --jq '.[].filename'` would emit for
# `pulls/{n}/files`. ENG-915 reads it to decide whether the backend suite was
# required at this head.
changed_files() {
  local dir="$1" files="$2"
  printf '%s\n' "${files}" >"${dir}/files.txt"
}

# workflowruns <dir> <json array of {id,workflow_id,run_number,conclusion,check_suite_id}>
# Supersession is proven from this endpoint, never guessed from suite ordering.
workflowruns() {
  local dir="$1" runs="$2" total
  total="$(printf '%s' "${runs}" | jq 'length')"
  printf '{"total_count":%s,"workflow_runs":%s}\n' "${total}" "${runs}" >"${dir}/workflowruns.json"
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

# The ready-flip window, observed live on agentweb#2236 right after its own
# ready-flip: the new run's early jobs are in flight while the draft run's
# `skipped` entries are still the latest for every job it has not reached. The
# honest verdict is PENDING — but it must NEVER become a pass, which is what the
# second case here pins.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Require Greptile Review","status":"completed","conclusion":"skipped"},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"skipped"},
  {"name":"Detect changed projects","status":"in_progress","conclusion":null}
]'
run_gate "${d}"
check 'ready-flip window: a real run executing makes it PENDING, not NO_EVIDENCE' 2 'PENDING'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${DRAFT_RUN_RUNS}"
run_gate "${d}"
check 'ready-flip window: with nothing executing it is still NO_EVIDENCE' 3 'NO_EVIDENCE'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Detect changed projects","status":"in_progress","conclusion":null}
]'
run_gate "${d}"
check 'discriminator absent but a run executing is PENDING, not NO_EVIDENCE' 2 'PENDING'

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

# A ready flip and a synchronize event can race and schedule two workflow runs
# for the same head. GitHub's commit check-runs endpoint returns both suites,
# newest first. The older run is then cancelled by workflow concurrency while
# the newer run completes successfully. Only the latest check context is live;
# flattening both suites makes the superseded cancellation poison the verdict.
SUPERSEDED_CANCELLED_RUN='[
  {"id":210,"app":{"id":15368},"check_suite":{"id":20},"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"id":211,"app":{"id":15368},"check_suite":{"id":20},"name":"Detect changed projects","status":"completed","conclusion":"success"},
  {"id":110,"app":{"id":15368},"check_suite":{"id":10},"name":"Require Greptile Review","status":"completed","conclusion":"skipped"},
  {"id":111,"app":{"id":15368},"check_suite":{"id":10},"name":"Detect changed projects","status":"completed","conclusion":"cancelled"}
]'

# The workflow runs that PROVE suite 10 is superseded: same workflow, run 1
# cancelled, run 2 newer and successful. Without this the gate must not — and
# does not — drop anything, because supersession is never inferred from the
# check-run list alone.
SUPERSEDED_CANCELLED_WFRUNS='[
  {"id":901,"workflow_id":191827888,"run_number":1,"run_attempt":1,"status":"completed","conclusion":"cancelled","check_suite_id":10},
  {"id":902,"workflow_id":191827888,"run_number":2,"run_attempt":1,"status":"completed","conclusion":"success","check_suite_id":20}
]'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${SUPERSEDED_CANCELLED_RUN}"
workflowruns "${d}" "${SUPERSEDED_CANCELLED_WFRUNS}"
run_gate "${d}"
check 'a superseded cancelled workflow does not poison its successful replacement' 0 'VERDICT: PASS'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${SUPERSEDED_CANCELLED_RUN}"
workflowruns "${d}" "${SUPERSEDED_CANCELLED_WFRUNS}"
run_gate "${d}"
check 'the stale skipped discriminator is ignored in favour of the latest suite' 0 'Require Greptile Review'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${SUPERSEDED_CANCELLED_RUN}"
workflowruns "${d}" "${SUPERSEDED_CANCELLED_WFRUNS}"
run_gate "${d}"
check 'the verdict reports how many superseded check-runs were ignored' 0 'ignored 2 superseded check-run(s)'

# The inverse guards against a cosmetic dedupe that simply prefers success:
# the latest suite still owns the context when it is the failing one.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"id":210,"app":{"id":15368},"check_suite":{"id":20},"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"id":211,"app":{"id":15368},"check_suite":{"id":20},"name":"Detect changed projects","status":"completed","conclusion":"failure"},
  {"id":110,"app":{"id":15368},"check_suite":{"id":10},"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"id":111,"app":{"id":15368},"check_suite":{"id":10},"name":"Detect changed projects","status":"completed","conclusion":"success"}
]'
run_gate "${d}"
check 'a latest failure still blocks even when a superseded suite passed' 1 'VERDICT: FAIL'

# Greptile's finding on this PR: a `neutral` check sitting beside a success was
# excluded from every count, so the gate emitted PASS and silently dropped it.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"neutral"},
  {"name":"Detect changed projects","status":"completed","conclusion":"success"}
]'
run_gate "${d}"
check 'a neutral check beside a success does NOT pass' 1 'VERDICT: FAIL'

# The generalisation: hard-coding "neutral" would leave the same hole open for
# the next conclusion GitHub adds. Anything outside the known sets must block.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Some Future Check","status":"completed","conclusion":"quarantined"},
  {"name":"Detect changed projects","status":"completed","conclusion":"success"}
]'
run_gate "${d}"
check 'an unrecognised conclusion beside a success does NOT pass' 1 'does not recognise'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Odd Check","status":"completed","conclusion":null},
  {"name":"Detect changed projects","status":"completed","conclusion":"success"}
]'
run_gate "${d}"
check 'a completed check with a null conclusion does NOT pass' 1 'does not recognise'

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
# Superseded runs, against the verbatim payload that exposed the bug
# ---------------------------------------------------------------------------
#
# agentweb#2231 at 321fbdd6, captured unmodified on 2026-07-31 — the PR was
# pushed and flipped ready 13s later, cancel-in-progress killed run 4936
# (suite 83144420933) and run 4937 (suite 83144461834) carried the real result.
# Row order is the API's own, which is what made the discriminator's `last`
# land on the superseded `skipped`. Do not sort it.
SUPERSEDED_2231='[
  {"id":1,"app":{"id":15368},"name":"Backend deploy to staging (after tests pass)","status":"completed","conclusion":"success","check_suite":{"id":83144461834}},
  {"id":2,"app":{"id":15368},"name":"Partner portal tests","status":"completed","conclusion":"skipped","check_suite":{"id":83144461834}},
  {"id":3,"app":{"id":15368},"name":"CI script tests","status":"completed","conclusion":"skipped","check_suite":{"id":83144461834}},
  {"id":4,"app":{"id":15368},"name":"Require Greptile Review","status":"completed","conclusion":"success","check_suite":{"id":83144461834}},
  {"id":5,"app":{"id":15368},"name":"Backend tests (agentMode)","status":"completed","conclusion":"success","check_suite":{"id":83144461834}},
  {"id":6,"app":{"id":15368},"name":"Backend tests (all other + coverage)","status":"completed","conclusion":"success","check_suite":{"id":83144461834}},
  {"id":7,"app":{"id":15368},"name":"Backend deploy to staging (after tests pass)","status":"completed","conclusion":"skipped","check_suite":{"id":83144420933}},
  {"id":8,"app":{"id":15368},"name":"Partner portal tests","status":"completed","conclusion":"skipped","check_suite":{"id":83144420933}},
  {"id":9,"app":{"id":15368},"name":"CI script tests","status":"completed","conclusion":"skipped","check_suite":{"id":83144420933}},
  {"id":10,"app":{"id":15368},"name":"Backend tests (agentMode)","status":"completed","conclusion":"skipped","check_suite":{"id":83144420933}},
  {"id":11,"app":{"id":15368},"name":"Require Greptile Review","status":"completed","conclusion":"skipped","check_suite":{"id":83144420933}},
  {"id":12,"app":{"id":15368},"name":"Backend tests (all other + coverage)","status":"completed","conclusion":"skipped","check_suite":{"id":83144420933}},
  {"id":13,"app":{"id":57789},"name":"Greptile Review","status":"completed","conclusion":"success","check_suite":{"id":83144408061}},
  {"id":14,"app":{"id":15368},"name":"Detect changed projects","status":"completed","conclusion":"success","check_suite":{"id":83144461834}},
  {"id":15,"app":{"id":15368},"name":"Detect changed projects","status":"completed","conclusion":"cancelled","check_suite":{"id":83144420933}}
]'
SUPERSEDED_2231_WFRUNS='[
  {"id":30658029710,"workflow_id":191827888,"run_number":4936,"run_attempt":1,"status":"completed","conclusion":"cancelled","check_suite_id":83144420933},
  {"id":30658043619,"workflow_id":191827888,"run_number":4937,"run_attempt":1,"status":"completed","conclusion":"success","check_suite_id":83144461834}
]'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" "${SUPERSEDED_2231}"
workflowruns "${d}" "${SUPERSEDED_2231_WFRUNS}"
run_gate "${d}"
check 'the verbatim agentweb#2231 payload passes, as the PR really was' 0 'VERDICT: PASS'

# Greptile's suite (83144408061) has no workflow run at all, so it can never be
# in the superseded set. Its success must survive the narrowing.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" "${SUPERSEDED_2231}"
workflowruns "${d}" "${SUPERSEDED_2231_WFRUNS}"
run_gate "${d}"
check 'a third-party suite with no workflow run is never treated as superseded' 0 'Greptile Review'

# THE FALSE GREEN THIS MECHANISM EXISTS TO PREVENT.
#
# Two DIFFERENT workflows at one head, same GitHub App, sharing a job name
# ("test"). Neither is cancelled; both are live. The older one genuinely FAILED.
# A dedupe that keeps the highest suite id per App+name drops that failure and
# reports PASS — measured, not hypothesised. Supersession must come from the
# workflow-run API, where neither run qualifies, so the failure still blocks.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" '[
  {"id":1,"app":{"id":15368},"name":"Require Greptile Review","status":"completed","conclusion":"success","check_suite":{"id":100}},
  {"id":2,"app":{"id":15368},"name":"test","status":"completed","conclusion":"failure","check_suite":{"id":100}},
  {"id":3,"app":{"id":15368},"name":"test","status":"completed","conclusion":"success","check_suite":{"id":200}}
]'
workflowruns "${d}" '[
  {"id":11,"workflow_id":111,"run_number":5,"run_attempt":1,"status":"completed","conclusion":"failure","check_suite_id":100},
  {"id":12,"workflow_id":222,"run_number":9,"run_attempt":1,"status":"completed","conclusion":"success","check_suite_id":200}
]'
run_gate "${d}"
check 'a live failure sharing a job name with a newer workflow still blocks' 1 'test (failure)'

# A re-run WITHIN one suite is the case name-dedupe legitimately handles: same
# job, same suite, higher check-run id wins. This must keep working.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" '[
  {"id":1,"app":{"id":15368},"name":"Require Greptile Review","status":"completed","conclusion":"success","check_suite":{"id":100}},
  {"id":2,"app":{"id":15368},"name":"Backend tests (agentMode)","status":"completed","conclusion":"failure","check_suite":{"id":100}},
  {"id":3,"app":{"id":15368},"name":"Backend tests (agentMode)","status":"completed","conclusion":"success","check_suite":{"id":100}}
]'
workflowruns "${d}" '[
  {"id":11,"workflow_id":111,"run_number":5,"run_attempt":2,"status":"completed","conclusion":"success","check_suite_id":100}
]'
run_gate "${d}"
check 'a re-run within one suite supersedes its earlier failure' 0 'VERDICT: PASS'

# A workflow run exists before its first check-run row does. If an older run at
# the same head is already green, looking only at check-runs false-passes during
# that window even though GitHub still has a relevant run queued/in progress.
COMPLETED_GREEN_RUN='[
  {"id":1,"app":{"id":15368},"name":"Require Greptile Review","status":"completed","conclusion":"success","check_suite":{"id":100}},
  {"id":2,"app":{"id":15368},"name":"Detect changed projects","status":"completed","conclusion":"success","check_suite":{"id":100}}
]'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" "${COMPLETED_GREEN_RUN}"
workflowruns "${d}" '[
  {"id":11,"name":"Tests","workflow_id":111,"run_number":5,"status":"completed","conclusion":"success","check_suite_id":100},
  {"id":12,"name":"Tests","workflow_id":111,"run_number":6,"status":"queued","conclusion":null,"check_suite_id":200}
]'
run_gate "${d}"
check 'a newer queued workflow with no check-run rows is PENDING, never PASS' 2 'VERDICT: PENDING'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" "${COMPLETED_GREEN_RUN}"
workflowruns "${d}" '[
  {"id":11,"name":"Tests","workflow_id":111,"run_number":5,"status":"completed","conclusion":"success","check_suite_id":100},
  {"id":12,"name":"Tests","workflow_id":111,"run_number":6,"status":"queued","conclusion":null,"check_suite_id":200}
]'
run_gate "${d}"
check 'the workflow-level pending verdict names the run with no check rows' 2 'Tests (run 12: queued)'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" "${COMPLETED_GREEN_RUN}"
workflowruns "${d}" '[
  {"id":11,"name":"Tests","workflow_id":111,"run_number":5,"status":"completed","conclusion":"success","check_suite_id":100},
  {"id":12,"name":"Tests","workflow_id":111,"run_number":6,"status":"in_progress","conclusion":null,"check_suite_id":200}
]'
run_gate "${d}"
check 'an in-progress workflow with no check-run rows is PENDING, never PASS' 2 'VERDICT: PENDING'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" "${COMPLETED_GREEN_RUN}"
workflowruns "${d}" '[
  {"id":11,"name":"Tests","workflow_id":111,"run_number":5,"status":"completed","conclusion":"success","check_suite_id":100}
]'
run_gate "${d}"
check 'a completed workflow with green check-runs still passes' 0 'VERDICT: PASS'

# Exclusion is driven by the workflow-run API alone: with no such data the gate
# must not invent a supersession. It fails closed rather than widening.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" "${SUPERSEDED_2231}"
workflowruns "${d}" '[]'
run_gate "${d}"
# Nothing is proven superseded, so the cancelled row survives and blocks. Exit 1
# rather than 3, but the guarantee that matters holds: never green.
check 'with no workflow-run data nothing is dropped and the cancelled row blocks' 1 'Detect changed projects (cancelled)'

# A cancelled run with no newer run of the same workflow is the only evidence
# there is, and it is bad evidence. It is not superseded.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" '[
  {"id":1,"app":{"id":15368},"name":"Require Greptile Review","status":"completed","conclusion":"success","check_suite":{"id":10}},
  {"id":2,"app":{"id":15368},"name":"Detect changed projects","status":"completed","conclusion":"cancelled","check_suite":{"id":10}}
]'
workflowruns "${d}" '[
  {"id":901,"workflow_id":191827888,"run_number":1,"run_attempt":1,"status":"completed","conclusion":"cancelled","check_suite_id":10}
]'
run_gate "${d}"
check 'a lone cancelled run is not superseded and still blocks' 1 'cancelled)'

# The workflow-run API being unreadable is blindness, not a pass.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" "${SUPERSEDED_2231}"
workflowruns "${d}" "${SUPERSEDED_2231_WFRUNS}"
printf '1' >"${d}/workflowruns_exit"
run_gate "${d}"
check 'an unreadable workflow-run API is ERROR, never a pass' 4 'ERROR'

# A truncated workflow-run page could hide the newer run that supersedes a
# poison suite, silently resurrecting the false negative.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' false OPEN '321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
checkruns "${d}" "${SUPERSEDED_2231}"
printf '{"total_count":40,"workflow_runs":%s}\n' "${SUPERSEDED_2231_WFRUNS}" >"${d}/workflowruns.json"
run_gate "${d}"
check 'a truncated workflow-run page fails loud, never passes' 4 'truncated'

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
# ENG-915 AC4 — the Greptile gate reorders work, it must not reduce evidence
# ---------------------------------------------------------------------------
#
# Gating the backend suite on `greptile-review` gives its `skipped` a third
# meaning: "the gate did not pass". Every case below is a state that reads as a
# clean PASS to the pre-ENG-915 gate, because the discriminator executed and
# nothing failed. The suite simply never ran.

# The state that makes this urgent rather than theoretical. `re-run failed jobs`
# appends to the SAME check suite, so re-running only the gate turns it green
# and leaves the earlier skips beside it — a payload in which every visible
# signal is success and the tests were never executed at this head.
GREPTILE_RERUN_RUNS='[
  {"name":"Detect changed projects","status":"completed","conclusion":"success"},
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"skipped"},
  {"name":"Backend tests (all other + coverage)","status":"completed","conclusion":"skipped"},
  {"name":"Partner portal tests","status":"completed","conclusion":"skipped"},
  {"name":"CI script tests","status":"completed","conclusion":"skipped"}
]'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${GREPTILE_RERUN_RUNS}"
changed_files "${d}" 'backend/src/services/db.ts'
run_gate "${d}"
check 'a backend diff whose suite was Greptile-skipped is NO_EVIDENCE, not PASS' 3 'Backend tests (agentMode) (skipped)'

# The same payload with a diff the path filter really does exclude. The skip is
# then legitimate and the verdict must stay PASS — the new rule has to fire on
# the diff, not on the mere presence of a skipped backend job, or it would
# block every frontend-only PR.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${GREPTILE_RERUN_RUNS}"
changed_files "${d}" 'partner-portal/src/App.tsx
customer-portal/src/main.tsx'
run_gate "${d}"
check 'a frontend-only diff still passes with the backend suite skipped' 0 'PASS'

# ENG-743: tests.yml and eb-deploy.sh are classified as backend changes by the
# workflow's own paths filter, so they carry the same requirement. Mirrored
# here, because a PR editing this very gate is exactly the one that must not be
# able to exempt itself from it.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${GREPTILE_RERUN_RUNS}"
changed_files "${d}" '.github/workflows/tests.yml'
run_gate "${d}"
check 'editing tests.yml counts as a backend change and needs the suite' 3 'NO_EVIDENCE'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${GREPTILE_RERUN_RUNS}"
changed_files "${d}" '.github/scripts/eb-deploy.sh'
run_gate "${d}"
check 'editing eb-deploy.sh counts as a backend change and needs the suite' 3 'NO_EVIDENCE'

# The prefixes are anchored at the start of the path. A regex over these
# strings would match `backend/` anywhere in the path and quietly demand the
# backend suite of a portal-only PR.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${GREPTILE_RERUN_RUNS}"
changed_files "${d}" 'partner-portal/src/backend/client.ts'
run_gate "${d}"
check 'a nested path merely containing "backend/" is not a backend change' 0 'PASS'

# A backend diff with the suite genuinely green is the case the whole gate
# exists to let through.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${HEALTHY_RUNS}"
changed_files "${d}" 'backend/src/server.ts'
run_gate "${d}"
check 'a backend diff with a green suite passes' 0 'PASS'

# Absent is not the same as skipped, and must not be the same as passed either:
# a payload that simply never mentions the job is the ENG-757 shape again.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Detect changed projects","status":"completed","conclusion":"success"},
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"}
]'
changed_files "${d}" 'backend/src/server.ts'
run_gate "${d}"
check 'a backend diff with the suite absent entirely is NO_EVIDENCE' 3 '(ABSENT)'

# A re-run at a head whose suite already went green must not lose that result.
# Suite 100 ran the tests to success; suite 200 is a re-run whose Greptile gate
# came back below 5/5, so the tests skipped. The head is unchanged, so the
# green in suite 100 tested exactly this code. Reporting NO_EVIDENCE here would
# be wrong on the facts AND unfixable by the author, since pushing anything to
# clear it changes the head this evidence belongs to.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Detect changed projects","status":"completed","conclusion":"success","check_suite":{"id":100},"id":1},
  {"name":"Require Greptile Review","status":"completed","conclusion":"success","check_suite":{"id":100},"id":2},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"success","check_suite":{"id":100},"id":3},
  {"name":"Backend tests (all other + coverage)","status":"completed","conclusion":"success","check_suite":{"id":100},"id":4},
  {"name":"Require Greptile Review","status":"completed","conclusion":"success","check_suite":{"id":200},"id":5},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"skipped","check_suite":{"id":200},"id":6},
  {"name":"Backend tests (all other + coverage)","status":"completed","conclusion":"skipped","check_suite":{"id":200},"id":7}
]'
changed_files "${d}" 'backend/src/server.ts'
run_gate "${d}"
check 'a re-run that skipped the suite does not discard an earlier green at the same head' 0 'PASS'

# The safety half of the same rule: "ever passed" must not become "ignore a
# later failure". A failing re-run is caught by the classification pass long
# before the backend requirement is consulted, so the earlier success cannot
# rescue it.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Detect changed projects","status":"completed","conclusion":"success","check_suite":{"id":100},"id":1},
  {"name":"Require Greptile Review","status":"completed","conclusion":"success","check_suite":{"id":100},"id":2},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"success","check_suite":{"id":100},"id":3},
  {"name":"Backend tests (all other + coverage)","status":"completed","conclusion":"success","check_suite":{"id":100},"id":4},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"failure","check_suite":{"id":200},"id":6}
]'
changed_files "${d}" 'backend/src/server.ts'
run_gate "${d}"
check 'an earlier green never masks a later failure at the same head' 1 'FAIL'

# The backend requirement must never be the reason a PR is blocked when some
# OTHER, accurate reason applies — and it must never fire on a PR the path
# filter legitimately excluded. Both depend on section 7 staying LAST, after
# the draft, failure and pending verdicts. That ordering is load-bearing and
# otherwise undefended: hoisting section 7 above the pending check would block
# every backend PR while its suite is still running, and nothing else here
# would notice. These cases pin the ordering by its observable effect.

# Draft: the draft verdict, not the backend block. Greptile is skipped on a
# draft, which is exactly the "a check was skipped, is that a problem?" shape.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE' 'true'
checkruns "${d}" "${DRAFT_RUN_RUNS}"
changed_files "${d}" 'backend/src/server.ts'
run_gate "${d}"
check 'a draft backend PR reports DRAFT, not the backend-suite block' 3 'is a draft'

# Greptile refused: the failure is the reason, and it is named. Reporting
# NO_EVIDENCE here would send the reader looking for a missing run when the
# actual problem is a review that said no.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Detect changed projects","status":"completed","conclusion":"success"},
  {"name":"Require Greptile Review","status":"completed","conclusion":"failure"},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"skipped"},
  {"name":"Backend tests (all other + coverage)","status":"completed","conclusion":"skipped"}
]'
changed_files "${d}" 'backend/src/server.ts'
run_gate "${d}"
check 'a refused-Greptile backend PR reports FAIL, not the backend-suite block' 1 'FAIL'

# Mid-suite: PENDING. This is the one that would bite hardest if the ordering
# regressed, because it is the normal state of every backend PR for ~15 min.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" '[
  {"name":"Detect changed projects","status":"completed","conclusion":"success"},
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Backend tests (agentMode)","status":"in_progress","conclusion":null},
  {"name":"Backend tests (all other + coverage)","status":"in_progress","conclusion":null}
]'
changed_files "${d}" 'backend/src/server.ts'
run_gate "${d}"
check 'a backend PR mid-suite reports PENDING, not the backend-suite block' 2 'PENDING'

# And the whole class of diffs the backend filter legitimately excludes. Each
# skips the suite for a good reason and must still pass — including the two
# CI-path files that are deliberately NOT backend paths, which is the easiest
# place to over-reach when widening BACKEND_PATHS later.
NON_BACKEND_RUNS='[
  {"name":"Detect changed projects","status":"completed","conclusion":"success"},
  {"name":"Require Greptile Review","status":"completed","conclusion":"success"},
  {"name":"Backend tests (agentMode)","status":"completed","conclusion":"skipped"},
  {"name":"Backend tests (all other + coverage)","status":"completed","conclusion":"skipped"},
  {"name":"Partner portal tests","status":"completed","conclusion":"skipped"},
  {"name":"CI script tests","status":"completed","conclusion":"skipped"}
]'
for non_backend in \
  'partner-portal/src/App.tsx' \
  '.github/workflows/deploy.yml' \
  '.github/scripts/merge-evidence.sh' \
  'docs/readme.md' \
  'agent-engine/web_agent.py'; do
  d="$(new_fixture_dir)"
  pr_view "${d}" 'MERGEABLE'
  checkruns "${d}" "${NON_BACKEND_RUNS}"
  changed_files "${d}" "${non_backend}"
  run_gate "${d}"
  check "a PR touching only ${non_backend} passes with the suite skipped" 0 'PASS'
done

# Renaming a job must fail closed rather than delete the requirement. With the
# override pointing at a name nothing reports, the gate blocks.
TESTS_RUN=$((TESTS_RUN + 1))
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${HEALTHY_RUNS}"
changed_files "${d}" 'backend/src/server.ts'
LAST_OUTPUT="$(MERGE_EVIDENCE_MOCK_DIR="${d}" REPO='AgentWebPro/agentweb' PR_NUMBER='2231' \
  GH_TOKEN='mock' MERGE_EVIDENCE_BACKEND_JOBS='Backend tests (renamed)' \
  bash "${GATE_SCRIPT}" 2>&1)"
LAST_EXIT=$?
check 'MERGE_EVIDENCE_BACKEND_JOBS is honoured and an unknown name fails closed' 3 'Backend tests (renamed) (ABSENT)'

# An unreadable diff is an ERROR, not a verdict: the gate cannot tell whether
# the requirement applies, which is a statement about the API, not the PR.
d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${HEALTHY_RUNS}"
printf '1' >"${d}/files_exit"
run_gate "${d}"
check 'an unreadable changed-files API is ERROR, never a pass' 4 'ERROR'

d="$(new_fixture_dir)"
pr_view "${d}" 'MERGEABLE'
checkruns "${d}" "${HEALTHY_RUNS}"
changed_files "${d}" ''
run_gate "${d}"
check 'an empty changed-files list is ERROR, never a pass' 4 'ERROR'

# ---------------------------------------------------------------------------
# ENG-1003: the evidence must describe the merge that would actually happen
# ---------------------------------------------------------------------------
#
# Everything above establishes that a real run executed at this head and nothing
# failed. That is a statement about the PR's own code. It is NOT a statement
# about the merge, because `refs/pull/N/merge` — what the suite actually checks
# out on a `pull_request` event — was built against whatever `main` was when the
# run started. Commits that land on `main` afterwards are outside the evidence.
#
# Today nothing in this gate notices that. The freshness property is enforced
# only by GitHub's `strict` branch-protection flag, which pays for it by forcing
# a full ~34-runner-minute revalidation of EVERY open PR after EVERY merge —
# 25 of agentweb's 35 open PRs were BEHIND with 0 CLEAN when ENG-1003 was filed.
#
# So the property moves here, where it can be checked precisely and for free:
# a base that moved only matters if it moved a file this PR also touches.
# Overlap is the thing that can invalidate a green suite; everything else is
# GitHub being conservative because it cannot read a diff.
#
# This is strictly a TIGHTENING. Before this block the gate passed a PR whose
# tested merge base was hundreds of commits stale without comment.

GREEN_HEAD='321fbdd6f2b93d13d6216aa10b15747dad8bb64c'
GREEN_WF='[
  {"id":11,"name":"Tests","workflow_id":111,"run_number":5,"status":"completed","conclusion":"success","check_suite_id":100}
]'

# A PR that is green at its head, touching one non-backend file, in the given
# mergeStateStatus. Section 7 is not exercised (the file is not a backend path),
# so every verdict below is attributable to the staleness rule alone.
green_pr() {
  local dir="$1" merge_state="$2"
  pr_view "${dir}" 'MERGEABLE' false OPEN "${GREEN_HEAD}" "${merge_state}" 'main'
  checkruns "${dir}" "${COMPLETED_GREEN_RUN}"
  workflowruns "${dir}" "${GREEN_WF}"
  changed_files "${dir}" 'partner-portal/src/App.tsx'
}

# 1. The case the rule exists for: main moved a file this PR also edits, so the
#    green suite was run against a merge result that no longer exists.
d="$(new_fixture_dir)"
green_pr "${d}" 'BEHIND'
base_compare "${d}" 12 'partner-portal/src/App.tsx
backend/src/services/db.ts'
run_gate "${d}"
check 'ENG-1003: a stale base that moved a file this PR touches is NO_EVIDENCE' 3 'partner-portal/src/App.tsx'

# 2. The saving. The base moved, but nowhere near this PR's diff, so the tested
#    merge result is still the one that would land. This is the verdict that
#    makes turning `strict` off safe rather than reckless.
d="$(new_fixture_dir)"
green_pr "${d}" 'BEHIND'
base_compare "${d}" 12 'docs/README.md
customer-portal/src/Other.tsx'
run_gate "${d}"
check 'ENG-1003: a stale base with no overlapping file still PASSes' 0 'VERDICT: PASS'

d="$(new_fixture_dir)"
green_pr "${d}" 'BEHIND'
base_compare "${d}" 12 'docs/README.md'
run_gate "${d}"
check 'ENG-1003: the non-overlapping pass says the base moved and why it is safe' 0 'base has moved 12 commit'

# 3. Fail closed when the comparison itself cannot be read. A gate that cannot
#    see the base must not certify freshness.
d="$(new_fixture_dir)"
green_pr "${d}" 'BEHIND'
printf '7\n' >"${d}/compare_exit"
run_gate "${d}"
check 'ENG-1003: an unreadable base comparison is ERROR, never a pass' 4 'ERROR'

# 4. GitHub's compare endpoint caps `files` at 300. A truncated list cannot
#    prove the ABSENCE of an overlap, and this PR's files are deliberately
#    absent from it — so without the cap check this fixture would false-PASS.
d="$(new_fixture_dir)"
green_pr "${d}" 'BEHIND'
base_compare "${d}" 400 "$(seq 1 300 | sed 's|^|unrelated/f|; s|$|.ts|')"
run_gate "${d}"
check 'ENG-1003: a truncated base file list cannot prove no overlap, so NO_EVIDENCE' 3 'truncat'

# 5. The freshness check keys on `ahead_by`, never on the displayed merge
#    state: mergeStateStatus reports one dominant state, so a PR that is behind
#    AND awaiting a required review reads BLOCKED, not BEHIND. A gate that
#    trusted the label would false-PASS exactly this fixture.
d="$(new_fixture_dir)"
green_pr "${d}" 'BLOCKED'
base_compare "${d}" 12 'partner-portal/src/App.tsx'
run_gate "${d}"
check 'ENG-1003: a behind base hidden under BLOCKED still fails freshness' 3 'partner-portal/src/App.tsx'

# 5b. A genuinely current PR (compare says the base has not moved) passes, and
#     an unreadable comparison is now an ERROR for every PR, not only BEHIND
#     ones — the comparison is the evidence, so its absence fails closed.
d="$(new_fixture_dir)"
green_pr "${d}" 'CLEAN'
base_compare "${d}" 0 ''
run_gate "${d}"
check 'ENG-1003: a current base (ahead_by 0) still PASSes' 0 'VERDICT: PASS'

d="$(new_fixture_dir)"
green_pr "${d}" 'CLEAN'
printf '9\n' >"${d}/compare_exit"
run_gate "${d}"
check 'ENG-1003: an unreadable comparison fails closed even when the state reads CLEAN' 4 'ERROR'

# 6. Renames participate under both paths: the base renamed the file this PR
#    edits, so the overlap only exists via `previous_filename`. Filename-only
#    projection would false-PASS this.
d="$(new_fixture_dir)"
green_pr "${d}" 'BEHIND'
printf '%s\n' '{"ahead_by":3,"files":[{"filename":"partner-portal/src/AppRenamed.tsx","previous_filename":"partner-portal/src/App.tsx"}]}' >"${d}/compare.json"
run_gate "${d}"
check 'ENG-1003: a base rename of a file this PR edits is caught via previous_filename' 3 'partner-portal/src/App.tsx'

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

# ---------------------------------------------------------------------------
# Invariant guard — test execution stays DECOUPLED from the Greptile gate
# ---------------------------------------------------------------------------
#
# ENG-1039 reversed ENG-915's ordering: the Greptile check failed 61% of the
# time over 2026-08-01..10 and every failure skipped the backend suite (303
# skipped executions), destroying the run's test evidence and forcing a full
# ~31-min re-run. Test evidence must be produced independently of whether the
# reviewer check answered. The merge gate is unchanged — `greptile-review`
# remains required and fail-closed — but re-serializing the test jobs behind
# it is a regression. Assert the workflow here so the coupling cannot creep
# back in a PR that never opens this file.

GATE_SH="${SCRIPT_DIR}/merge-evidence.sh"

for job_key in backend-tests-a backend-tests-b; do
  # Collect the job's whole header (needs + the `>-` if block scalar) so a
  # dependency reintroduced in either field is caught.
  # Comment lines are dropped: they legitimately narrate the ENG-1039 history
  # and would otherwise trip the substring check below.
  JOB_HEADER="$(awk -v job="  ${job_key}:" '
    $0 == job            { in_job = 1; next }
    in_job && /^  [a-z]/ { exit }
    in_job && /^    steps:/ { exit }
    in_job && /^ *#/     { next }
    in_job               { print }
  ' "${WORKFLOW}" | tr '\n' ' ')"

  TESTS_RUN=$((TESTS_RUN + 1))
  if printf '%s' "${JOB_HEADER}" | grep -q "greptile"; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "FAIL  invariant: %s references greptile-review in needs/if.\n" "${job_key}"
    printf "      Found: '%s'\n" "${JOB_HEADER}"
    printf "      ENG-1039 decoupled test execution from the reviewer check: a 61%%-flaky\n"
    printf "      Greptile poll was deciding whether test evidence exists. Do not\n"
    printf "      re-serialize the suite behind it.\n"
  else
    printf "ok    invariant: %s runs independently of the Greptile gate (ENG-1039)\n" "${job_key}"
  fi

  # The suite must still be draft-gated and path-gated — decoupling from the
  # reviewer check must not turn into running on every draft push.
  TESTS_RUN=$((TESTS_RUN + 1))
  if printf '%s' "${JOB_HEADER}" | grep -qF "github.event.pull_request.draft == false" \
     && printf '%s' "${JOB_HEADER}" | grep -qF "needs.detect-changes.outputs.backend == 'true'"; then
    printf "ok    invariant: %s keeps the draft and backend-path gates\n" "${job_key}"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "FAIL  invariant: %s must keep the draft gate and backend path filter.\n" "${job_key}"
    printf "      Found: '%s'\n" "${JOB_HEADER}"
  fi
done

# The requirement is matched by exact job name. A rename in tests.yml alone
# would leave merge-evidence.sh demanding a job nobody reports — which fails
# closed, so it is safe, but it blocks every backend PR until someone finds
# this. Catch it in the PR that renames the job instead.
TESTS_RUN=$((TESTS_RUN + 1))
missing_name=''
while IFS= read -r job_name; do
  [ -n "${job_name}" ] || continue
  grep -qF "name: ${job_name}" "${WORKFLOW}" || missing_name="${job_name}"
done < <(sed -n '/^BACKEND_JOBS=/,/}"$/p' "${GATE_SH}" \
  | sed -e 's/^BACKEND_JOBS=.*:-//' -e 's/}"$//')

if [ -z "${missing_name}" ]; then
  printf "ok    invariant: every MERGE_EVIDENCE_BACKEND_JOBS default names a real job in tests.yml\n"
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf "FAIL  invariant: merge-evidence.sh requires the job '%s', which tests.yml does not define.\n" "${missing_name}"
  printf "      Rename both together, or the backend-suite requirement blocks every backend PR.\n"
fi

# BACKEND_PATHS hand-mirrors the `backend` filter in tests.yml, and the two
# drift in one direction silently: adding a path to the workflow filter widens
# what the suite runs on, while the requirement here keeps applying to the old,
# narrower set. The result is a file that triggers the backend suite but is not
# required to have run it — the exact hole this section closes, reopened. Only
# the reverse (a path here that the filter dropped) is loud, because it demands
# a suite that never runs.
TESTS_RUN=$((TESTS_RUN + 1))
# `backend/**` in the filter is the prefix `backend/` here; quotes and the glob
# suffix are normalised away so the two are compared as the same kind of thing.
filter_paths="$(awk '
  /^            backend:$/ { in_filter = 1; next }
  in_filter && /^            [a-z]+:$/ { exit }
  in_filter && /^              - / {
    sub(/^              - /, ""); gsub(/'"'"'/, ""); sub(/\*\*$/, ""); print
  }
' "${WORKFLOW}" | sort)"
gate_paths="$(sed -n "/^BACKEND_PATHS='/,/'$/p" "${GATE_SH}" \
  | sed -e "s/^BACKEND_PATHS='//" -e "s/'$//" | sort)"

if [ "${filter_paths}" = "${gate_paths}" ]; then
  printf "ok    invariant: BACKEND_PATHS mirrors the workflow's backend paths filter\n"
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf "FAIL  invariant: BACKEND_PATHS has drifted from the backend filter in tests.yml.\n"
  printf "      tests.yml: %s\n" "$(printf '%s' "${filter_paths}" | tr '\n' ' ')"
  printf "      this gate: %s\n" "$(printf '%s' "${gate_paths}" | tr '\n' ' ')"
  printf "      A path the filter has and this gate does not is a file that triggers the\n"
  printf "      backend suite without being required to have run it.\n"
fi

# Two jobs sharing a per-PR concurrency group cancel each other, which is the
# problem ENG-915 design wrinkle 4 warns must not come back: the reorder means
# `greptile-review` now decides whether the suite runs at all, so a group
# collision involving it would silently cancel the tests rather than merely
# delay them. Distinct groups are what let these jobs run in the same workflow
# without racing, so assert every group is unique.
TESTS_RUN=$((TESTS_RUN + 1))
dupe_group="$(grep '^      group:' "${WORKFLOW}" | sort | uniq -d)"
if [ -z "${dupe_group}" ]; then
  printf "ok    invariant: every job's concurrency group is unique (ENG-915 AC5)\n"
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf "FAIL  invariant: two jobs share a concurrency group, so they will cancel each other:\n"
  printf "      %s\n" "${dupe_group}"
fi

printf '\n%s tests, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ]
