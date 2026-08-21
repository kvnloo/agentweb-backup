#!/usr/bin/env bash
#
# Prove that CI actually ran against a pull request's CURRENT head (ENG-757).
#
# Why this exists
# ---------------
# On 2026-07-29 agentweb#2221 spent ~30 minutes presenting as "checks passing"
# while no check could run against it at all. The sequence:
#
#   1. #2220 merged to main, creating a dev.md conflict on #2221.
#   2. GitHub cannot build refs/pull/N/merge for a conflicted PR. With no
#      mergeable ref, neither `ready_for_review` nor `synchronize` can schedule
#      a workflow run.
#   3. The PR's check display kept showing the stale draft-time run, in which
#      every draft-gated job is `skipped` and the rollup reads green.
#
# The load-bearing detail that defeats the obvious fix
# ----------------------------------------------------
# The conflict was created by the BASE moving, so the PR's head SHA never
# changed. The misleading draft run was therefore *at the current head SHA*.
# Binding evidence to the head SHA — the natural first instinct — would have
# confirmed the false green rather than caught it. Verified against live data
# on 2026-07-31: agentweb#2231, a draft PR, returns six `skipped` check-runs
# and one `success` at its head, and `gh pr checks 2231` exits 0.
#
# So the fix is not a better staleness check. It is inverting the question.
#
#   `gh pr checks` answers "did anything fail?" — and skipped is not failed,
#   so an all-skipped run is green. This gate instead answers "did anything
#   actually execute against this exact head?" and requires a positive answer.
#
# Absence of failure is not evidence of success. Under that inversion every
# variant of the bug collapses into one rule: a conflicted PR, a PR with no
# run, a draft-time run, and an unreadable payload all fail to produce
# execution proof, so none of them can be green. There is no path from "I
# measured nothing" to a pass.
#
# Superseded runs: why the evidence is scoped to a run, not deduped by name
# -------------------------------------------------------------------------
# `commits/{sha}/check-runs` is a FLATTENED UNION of every run ever scheduled at
# that SHA. A push followed by a ready-flip leaves the superseded run's rows
# beside the live run's under IDENTICAL job names.
#
# This gate's own PR hit it (agentweb#2231, captured verbatim in the tests):
# pushed, flipped ready 13s later, `cancel-in-progress` killed run 4936 while
# run 4937 carried the real result. Both suites came back, so the discriminator
# job appeared twice — success from 4937, skipped from 4936 — the
# discriminator read the superseded `skipped`, and the gate returned NO_EVIDENCE
# for a fully green PR. A gate that rejects legitimate PRs gets switched off
# within a week, so that false negative is as disqualifying as a false positive.
#
# The narrowing is deliberately NOT a dedupe-by-name over the flat list. See the
# two-pass note in section 3: name-based dedupe infers recency from suite id and
# will silently drop a real failure when two different workflows share a job
# name. Supersession is read from the workflow-run API instead, so a superseded
# run is structurally unable to reach the verdict, and everything else survives.
#
# Telling a draft skip from a legitimate path-filter skip (criterion 5)
# ---------------------------------------------------------------------
# `.github/workflows/tests.yml` gates the backend jobs on
# `backend == 'true' && draft == false`, collapsing both reasons into one
# `if`, so both render identically as `conclusion: skipped`. One job
# disambiguates them: `Detect changed projects` is gated on `draft == false`
# ALONE, with no path filter. Therefore:
#
# ENG-1371: this used to be `Require Greptile Review`, which had the same
# shape — draft-gated, never path-filtered. When Greptile was dropped as a
# vendor that job was deleted, and because the discriminator is matched by
# exact name and FAILS CLOSED on absence, leaving the old default would have
# turned every PR into NO_EVIDENCE. `Detect changed projects` was verified as
# an exact substitute before the switch: both discriminators were run against
# all 18 open agentweb PRs and returned identical verdicts on 18/18.
#
# Whatever this points at must be gated on the draft flag and NOTHING else. A
# job with a path filter would report `skipped` on a perfectly real run, which
# this gate would then read as a draft-time run and reject.
#
#   discriminator skipped  -> this was a draft-time run; every draft-gated
#                             job skipped for that reason. Not evidence.
#   discriminator executed -> the run is real, and each remaining skip is
#                             resolved by the rule below.
#
# The discriminator is matched by exact name and its absence fails closed, so
# renaming that job degrades to "no evidence" rather than silently removing
# the gate's ability to recognise a draft run.
#
# Why an executed discriminator is no longer enough on its own (ENG-915)
# ----------------------------------------------------------------------
# ENG-915 additionally gated the backend test jobs on the reviewer check, so
# their `skipped` carried a third possible meaning: the gate did not pass.
# ENG-1039 removed that coupling and ENG-1371 deleted the gate, but the rule
# below is KEPT — it never depended on that gate existing, and it is what makes
# a path-filter skip provable rather than inferred.
# That defeats every attempt to infer the reason from the payload. Suite ids
# do not separate the cases either — `re-run failed jobs` appends the new
# results to the SAME suite, so a re-run in which only the gate turned green
# leaves the stale skip beside it, and nothing in the response says which came
# first.
#
# So the reason is not inferred at all. The gate instead demands proof, the
# same way it already refuses to read "nothing failed" as a pass: if the PR's
# own diff touches the backend paths, the backend test jobs must carry a
# `success` at this head. Anything else — skipped, absent, cancelled — is
# NO_EVIDENCE. The diff is read from `pulls/{n}/files`, which is the same
# input `dorny/paths-filter` decides on, and the path list below mirrors the
# `backend` filter in tests.yml. This is ENG-915 acceptance criterion 4: a
# gate may reorder work, but it must not reduce merge evidence.
#
# Why a CLI and not a CI job
# --------------------------
# A check-run cannot report on the absence of check-runs, and the conflicted
# PR that needs reporting on is precisely the one that cannot schedule the job
# that would do the reporting. The control has to sit outside the substrate it
# measures. Criterion 4 names the consumer directly: an agent, using `gh`
# output alone, without opening the web UI.
#
# Usage:
#   REPO=AgentWebPro/agentweb PR_NUMBER=2231 bash .github/scripts/merge-evidence.sh
#
# Exit codes (each is separately actionable for a calling agent):
#   0  PASS         a real run executed against this head and nothing failed
#   1  FAIL         a check actually ran and returned a negative verdict.
#                   NOT a cancellation outside the evidence set — that is an
#                   absent verdict, not a negative one (ENG-1381)
#   2  PENDING      still in flight, or GitHub is still computing mergeability
#   3  NO_EVIDENCE  nothing has ever executed against this head — the ENG-757
#                   class. Distinct from FAIL because the remedy differs:
#                   resolve the conflict / flip ready / push, do not debug.
#   4  ERROR        the evidence surface itself is unreadable. Never a pass.
#
# Environment:
#   REPO                        owner/repo
#   PR_NUMBER                   pull request number
#   GH_TOKEN                    token for `gh`
#   MERGE_EVIDENCE_DRAFT_JOB    discriminator job name
#                               (default "Detect changed projects")
#   MERGE_EVIDENCE_BACKEND_JOBS US-separated job names that must carry a
#                               `success` when the diff touches the backend
#                               paths (ENG-915)

