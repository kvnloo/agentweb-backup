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
# Telling a draft skip from a legitimate path-filter skip (criterion 5)
# ---------------------------------------------------------------------
# `.github/workflows/tests.yml` gates the backend jobs on
# `backend == 'true' && draft == false`, collapsing both reasons into one
# `if`, so both render identically as `conclusion: skipped`. One job
# disambiguates them: `Require Greptile Review` is gated on `draft == false`
# ALONE, with no path filter. Therefore:
#
#   discriminator skipped  -> this was a draft-time run; every draft-gated
#                             job skipped for that reason. Not evidence.
#   discriminator executed -> any other skip is a path filter doing its job,
#                             which is legitimate and reported as such.
#
# The discriminator is matched by exact name and its absence fails closed, so
# renaming that job degrades to "no evidence" rather than silently removing
# the gate's ability to recognise a draft run.
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
#   1  FAIL         a check actually ran and failed/was cancelled
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
#                               (default "Require Greptile Review")

set -uo pipefail

REPO="${REPO:?REPO must be set}"
PR_NUMBER="${PR_NUMBER:?PR_NUMBER must be set}"
DRAFT_JOB="${MERGE_EVIDENCE_DRAFT_JOB:-Require Greptile Review}"

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
  --json number,state,isDraft,mergeable,mergeStateStatus,headRefOid \
  2>"${stderr_file}")"
gh_exit=$?

if [ "${gh_exit}" -ne 0 ]; then
  hard_fail "GitHub API call failed (exit ${gh_exit}) reading ${REPO}#${PR_NUMBER}: $(tr '\n' ' ' <"${stderr_file}")"
fi

parsed="$(printf '%s' "${pr_json}" | jq -r '
    [ (.state // ""), (.isDraft | tostring), (.mergeable // ""), (.headRefOid // "") ]
    | join("\u001f")' 2>/dev/null)"
jq_exit=$?

if [ "${jq_exit}" -ne 0 ] || [ -z "${parsed}" ]; then
  surface 'gh pr view response (raw)' "${pr_json}"
  hard_fail "unparseable response from \`gh pr view ${PR_NUMBER}\` — expected a JSON object with state/isDraft/mergeable/headRefOid"
fi

IFS="${SEP}" read -r pr_state pr_draft pr_mergeable head_sha <<<"${parsed}"

if [ -z "${pr_state}" ] || [ -z "${pr_mergeable}" ]; then
  surface 'gh pr view response (raw)' "${pr_json}"
  hard_fail "unparseable response from \`gh pr view ${PR_NUMBER}\` — state and/or mergeable is missing, so the PR's schedulability cannot be established"
fi

head_sha="$(printf '%s' "${head_sha}" | tr '[:upper:]' '[:lower:]')"
if ! printf '%s' "${head_sha}" | grep -qE '^[0-9a-f]{40}$'; then
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
# 2. Check runs, keyed on this exact head SHA
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

# ---------------------------------------------------------------------------
# 3. Classify every check-run at this head
# ---------------------------------------------------------------------------
#
# Computed before the draft check because the draft verdict needs to know
# whether a run is currently executing — see the note in section 4.

classified="$(printf '%s' "${runs_json}" | jq -r '
    def bad: ["failure","cancelled","timed_out","action_required","stale"];
    [ ([ .check_runs[] | select(.status != "completed") ] | length),
      ([ .check_runs[] | select(.conclusion as $c | bad | index($c)) ] | length),
      ([ .check_runs[] | select(.conclusion == "success") ] | length),
      ([ .check_runs[] | select(.status != "completed") | .name ] | join(", ")),
      ([ .check_runs[] | select(.conclusion as $c | bad | index($c)) | "\(.name) (\(.conclusion))" ] | join(", ")),
      ([ .check_runs[] | select(.conclusion == "skipped") | .name ] | join(", ")),
      ([ .check_runs[] | select(.conclusion == "success") | .name ] | join(", "))
    ] | map(tostring) | join("")' 2>/dev/null)"
jq_exit=$?

if [ "${jq_exit}" -ne 0 ] || [ -z "${classified}" ]; then
  surface 'check-runs response (raw)' "${runs_json}"
  hard_fail "unparseable check-runs payload while classifying job conclusions at ${head_sha}"
fi

IFS="${SEP}" read -r n_pending n_bad n_success pending_names bad_names skipped_names success_names <<<"${classified}"

# ---------------------------------------------------------------------------
# 4. Was this a draft-time run?
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

discriminator="$(printf '%s' "${runs_json}" | jq -r --arg job "${DRAFT_JOB}" '
    [ .check_runs[] | select(.name == $job) ]
    | last
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

# ---------------------------------------------------------------------------
# 5. Ordinary reporting, now that the run is known to be real
# ---------------------------------------------------------------------------

if [ "${n_bad}" -gt 0 ]; then
  verdict 'FAIL' "${n_bad} check(s) failed against head ${head_sha}: ${bad_names}"
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

# Acceptance criterion 5: the run is known real, so remaining skips are path
# filters working correctly. Name them, and label them, so the distinction is
# explicit rather than inferred.
verdict 'PASS' "${n_success} job(s) executed successfully against head ${head_sha}: ${success_names}"
if [ -n "${skipped_names}" ]; then
  log "skipped by path filter (legitimate — '${DRAFT_JOB}' executed, so this was not a draft run): ${skipped_names}"
fi
exit 0