set -uo pipefail

REPO="${REPO:?REPO must be set}"
PR_NUMBER="${PR_NUMBER:?PR_NUMBER must be set}"
DRAFT_JOB="${MERGE_EVIDENCE_DRAFT_JOB:-Detect changed projects}"

# Mirrors the `backend` filter in .github/workflows/tests.yml, including the two
# CI-path entries that filter counts as backend changes (ENG-743). A prefix here
# matches a changed file that starts with it, so `backend/` covers the tree.
BACKEND_PATHS='backend/
.github/workflows/tests.yml
.github/scripts/eb-deploy.sh'

# The jobs that must prove they ran when those paths are touched. Newline
# separated; names are matched exactly, and a name that never appears in the
# payload is treated as "did not run" rather than ignored, so a rename fails
# closed instead of quietly deleting the requirement.
BACKEND_JOBS="${MERGE_EVIDENCE_BACKEND_JOBS:-Backend tests (agentMode)
Backend tests (all other + coverage)}"

log() { printf 'merge-evidence: %s\n' "$*"; }

# Fields are joined on US (0x1f), never on tab. `read` treats tab as IFS
# whitespace and collapses runs of it, so a payload with two empty fields in a
# row would silently shift every later field left — which is how a reason string
# ends up describing the wrong jobs. US is not whitespace, so empty fields
# survive. Nothing in a job name or conclusion can contain it.
SEP=$'\x1f'

surface() {
  printf '::group::%s\n%s\n::endgroup::\n' "$1" "$2"
}

# A hard error is not a verdict about the PR — it is the gate saying it cannot
# see. It must never be confused with a pass, so it gets its own exit code.
hard_fail() {
  printf '::error::merge-evidence: %s\n' "$1" >&2
  printf 'VERDICT: ERROR\n'
  exit 4
}

verdict() {
  printf 'VERDICT: %s\n' "$1"
  printf 'REASON: %s\n' "$2"
}

stderr_file="$(mktemp)"
trap 'rm -f "${stderr_file}"' EXIT

# ---------------------------------------------------------------------------
# 1. The pull request itself
# ---------------------------------------------------------------------------

pr_json="$(gh pr view "${PR_NUMBER}" --repo "${REPO}" \
  --json number,state,isDraft,mergeable,headRefOid,baseRefName \
  2>"${stderr_file}")"
gh_exit=$?

if [ "${gh_exit}" -ne 0 ]; then
  hard_fail "GitHub API call failed (exit ${gh_exit}) reading ${REPO}#${PR_NUMBER}: $(tr '\n' ' ' <"${stderr_file}")"
fi

# ENG-1003: the freshness compare in section 8 now runs unconditionally, so
# mergeStateStatus is no longer fetched — GitHub reports only one dominant
# state and gating on BEHIND missed PRs that were behind AND something else.
parsed="$(printf '%s' "${pr_json}" | jq -r '
    [ (.state // ""), (.isDraft | tostring), (.mergeable // ""), (.headRefOid // ""),
      (.baseRefName // "") ]
    | join("\u001f")' 2>/dev/null)"
jq_exit=$?

if [ "${jq_exit}" -ne 0 ] || [ -z "${parsed}" ]; then
  surface 'gh pr view response (raw)' "${pr_json}"
  hard_fail "unparseable response from \`gh pr view ${PR_NUMBER}\` — expected a JSON object with state/isDraft/mergeable/headRefOid"
fi

IFS="${SEP}" read -r pr_state pr_draft pr_mergeable head_sha base_ref <<<"${parsed}"

if [ -z "${pr_state}" ] || [ -z "${pr_mergeable}" ]; then
  surface 'gh pr view response (raw)' "${pr_json}"
  hard_fail "unparseable response from \`gh pr view ${PR_NUMBER}\` — state and/or mergeable is missing, so the PR's schedulability cannot be established"
fi

head_sha="$(printf '%s' "${head_sha}" | tr '[:upper:]' '[:lower:]')"
if ! grep -qE '^[0-9a-f]{40}$' <<<"${head_sha}"; then
  surface 'gh pr view response (raw)' "${pr_json}"
  hard_fail "unparseable head SHA for ${REPO}#${PR_NUMBER}: '${head_sha}'. Every check result below is keyed on this SHA, so a bad value would silently evaluate the wrong commit."
fi

log "evaluating ${REPO}#${PR_NUMBER} at head ${head_sha}"

# A closed or merged PR has no live merge evidence to give.
if [ "${pr_state}" != "OPEN" ]; then
  verdict 'NO_EVIDENCE' "${REPO}#${PR_NUMBER} is ${pr_state}, not OPEN — there is no current merge evidence to evaluate."
  exit 3
fi

# Draft PRs do not run the draft-gated jobs at all, by design. Saying so plainly
# is the whole point: the old surface said "passing".
if [ "${pr_draft}" = "true" ]; then
  verdict 'NO_EVIDENCE' "${REPO}#${PR_NUMBER} is a draft. The draft-gated jobs (backend tests, '${DRAFT_JOB}', staging deploy) do not run on drafts, so no run at this head is merge evidence. Flip it ready to schedule a real run."
  exit 3
fi

case "${pr_mergeable}" in
  CONFLICTING)
    # Acceptance criterion 1. This is the ENG-757 state.
    verdict 'NO_EVIDENCE' "${REPO}#${PR_NUMBER} is CONFLICTING, so GitHub cannot build its refs/pull/${PR_NUMBER}/merge ref. No workflow run can be scheduled against this head, and any green shown on the PR is from a run that predates the conflict. Resolve the conflict to let CI start."
    exit 3
    ;;
  UNKNOWN)
    # GitHub computes mergeability asynchronously. Until it lands we cannot
    # rule out the conflicted case, so we must not report a pass.
    verdict 'PENDING' "GitHub has not finished computing mergeability for ${REPO}#${PR_NUMBER} (mergeable=UNKNOWN). Re-run in a few seconds; a conflict cannot be ruled out yet."
    exit 2
    ;;
  MERGEABLE) ;;
  *)
    hard_fail "unrecognised mergeable state '${pr_mergeable}' for ${REPO}#${PR_NUMBER}. Refusing to guess whether this PR can schedule a run."
    ;;
esac

# ---------------------------------------------------------------------------
# 2. Which check suites at this head belong to a SUPERSEDED workflow run
# ---------------------------------------------------------------------------
#
# Read before the check-runs so the flattened union can be narrowed at the
# source. A suite qualifies only if its run was cancelled AND a newer run of the
# same workflow exists — see the long note in section 3 for why ordering alone
# is not good enough.

wfruns_json="$(gh api "repos/${REPO}/actions/runs?head_sha=${head_sha}&per_page=100" \
  2>"${stderr_file}")"
gh_exit=$?

if [ "${gh_exit}" -ne 0 ]; then
  hard_fail "GitHub API call failed (exit ${gh_exit}) reading workflow runs for ${head_sha}: $(tr '\n' ' ' <"${stderr_file}"). Without them a superseded run cannot be told from the live one, so this is not evaluated."
fi

wf_counts="$(printf '%s' "${wfruns_json}" | jq -r '
    [ (.total_count // -1), (.workflow_runs | length) ]
    | map(tostring) | join("\u001f")' 2>/dev/null)"
jq_exit=$?

if [ "${jq_exit}" -ne 0 ] || [ -z "${wf_counts}" ]; then
  surface 'workflow-runs response (raw)' "${wfruns_json}"
  hard_fail "unparseable response from repos/${REPO}/actions/runs?head_sha=${head_sha} — expected a JSON object with total_count and workflow_runs"
fi

IFS="${SEP}" read -r wf_total wf_returned <<<"${wf_counts}"

if [ "${wf_total}" = "-1" ]; then
  surface 'workflow-runs response (raw)' "${wfruns_json}"
  hard_fail "workflow-runs response for ${head_sha} carries no total_count, so page completeness cannot be verified"
fi

# A hidden run could be the newer one that supersedes a poison suite. Missing it
# silently resurrects the false negative, so refuse rather than guess.
if [ "${wf_returned}" -lt "${wf_total}" ]; then
  hard_fail "workflow-runs response for ${head_sha} is truncated: total_count=${wf_total} but only ${wf_returned} returned. A hidden run could be the one that supersedes another, so this is not evaluated."
fi

# A workflow run is created before its first check-run row. During that window
# the commit endpoint can still contain a fully green older run and nothing from
# the new one, which would otherwise produce PASS while GitHub has work queued.
# The workflow-run endpoint is therefore evidence not only for supersession but
# also for pending state. Any non-completed run at this head blocks until its
# check rows and final conclusion exist.
wf_pending_info="$(printf '%s' "${wfruns_json}" | jq -r '
    [ ([ .workflow_runs[] | select(.status != "completed") ] | length),
      ([ .workflow_runs[] | select(.status != "completed")
         | "\(.name // "workflow") (run \(.id // "unknown"): \(.status // "unknown"))" ]
       | join(", ")) ]
    | map(tostring) | join("\u001f")' 2>/dev/null)"
jq_exit=$?

if [ "${jq_exit}" -ne 0 ] || [ -z "${wf_pending_info}" ]; then
  surface 'workflow-runs response (raw)' "${wfruns_json}"
  hard_fail "unparseable workflow-runs payload while classifying pending runs at ${head_sha}"
fi

IFS="${SEP}" read -r n_wf_pending wf_pending_names <<<"${wf_pending_info}"

if [ "${n_wf_pending}" -gt 0 ]; then
  verdict 'PENDING' "${n_wf_pending} workflow run(s) at head ${head_sha} have not completed: ${wf_pending_names}. A run can exist before its first check-run row, so older green rows are not current evidence yet."
  exit 2
fi

superseded_suites="$(printf '%s' "${wfruns_json}" | jq -c '
    [ .workflow_runs[] as $r
      | select($r.conclusion == "cancelled")
      | select($r.check_suite_id != null)
      | select([ .workflow_runs[]
                 | select(.workflow_id == $r.workflow_id)
                 | select(.run_number > $r.run_number) ] | length > 0)
      | $r.check_suite_id ]
    | unique' 2>/dev/null)"
jq_exit=$?

if [ "${jq_exit}" -ne 0 ] || [ -z "${superseded_suites}" ]; then
  surface 'workflow-runs response (raw)' "${wfruns_json}"
  hard_fail "unparseable workflow-runs payload while identifying superseded check suites at ${head_sha}"
fi

# ---------------------------------------------------------------------------
# 3. Check runs, keyed on this exact head SHA
# ---------------------------------------------------------------------------
#
# The endpoint is inherently SHA-scoped, which is what makes a result from a
# superseded commit invisible here rather than merely old. `--paginate` is
# deliberately NOT used: this endpoint returns an object envelope, not a
# top-level array, so paginating emits several concatenated JSON objects and
# breaks the parse. Instead we take one page of 100 and verify against
# total_count, because a silently truncated page could hide the one job that
# failed.

runs_json="$(gh api "repos/${REPO}/commits/${head_sha}/check-runs?per_page=100" \
  2>"${stderr_file}")"
gh_exit=$?

if [ "${gh_exit}" -ne 0 ]; then
  hard_fail "GitHub API call failed (exit ${gh_exit}) reading check-runs for ${head_sha}: $(tr '\n' ' ' <"${stderr_file}")"
fi

counts="$(printf '%s' "${runs_json}" | jq -r '
    [ (.total_count // -1), (.check_runs | length) ]
    | map(tostring) | join("\u001f")' 2>/dev/null)"
jq_exit=$?

if [ "${jq_exit}" -ne 0 ] || [ -z "${counts}" ]; then
  surface 'check-runs response (raw)' "${runs_json}"
  hard_fail "unparseable response from repos/${REPO}/commits/${head_sha}/check-runs — expected a JSON object with total_count and check_runs"
fi

IFS="${SEP}" read -r total_count returned_count <<<"${counts}"

if [ "${total_count}" = "-1" ]; then
  surface 'check-runs response (raw)' "${runs_json}"
  hard_fail "check-runs response for ${head_sha} carries no total_count, so page completeness cannot be verified"
fi

if [ "${returned_count}" -lt "${total_count}" ]; then
  hard_fail "check-runs response for ${head_sha} is truncated: total_count=${total_count} but only ${returned_count} returned. A hidden job could be the failing one, so this is not evaluated."
fi

# Acceptance criterion 4: the state the old surface could not express.
if [ "${returned_count}" -eq 0 ]; then
  verdict 'NO_EVIDENCE' "no check has ever run against head ${head_sha} of ${REPO}#${PR_NUMBER}. This is not a pass with nothing to report — it is the absence of any measurement."
  exit 3
fi

# The commit endpoint is a history surface, not the same rollup GitHub renders
# on the PR. Two pull_request events can race at one head (for example,
# ready_for_review and synchronize). Workflow concurrency cancels the older
# suite, but both suites remain in check_runs forever. Treating the response as
# one flat verdict then lets the superseded cancellation or its skipped draft
# discriminator poison the successful replacement.
#
# Narrowing happens in two passes, and the split is load-bearing.
#
# Pass 1 — DROP SUPERSEDED SUITES, proven from the workflow-run API.
# The tempting shortcut is to dedupe by check context (App + name) and keep the
# highest suite id. That is a recency *guess*, and it silently discards a
# genuine failure whenever two DIFFERENT workflows at one head share a job name:
# the older workflow's `failure` loses the group to the newer workflow's
# `success` and the gate reports PASS. Measured on a fixture during this fix —
# it is the one direction a merge-evidence gate must never fail in, and it is
# pinned by a test below. So supersession is never inferred from ordering; it is
# read from `actions/runs?head_sha=`, and only when BOTH hold:
#
#   1. the run's own conclusion is `cancelled` — it produced no verdict of its
#      own, so nothing is thrown away by ignoring it; AND
#   2. a strictly newer run of the SAME workflow_id exists at this head.
#
# Anything the API does not positively prove superseded stays in and can still
# block. With no workflow-run data nothing is dropped.
if [ "${superseded_suites}" != "[]" ]; then
  runs_json="$(printf '%s' "${runs_json}" | jq -c \
    --argjson superseded "${superseded_suites}" '
      .check_runs |= map(
        select( (.check_suite.id // null) as $id
                | $id == null or (($superseded | index($id)) == null) ) )' 2>/dev/null)"
  jq_exit=$?

  if [ "${jq_exit}" -ne 0 ] || [ -z "${runs_json}" ]; then
    surface 'check-runs response (raw)' "${runs_json}"
    hard_fail "failed to exclude superseded check suites ${superseded_suites} from the check-runs payload at ${head_sha}"
  fi
fi

# Kept for the backend-suite requirement in section 7, which asks a different
# question from the rest of the gate: not "what is the latest state of this
# job" but "did this job ever pass against this head". Both passes above are
# about currency, and currency is the wrong lens for that one question,
# because the head SHA is immutable — a green suite at this SHA tested exactly
# this code and cannot be un-tested by a later run choosing to skip it.
runs_after_supersession="${runs_json}"

# Pass 2 — WITHIN a surviving suite, keep the newest run per context.
# Re-running a job adds a new check-run beside the old one under the same name
# in the same suite, so without this a re-run that fixed a failure would still
# read as failing. This is safe precisely because it never crosses a suite
# boundary: two check-runs with one name inside one suite ARE the same job, so
# the higher id is authoritative rather than merely newer.
runs_json="$(printf '%s' "${runs_json}" | jq -c '
    .check_runs |= (
      group_by([(.app.id // .app.slug // "unknown" | tostring),
                (.check_suite.id // 0 | tostring),
                .name])
      | map(max_by(.id // 0))
    )' 2>/dev/null)"
jq_exit=$?

if [ "${jq_exit}" -ne 0 ] || [ -z "${runs_json}" ]; then
  hard_fail "unparseable check-runs payload while selecting the latest result for each check context at ${head_sha}"
fi

effective_count="$(printf '%s' "${runs_json}" | jq -r '.check_runs | length' 2>/dev/null)"
if ! grep -qE '^[0-9]+$' <<<"${effective_count}"; then
  hard_fail "check-runs payload became unreadable after narrowing to effective runs at ${head_sha}"
fi

runs_json="$(printf '%s' "${runs_json}" | jq -c --argjson n "${effective_count}" \
  '.total_count = $n' 2>/dev/null)"
superseded_count=$((returned_count - effective_count))
returned_count="${effective_count}"

if [ "${superseded_count}" -gt 0 ]; then
  log "ignored ${superseded_count} superseded check-run(s): suites proven cancelled-and-re-run ${superseded_suites}, then the latest run per check context"
fi

# Every surviving row was dropped as superseded — nothing executed here.
if [ "${returned_count}" -eq 0 ]; then
  verdict 'NO_EVIDENCE' "every check-run at head ${head_sha} of ${REPO}#${PR_NUMBER} belonged to a superseded workflow run. Nothing was actually measured against this head."
  exit 3
fi

# ---------------------------------------------------------------------------
# 4. Classify every check-run at this head
# ---------------------------------------------------------------------------
#
# Computed before the draft check because the draft verdict needs to know
# whether a run is currently executing — see the note in section 4.

# The classification is EXHAUSTIVE: every completed check-run lands in exactly
# one of success / skipped / bad / unclassified. That last bucket is the point.
#
# The first version had `bad` as a fixed list and simply ignored anything not in
# it, so a `neutral` check sitting beside one success produced PASS with the
# neutral silently dropped (caught in review on this PR). That is the exact
# defect this script exists to eliminate: a conclusion the control cannot
# account for, omitted, yielding a green.
#
# Adding "neutral" to the list would fix that one value and leave the shape
# intact for the next conclusion GitHub introduces. Instead anything outside the
# known sets is counted, named, and blocks. Unknown is not benign.
#
# ENG-1381: `cancelled` is deliberately NOT in `bad`, and this is the one
# entry whose absence is a decision rather than an oversight.
#
# A failure is a negative verdict. A cancellation is the ABSENCE of a verdict —
# the job was killed before it could produce one. Those are different facts, and
# this script already knows it: the supersession rule in section 2 ignores
# cancelled runs on exactly that reasoning ("it produced no verdict of its own,
# so nothing is thrown away by ignoring it"). Counting the same conclusion as a
# failure here contradicted that.
#
# The cost of the contradiction was measured, not theorised. `Backend deploy to
# staging` holds a single GLOBAL concurrency lane; a newer waiting request
# evicts the older, so with several backend PRs open almost none of them obtains
# a completed deploy. 37% of staging-deploy executions were cancelled over the
# 20h sampled for ENG-1381. Every one of those PRs got FAIL from the gate that
# CLAUDE.md and AGENTS.md name as the merge criterion — including agentweb#2491,
# where the override had to be taken on the PR that keeps this script working.
# The header calls that disqualifying: "a gate that rejects legitimate PRs gets
# switched off within a week".
#
# What stops this from being a loosening is that the gate never relied on `bad`
# to catch a missing measurement in the first place. It demands a POSITIVE
# `success` from the jobs whose evidence it requires, and does so by name:
# section 5 for the discriminator (a cancelled one is caught explicitly below)
# and section 7 for MERGE_EVIDENCE_BACKEND_JOBS, which already reports a
# cancelled backend job as NO_EVIDENCE and was simply never reached while
# `n_bad` exited first. Section 6's `n_success -eq 0` backstops a wholly
# cancelled run. A cancellation outside that set is what it says it is: no
# verdict, from a job no verdict was required of.
#
# Known limitation, stated rather than discovered later: a job killed by its own
# `timeout-minutes` also reports `cancelled`, not `timed_out` (verified on #2491
# — "EB resource/instance config conflict" died at 4m59s against a 5-minute
# ceiling). Eviction and self-timeout are not distinguishable from any
# structured API field, only from a log annotation. So a self-timeout outside
# the evidence set no longer blocks either. That is accepted deliberately, and
# paid for by naming every tolerated cancellation in the PASS output below — a
# silent tolerance is how a gate stops working without anyone noticing.
classified="$(printf '%s' "${runs_json}" | jq -r \
    --arg draft "${DRAFT_JOB}" --arg backend "${BACKEND_JOBS}" '
    def bad: ["failure","neutral","timed_out","action_required","stale"];
    # The jobs this gate can require a positive success from, so a cancelled
    # ATTEMPT of one is described accurately rather than lumped in with the
    # cancellations nothing was ever required from.
    #
    # Membership is tested with `index`, never `inside`/`contains`: for strings
    # those match on SUBSTRING, so a job named "Backend tests" would be counted
    # as a member because "Backend tests (agentMode)" contains it. Every other
    # set membership in this script is exact so that a rename fails closed
    # rather than being absorbed by a partial match, and this is no different.
    def evset: [$draft] + ($backend | split("\n") | map(select(length > 0)));
    def known: bad + ["success","skipped","cancelled"];
    def done_: select(.status == "completed");
    def unknown_: done_ | select(.conclusion as $c | known | index($c) | not);
    [ ([ .check_runs[] | select(.status != "completed") ] | length),
      ([ .check_runs[] | done_ | select(.conclusion as $c | bad | index($c)) ] | length),
      ([ .check_runs[] | select(.conclusion == "success") ] | length),
      ([ .check_runs[] | unknown_ ] | length),
      ([ .check_runs[] | done_ | select(.conclusion == "cancelled") ] | length),
      ([ .check_runs[] | select(.status != "completed") | .name ] | join(", ")),
      ([ .check_runs[] | done_ | select(.conclusion as $c | bad | index($c)) | "\(.name) (\(.conclusion))" ] | join(", ")),
      ([ .check_runs[] | select(.conclusion == "skipped") | .name ] | join(", ")),
      ([ .check_runs[] | select(.conclusion == "success") | .name ] | join(", ")),
      ([ .check_runs[] | unknown_ | "\(.name) (\(.conclusion // "null"))" ] | join(", ")),
      ([ .check_runs[] | done_ | select(.conclusion == "cancelled")
         | select(.name as $n | evset | index($n) == null)
         | "\(.name) (\(.conclusion))" ] | join(", ")),
      ([ .check_runs[] | done_ | select(.conclusion == "cancelled")
         | select(.name as $n | evset | index($n) != null)
         | "\(.name) (\(.conclusion))" ] | join(", "))
    ] | map(tostring) | join("\u001f")' 2>/dev/null)"
jq_exit=$?

if [ "${jq_exit}" -ne 0 ] || [ -z "${classified}" ]; then
  surface 'check-runs response (raw)' "${runs_json}"
  hard_fail "unparseable check-runs payload while classifying job conclusions at ${head_sha}"
fi

IFS="${SEP}" read -r n_pending n_bad n_success n_unknown n_cancelled \
  pending_names bad_names skipped_names success_names unknown_names \
  cancelled_outside cancelled_inset <<<"${classified}"

# ---------------------------------------------------------------------------
# 5. Was this a draft-time run?
# ---------------------------------------------------------------------------
#
# A ready-flip creates a window where the check-runs at this head are a MIX: the
# new run's early jobs are in flight, while the draft run's `skipped` results are
# still the latest entry for every job the new run has not reached yet. The
# discriminator therefore reads `skipped` from the OLD run while a real one is
# genuinely starting. Reporting NO_EVIDENCE there is safe but wrong in its
# reasoning — it would send an agent hunting for a conflict that does not exist.
# Observed live on this PR immediately after its own ready-flip. When something
# is executing, the honest answer is PENDING; neither is a pass, so the ENG-757
# guarantee is untouched.

# Picked by highest suite id rather than array position. A draft run that
# COMPLETED (rather than being cancelled) is not superseded by rule 1, so both
# its suite and the real run's can legitimately survive to here — and relying on
# incidental array order to break that tie is the same mistake that produced
# this bug in the first place. Ties (no suite id, as in the older fixtures)
# resolve to the last element, matching the previous behaviour exactly.
discriminator="$(printf '%s' "${runs_json}" | jq -r --arg job "${DRAFT_JOB}" '
    [ .check_runs[] | select(.name == $job) ]
    | max_by(.check_suite.id // 0)
    | if . == null then "ABSENT" else (.conclusion // "pending") end' 2>/dev/null)"
jq_exit=$?

if [ "${jq_exit}" -ne 0 ] || [ -z "${discriminator}" ]; then
  surface 'check-runs response (raw)' "${runs_json}"
  hard_fail "unparseable check-runs payload while looking for the draft discriminator '${DRAFT_JOB}'"
fi

if [ "${discriminator}" = "ABSENT" ]; then
  if [ "${n_pending}" -gt 0 ]; then
    verdict 'PENDING' "'${DRAFT_JOB}' has not reported at head ${head_sha} yet, but a run is executing (${pending_names}). Re-run once it settles."
    exit 2
  fi
  verdict 'NO_EVIDENCE' "the draft discriminator job '${DRAFT_JOB}' is not present among the ${returned_count} check-runs at ${head_sha}, and nothing is currently executing. Without it a draft-time run cannot be told apart from a real one, so this gate fails closed. If that job was renamed, set MERGE_EVIDENCE_DRAFT_JOB."
  exit 3
fi

if [ "${discriminator}" = "skipped" ]; then
  if [ "${n_pending}" -gt 0 ]; then
    # The ready-flip window: the skipped result is the previous run's, and a
    # real one is already executing. Still not a pass — but it is pending, not
    # evidence-less, and saying so stops an agent hunting a phantom conflict.
    verdict 'PENDING' "'${DRAFT_JOB}' is skipped at head ${head_sha} from a previous draft-time run, but a real run is executing now (${pending_names}). Re-run once it settles."
    exit 2
  fi
  # Acceptance criterion 3. The exact ENG-757 shape: the PR is ready and
  # mergeable, nothing is executing, and the only run at its head is the stale
  # draft-time one.
  verdict 'NO_EVIDENCE' "the only run at head ${head_sha} is a draft-time run: '${DRAFT_JOB}' is skipped, that job is gated on draft state alone, so every draft-gated job skipped for the same reason, and nothing is executing now. Nothing was actually tested. A ready-flip normally schedules a real run — if it has not, the PR is likely conflicted or the run was cancelled."
  exit 3
fi

# ENG-1381 AC3. Cancellation is tolerated below for jobs no evidence was
# required from — but the discriminator is not one of those. It is the job every
# other conclusion is interpreted against: without it a draft-time run cannot be
# told from a real one, which is the whole ENG-757 shape. Absent gets its own
# verdict above for the same reason; cancelled is the same absence arriving by a
# different route, so it fails closed identically rather than falling through to
# the tolerant path.
if [ "${discriminator}" = "cancelled" ]; then
  if [ "${n_pending}" -gt 0 ]; then
    verdict 'PENDING' "'${DRAFT_JOB}' was cancelled at head ${head_sha}, but a run is executing now (${pending_names}). Re-run once it settles."
    exit 2
  fi
  verdict 'NO_EVIDENCE' "the draft discriminator '${DRAFT_JOB}' was CANCELLED at head ${head_sha}, so it produced no verdict. Without it a draft-time run cannot be told apart from a real one, and every other conclusion here is uninterpretable. This gate fails closed rather than guess. Re-run the workflow at this head."
  exit 3
fi

# ---------------------------------------------------------------------------
# 6. Ordinary reporting, now that the run is known to be real
# ---------------------------------------------------------------------------

if [ "${n_bad}" -gt 0 ]; then
  verdict 'FAIL' "${n_bad} check(s) failed against head ${head_sha}: ${bad_names}"
  exit 1
fi

# A conclusion this script does not recognise cannot be reasoned about, so it
# blocks rather than being dropped. Reported separately from FAIL because the
# remedy is different: teach the classifier what the value means.
if [ "${n_unknown}" -gt 0 ]; then
  verdict 'FAIL' "${n_unknown} check(s) at head ${head_sha} completed with a conclusion this gate does not recognise: ${unknown_names}. Refusing to ignore it. Classify the value in merge-evidence.sh before merging."
  exit 1
fi

if [ "${n_pending}" -gt 0 ]; then
  verdict 'PENDING' "${n_pending} check(s) still running against head ${head_sha}: ${pending_names}"
  exit 2
fi

# The positive-execution requirement. Everything above rules out known-bad
# shapes; this rules out the unknown ones by demanding proof rather than the
# absence of a complaint.
if [ "${n_success}" -eq 0 ]; then
  verdict 'NO_EVIDENCE' "no job actually executed against head ${head_sha} — ${returned_count} check-run(s) exist but none reached a success conclusion. Refusing to read that as a pass."
  exit 3
fi

# ---------------------------------------------------------------------------
# 7. The backend suite must have run when the diff touches the backend (ENG-915)
# ---------------------------------------------------------------------------
#
# Reached only once the run is known real and nothing failed or is pending, so
# this converts exactly one verdict: a PASS that would have been read off a
# `skipped` backend suite. See the header for why the skip's reason cannot be
# inferred from the payload.

# Endpoint first, flags after: every other call in this script passes the
# endpoint as the first argument, and the test mock dispatches on it.
#
# One line per file, tab-separated: current path, then the pre-rename path
# when there is one. The two consumers below need different projections —
# the backend classifier must see only current paths (dorny/paths-filter
# classifies on the post-rename name, so gating on the old path of a file
# renamed OUT of the backend demands evidence the workflow never scheduled),
# while the base-overlap check needs both names of every file this PR touches.
changed_files_tsv="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/files?per_page=100" \
  --paginate --jq '.[] | .filename + "\t" + (.previous_filename // "")' 2>"${stderr_file}")"
gh_exit=$?

# Fail closed, and as ERROR rather than a verdict: an unreadable diff means the
# gate cannot tell whether the requirement applies, which is not a statement
# about the PR.
if [ "${gh_exit}" -ne 0 ]; then
  hard_fail "GitHub API call failed (exit ${gh_exit}) reading the changed files of ${REPO}#${PR_NUMBER}, so whether the backend suite was required here cannot be established: $(tr '\n' ' ' <"${stderr_file}")"
fi
if [ -z "${changed_files_tsv}" ]; then
  hard_fail "${REPO}#${PR_NUMBER} reports no changed files at ${head_sha}. An open PR always has at least one, so this is an unreadable diff rather than an empty one, and the backend-suite requirement cannot be evaluated."
fi

# Current paths only — what the workflow's path filter classified on.
current_files="$(printf '%s\n' "${changed_files_tsv}" | cut -f1)"
# Both names of every touched file — what the base-overlap check compares on.
changed_files="$(printf '%s\n' "${changed_files_tsv}" | tr '\t' '\n' | sed '/^$/d')"

# Prefix match anchored at the start of the path, via `case` rather than grep:
# the prefixes contain `.` and `/`, and a regex would either need escaping or
# would match `partner-portal/backend/x` as a backend change. `case` compares
# literally except for the trailing `*`, so there is nothing to escape.
#
# Current paths only: a file renamed OUT of the backend no longer schedules
# the backend jobs (the workflow classifies on the post-rename path), so
# demanding their evidence here would be an unfixable NO_EVIDENCE.
touches_backend=''
while IFS= read -r file; do
  [ -n "${file}" ] || continue
  while IFS= read -r prefix; do
    [ -n "${prefix}" ] || continue
    case "${file}" in
      "${prefix}"*)
        touches_backend="${file}"
        break 2
        ;;
    esac
  done <<<"${BACKEND_PATHS}"
done <<<"${current_files}"

if [ -n "${touches_backend}" ]; then
  missing=''
  while IFS= read -r job; do
    [ -n "${job}" ] || continue
    # "Did it ever pass at this head", not "is the newest entry a pass".
    #
    # Without this, re-running the workflow at a head whose suite had already
    # gone green reports NO_EVIDENCE the moment the re-run's discriminator
    # comes back below 5/5: the tests skip, the skip is newer than the success,
    # and a real green run at this exact SHA is discarded. That verdict is
    # wrong on the facts — the suite did execute against this code — and it is
    # unfixable by the author, because pushing to clear it changes the head.
    #
    # Safe because of where this sits: section 7 is reached only after the
    # classification above found nothing failed and nothing is pending. A later
    # FAILURE at this head is counted there (both suites survive pass 1, so a
    # failing re-run is visible) and exits before reaching this line. So this
    # can only ever rescue a success that a SKIP superseded — never mask a
    # failure with an earlier pass.
    #
    # ENG-1381 narrowed that precondition: a `cancelled` job no longer exits at
    # `n_bad`, so this line is now also reachable with one present. The rescue
    # stays sound for the same reason it always did — the head SHA is immutable,
    # so a suite that went green tested exactly this code and a later
    # cancellation cannot un-test it. What it must not do is treat a cancelled
    # backend job that NEVER passed as evidence, and it does not: `job_state`
    # falls through to the newest conclusion, which is `cancelled`, which is not
    # `success`, so it lands in `missing` and returns NO_EVIDENCE below.
    job_state="$(printf '%s' "${runs_after_supersession}" | jq -r --arg job "${job}" '
        [ .check_runs[] | select(.name == $job) ] as $rows
        | if ($rows | length) == 0 then "ABSENT"
          elif any($rows[]; .conclusion == "success") then "success"
          else ($rows | max_by(.id // 0) | .conclusion // "pending")
          end' 2>/dev/null)"
    jq_exit=$?
    if [ "${jq_exit}" -ne 0 ] || [ -z "${job_state}" ]; then
      surface 'check-runs response (raw)' "${runs_json}"
      hard_fail "unparseable check-runs payload while requiring the backend suite job '${job}' at ${head_sha}"
    fi
    if [ "${job_state}" != "success" ]; then
      missing="${missing:+${missing}, }${job} (${job_state})"
    fi
  done <<<"${BACKEND_JOBS}"

  if [ -n "${missing}" ]; then
    verdict 'NO_EVIDENCE' "${REPO}#${PR_NUMBER} changes backend paths (e.g. ${touches_backend}), but the backend suite did not execute against head ${head_sha}: ${missing}. A skip here is not proof the path filter excluded them — it is the absence of the measurement this gate exists to require. Push or re-run the workflow at this head. If a job was renamed, set MERGE_EVIDENCE_BACKEND_JOBS."
    exit 3
  fi
fi

# ---------------------------------------------------------------------------
# 8. The evidence must describe the merge that would actually happen (ENG-1003)
# ---------------------------------------------------------------------------
#
# Everything above proves a real run executed at this head and nothing failed.
# That is a statement about the PR's code, not about the merge: on a
# `pull_request` event `actions/checkout` resolves `github.ref` to
# `refs/pull/N/merge`, so the suite tested this branch merged into whatever the
# base was WHEN THE RUN STARTED. Commits that landed on the base afterwards were
# never part of the measurement.
#
# Until now this gate said nothing about that. The freshness property was
# enforced only by GitHub's `strict` branch protection, which buys it by
# invalidating every open PR on every merge and charging each one a full ~34
# runner-minute revalidation — 25 of agentweb's 35 open PRs sat BEHIND with zero
# CLEAN when ENG-1003 was filed, and draining them serially costs ~11 hours.
#
# The property is cheaper to check than to enforce by brute force. A base commit
# only invalidates this PR's green suite if it touched a file this PR also
# touches; otherwise the tested merge result is still the merge that would land.
#
# Scope, stated honestly: this proves FILE-LEVEL independence, not semantic
# independence. Two PRs can break each other while editing different files. That
# is a real gap — but it is a gap `strict` does not close either, because
# `strict` only forces the branch to be current, and the sole REQUIRED context
# here (`Detect changed projects`) does not run the test suite at all — it is a
# ~25s paths-filter job at the HEAD of the graph, so it reports green long
# before the suites it gates even finish. (Until ENG-1371 the required set also
# named `Require Greptile Review`, which at least sat behind backend-tests-a/b;
# that job is gone, so the required set now proves strictly less than it did.
# ENG-1373 is the fix.) So this is strictly more evidence than the repo has today, not
# less. Turning `strict` off is a separate, human decision (ENG-1003); this block
# is what makes that decision safe to take rather than a silent loss of a gate.

# The comparison runs UNCONDITIONALLY, not only when mergeStateStatus reads
# BEHIND. mergeStateStatus reports one dominant state: a PR that is behind AND
# awaiting a required review reports BLOCKED, not BEHIND, and gating the
# comparison on the displayed state would let that PR's stale evidence through.
# `ahead_by` from the compare endpoint is the ground truth for "did the base
# move"; the displayed state is not consulted at all.
{
  # GitHub's compare endpoint returns at most this many file entries. A list at
  # the cap may be truncated, and a truncated list cannot prove the ABSENCE of
  # an overlap — which is the only thing this section is allowed to conclude.
  COMPARE_FILE_CAP=300

  if [ -z "${base_ref}" ]; then
    hard_fail "${REPO}#${PR_NUMBER}: \`gh pr view\` returned no baseRefName, so the base cannot be identified and the staleness of the evidence cannot be evaluated."
  fi

  # Three dots: GitHub computes the merge base of head and base, then diffs the
  # merge base to the base head. `.files` is therefore exactly what landed on the
  # base while this PR was open — not this PR's own diff inverted.
  compare_json="$(gh api "repos/${REPO}/compare/${head_sha}...${base_ref}" 2>"${stderr_file}")"
  gh_exit=$?

  if [ "${gh_exit}" -ne 0 ]; then
    hard_fail "GitHub API call failed (exit ${gh_exit}) comparing ${head_sha} against ${base_ref} for ${REPO}#${PR_NUMBER}, so whether the base moved under the tested merge cannot be established: $(tr '\n' ' ' <"${stderr_file}")"
  fi

  base_meta="$(printf '%s' "${compare_json}" | jq -r '
      ((.ahead_by // 0) | tostring), ((.files // []) | length | tostring)' 2>/dev/null)"
  jq_exit=$?
  if [ "${jq_exit}" -ne 0 ] || [ -z "${base_meta}" ]; then
    surface 'compare response (raw)' "${compare_json}"
    hard_fail "unparseable response comparing ${head_sha} against ${base_ref} — expected a JSON object with ahead_by and files."
  fi

  base_ahead="$(printf '%s\n' "${base_meta}" | sed -n '1p')"
  base_file_count="$(printf '%s\n' "${base_meta}" | sed -n '2p')"

  # Non-numeric here would make the `-ge` below error and evaluate FALSE, which
  # is the pass direction. Refuse to guess rather than fail open.
  case "${base_ahead}${base_file_count}" in
    ''|*[!0-9]*)
      surface 'compare response (raw)' "${compare_json}"
      hard_fail "the comparison of ${head_sha} against ${base_ref} returned a non-numeric ahead_by/file count ('${base_ahead}'/'${base_file_count}'), so overlap cannot be evaluated."
      ;;
  esac

  if [ "${base_ahead}" -eq 0 ]; then
    log "the base ${base_ref} has not moved since this PR's merge base, so the run at ${head_sha} describes the merge that would land."
  else

  if [ "${base_file_count}" -ge "${COMPARE_FILE_CAP}" ]; then
    verdict 'NO_EVIDENCE' "${REPO}#${PR_NUMBER} is ${base_ahead} commit(s) behind ${base_ref}, and the comparison returned ${base_file_count} files — at or above GitHub's ${COMPARE_FILE_CAP}-file cap, so the list may be truncated and cannot prove this PR's diff is untouched by it. Sync the branch and let CI re-run against the current base."
    exit 3
  fi

  # Both the current and the pre-rename path participate: a rename on the base
  # is an edit to the logical file under both names, and matching only the
  # post-rename path would let "base renamed a file this PR edits under its old
  # name" through as a false non-overlap.
  base_files="$(printf '%s' "${compare_json}" | jq -r '(.files // [])[] | .filename, (.previous_filename // empty)' 2>/dev/null)"
  jq_exit=$?
  if [ "${jq_exit}" -ne 0 ]; then
    surface 'compare response (raw)' "${compare_json}"
    hard_fail "unparseable file list comparing ${head_sha} against ${base_ref}."
  fi

  # Exact path equality, not a prefix match: this is asking "did the base edit a
  # file this PR also edits", and `src/a.ts` must not be read as matching
  # `src/a.ts.snap`.
  base_overlap=''
  while IFS= read -r base_file; do
    [ -n "${base_file}" ] || continue
    while IFS= read -r pr_file; do
      [ -n "${pr_file}" ] || continue
      if [ "${base_file}" = "${pr_file}" ]; then
        base_overlap="${base_file}"
        break 2
      fi
    done <<<"${changed_files}"
  done <<<"${base_files}"

  if [ -n "${base_overlap}" ]; then
    verdict 'NO_EVIDENCE' "${REPO}#${PR_NUMBER} is ${base_ahead} commit(s) behind ${base_ref}, and one of those commits changed '${base_overlap}', which this PR also changes. The green run at head ${head_sha} tested a merge result that no longer exists, so it is not evidence for the merge that would happen now. Sync the branch and let CI re-run."
    exit 3
  fi

  log "base has moved ${base_ahead} commit(s) ahead (${base_file_count} file(s) changed on ${base_ref}), but none of them are files this PR touches, so the run at ${head_sha} still describes the merge that would land."

  fi
}

# Acceptance criterion 5: the run is known real, so remaining skips are path
# filters working correctly. Name them, and label them, so the distinction is
# explicit rather than inferred.
verdict 'PASS' "${n_success} job(s) executed successfully against head ${head_sha}: ${success_names}"
if [ -n "${skipped_names}" ]; then
  log "skipped by path filter (legitimate — '${DRAFT_JOB}' executed, and every job it covers carries a success): ${skipped_names}"
fi

# ENG-1381 AC2, and the condition on which tolerating a cancellation is
# defensible at all. These jobs produced NO verdict, and this PASS is a
# statement about the jobs that did — never about these. Printed on the pass
# path specifically, because a cancellation that blocks announces itself and one
# that does not is invisible unless it is said out loud. If a name here starts
# recurring, that is a signal about the job, not noise to filter: it is how the
# global backend-staging-deploy lane (ENG-1003) stayed latent long enough to
# force the override on #2491.
#
# Split in two, after CodeRabbit caught the single-line version asserting
# something false on #2523. Section 7 accepts a required job on "did it EVER
# pass at this head", so a job with a cancelled attempt AND a success reaches
# this point legitimately — and calling it "outside the evidence set", as the
# first version did, misdescribes the one thing this line exists to state
# accurately. The verdict was right; only the explanation was wrong, which is
# the more dangerous half to get wrong in a control people read to decide
# whether to trust a green.
if [ "${n_cancelled}" -gt 0 ]; then
  if [ -n "${cancelled_outside}" ]; then
    log "cancelled, NOT blocking — no verdict was produced and none was required from these: ${cancelled_outside}"
  fi
  if [ -n "${cancelled_inset}" ]; then
    log "cancelled ATTEMPT(s) of job(s) INSIDE the evidence set ('${DRAFT_JOB}' + MERGE_EVIDENCE_BACKEND_JOBS). The requirement on each is separately accounted for above — either a success at this head, or a path filter that made it inapplicable — so this is a spent attempt, not a tolerated gap: ${cancelled_inset}"
  fi
fi
exit 0
