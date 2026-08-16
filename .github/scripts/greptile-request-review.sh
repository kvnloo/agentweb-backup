#!/usr/bin/env bash
#
# Request a fresh Greptile review of a PR's current head, AND make that review
# actually count (ENG-1282).
#
# greptile.json now sets `triggerOnUpdates: false`. Greptile no longer
# auto-reviews every push to an already-ready PR — only `opened` and
# `ready_for_review` trigger a review automatically. That flag existed
# because it was billing $1/review past the included 50/seat, and PRs here
# average 6.4 pushes before merge (max measured: 50) — every one of those was
# a paid re-review of code nobody had finished changing yet.
#
# Call this ONCE, after a batch of fixes is pushed and you actually want a
# fresh verdict on the current head — not after every individual push.
# Calling it per-push recreates the exact cost this change removes.
#
# WHY POSTING THE COMMENT ISN'T ENOUGH (caught live by Greptile itself, 4/5,
# reviewing this script's first version on PR #2427): the `Require Greptile
# Review` job (.github/scripts/greptile-gate.sh) only polls for a matching
# review while its OWN job run is still executing. That job run already
# completed — refused, because at push time no review existed yet — before
# a human or agent gets around to asking for one. Posting `@greptileai`
# afterward makes Greptile publish a fresh review, but nothing about that
# webhook re-triggers the `pull_request` workflow, so the already-completed,
# already-failed required check just sits there. A real review can exist,
# scored 5/5, on the exact right commit, and the merge gate still reads
# failed — worse than not automating this at all, because it *looks* handled.
#
# So this script does two things, in order:
#   1. Ask Greptile for a fresh review (the documented `@greptileai` mention).
#   2. Re-run *only* the `Require Greptile Review` job on the PR's current
#      head — not the whole workflow, so this doesn't resurrect the heavy
#      Jest pair. That job's own poll loop (up to 10 minutes, see
#      greptile-gate.sh) then has a live window to catch the review this
#      script just asked for.
#
# Environment:
#   REPO         owner/repo, e.g. AgentWebPro/agentweb
#   PR_NUMBER    pull request number
#   GH_TOKEN     token for `gh`. Must be a real user/PAT-scoped token with
#                `actions: write` (e.g. an interactive `gh auth login`
#                session) — the ambient `GITHUB_TOKEN` inside a GitHub Actions
#                run cannot rerun jobs (GitHub blocks that as workflow-
#                recursion prevention), so this script is meant to be invoked
#                by an agent/human from their own shell, never wired into
#                tests.yml itself.
#
# Not idempotent by design: every call posts one comment and requests one
# rerun. The caller decides when a fresh review is warranted; this script has
# no way to know whether one is already pending, and guessing wrong in either
# direction is worse than the trivial cost of one extra comment/rerun.
#
# Exit status:
#   0   comment posted AND the gate job rerun was accepted.
#   1   a real failure — nothing here has a fallback, and a silently skipped
#       step means the gate later fails closed for a reason nothing explains,
#       or (the actively dangerous case) a rerun request that silently didn't
#       happen leaves the gate stuck refused with a real 5/5 sitting unread.
#   2   RETRYABLE, not a failure: GitHub refuses to rerun a single job while
#       the workflow run containing it is still `in_progress` (verified live
#       against PR #2427 — the greptile-review job itself was long since
#       `completed`/`failure`, but the run overall was still `in_progress`
#       because the backend Jest pair was still running, and the rerun API
#       403'd). The comment WAS still posted. Retry with `--rerun-only` once
#       the run for the current head has settled — a later Watchdog tick, not
#       a busy wait here, since that settling can take the same ~15-17 minutes
#       the backend test pair already takes. Plain re-invocation (no flag)
#       would post a second `@greptileai` comment for the same head, paying
#       for a redundant review the first call already requested.
#
# `--rerun-only`: skip the comment, only retry the gate-job rerun for a
# request already made. CAUGHT LIVE (Greptile 4/5 reviewing the exit-2 fix
# itself, same PR): if a new commit lands between the original request and
# the `--rerun-only` retry, blindly reusing this flag reruns the gate for a
# head NOBODY asked Greptile to review — it polls for a review that was never
# requested and eventually goes `unavailable`, silently.
#
# The first fix for that checked Greptile's `Last reviewed commit` footer
# against the current head — and Greptile caught (4/5, again, same PR,
# reviewing that very fix) that this conflates two different states that
# look identical from the outside: "nobody asked for a review of this head"
# and "someone asked, Greptile just hasn't finished yet". Greptile only
# EDITS its comment once a review lands; there is no observable signal for
# "in flight". Checking the footer alone means a `--rerun-only` call made
# seconds after the real request (before Greptile answers) wrongly concludes
# "stale" and tells the caller to post a SECOND request — the exact
# redundant-billing bug this script exists to prevent.
#
# Fix: the request comment carries a hidden per-head marker
# (`<!-- greptile-request-review: head=<sha> -->`), and `--rerun-only` looks
# for THAT — "was a request ever posted for this exact head" — not for a
# landed verdict. A pending review and a landed one both count as "already
# requested"; only a genuinely absent marker fails loudly.

set -euo pipefail

REQUIRED_CHECK_JOB_NAME="${GREPTILE_REQUIRED_JOB_NAME:-Require Greptile Review}"
WORKFLOW_NAME="${GREPTILE_WORKFLOW_NAME:-Tests}"

fail() {
  echo "::error::GREPTILE_REQUEST_REVIEW_FAILED: $*" >&2
  echo "[greptile-request-review] GREPTILE_REQUEST_REVIEW_FAILED: $*" >&2
  exit 1
}

log() {
  echo "[greptile-request-review] $*"
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "required environment variable ${name} is empty or unset."
  fi
}

request_marker() {
  printf '<!-- greptile-request-review: head=%s -->' "$1"
}

post_review_request() {
  local head_sha="$1"
  if ! gh pr comment "${PR_NUMBER}" --repo "${REPO}" \
    --body "@greptileai
$(request_marker "${head_sha}")" >/dev/null; then
    fail "gh pr comment failed for ${REPO}#${PR_NUMBER}, so no review was requested. Check GH_TOKEN scope (needs pull-requests: write)."
  fi
  log "requested a fresh Greptile review on ${REPO}#${PR_NUMBER} for head ${head_sha}."
}

resolve_head_sha() {
  local head_sha
  head_sha="$(gh pr view "${PR_NUMBER}" --repo "${REPO}" --json headRefOid --jq '.headRefOid' 2>/dev/null || true)"
  if [ -z "${head_sha}" ]; then
    fail "could not resolve the current head SHA for ${REPO}#${PR_NUMBER}."
  fi
  printf '%s' "${head_sha}"
}

# True (exit 0) iff a request comment carrying THIS head's marker exists —
# regardless of whether Greptile has answered it yet. That's the entire
# point: a pending request and a landed one must both read as "already
# asked", or --rerun-only misfires on every retry that lands before Greptile
# does (see the header). Never fails the whole script on a lookup error —
# treated as "can't confirm", which the caller reads as absent (the safe
# direction: request one rather than silently skip).
request_marker_exists_for() {
  local head_sha="$1" comments_json
  comments_json="$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100" 2>/dev/null || true)"
  if [ -z "${comments_json}" ]; then
    return 1
  fi
  printf '%s' "${comments_json}" | grep -qF "$(request_marker "${head_sha}")"
}

# Finds the job to rerun. Deliberately errors loudly rather than silently
# skipping the rerun on any ambiguity — a skipped rerun leaves the gate stuck
# on a stale refusal with no visible sign anything is wrong.
rerun_gate_job() {
  local head_sha="$1" run_id job_id

  run_id="$(gh api "repos/${REPO}/actions/runs?head_sha=${head_sha}&event=pull_request&per_page=10" \
    --jq "[.workflow_runs[] | select(.name == \"${WORKFLOW_NAME}\")] | sort_by(.run_number) | last | .id" 2>/dev/null || true)"
  if [ -z "${run_id}" ] || [ "${run_id}" = "null" ]; then
    fail "could not find a '${WORKFLOW_NAME}' workflow run for head ${head_sha} on ${REPO}#${PR_NUMBER}, so the gate job could not be re-run. The comment above was still posted."
  fi

  job_id="$(gh api "repos/${REPO}/actions/runs/${run_id}/jobs?per_page=100" \
    --jq ".jobs[] | select(.name == \"${REQUIRED_CHECK_JOB_NAME}\") | .id" 2>/dev/null || true)"
  if [ -z "${job_id}" ] || [ "${job_id}" = "null" ]; then
    fail "could not find the '${REQUIRED_CHECK_JOB_NAME}' job in run ${run_id}, so it could not be re-run. The comment above was still posted."
  fi

  local rerun_err
  rerun_err="$(mktemp)"
  if ! gh api -X POST "repos/${REPO}/actions/jobs/${job_id}/rerun" >/dev/null 2>"${rerun_err}"; then
    if grep -qi 'already running' "${rerun_err}"; then
      log "run ${run_id} still has other jobs in progress, so GitHub refuses to re-run '${REQUIRED_CHECK_JOB_NAME}' on its own yet (this is expected, not an error). The comment above was still posted — retry with '$0 --rerun-only' once CI has settled for this head, so the retry doesn't post a second review request."
      rm -f "${rerun_err}"
      exit 2
    fi
    fail "rerunning job ${job_id} ('${REQUIRED_CHECK_JOB_NAME}', run ${run_id}) failed: $(cat "${rerun_err}"). GH_TOKEN needs actions: write — the default in-workflow GITHUB_TOKEN cannot do this by design; run this from an authenticated user/PAT session. The comment above was still posted."
  fi
  rm -f "${rerun_err}"

  log "re-ran '${REQUIRED_CHECK_JOB_NAME}' (job ${job_id}, run ${run_id}) so it can catch the fresh review."
}

main() {
  require_env REPO
  require_env PR_NUMBER

  if ! command -v gh >/dev/null 2>&1; then
    fail "the gh CLI is not on PATH, so the review request could not be posted."
  fi

  local rerun_only=0
  if [ "${1:-}" = "--rerun-only" ]; then
    rerun_only=1
  fi

  local head_sha
  head_sha="$(resolve_head_sha)"

  if [ "${rerun_only}" -eq 0 ]; then
    post_review_request "${head_sha}"
  else
    # Verify a request actually exists for THIS head — landed or still in
    # flight, either counts. If the head moved since the original request
    # (a new push landed in between), no marker matches the current head:
    # fail loudly rather than rerun-and-wait for a review nobody asked for.
    if ! request_marker_exists_for "${head_sha}"; then
      fail "--rerun-only was called for head ${head_sha}, but no review request marker was found for it — the head changed since the original request (or none was ever made for this head). Re-run WITHOUT --rerun-only so the current head actually gets a review requested."
    fi
    log "--rerun-only: confirmed a request is outstanding for head ${head_sha}; skipping a duplicate review request, retrying only the gate-job rerun."
  fi

  # CAUGHT LIVE (Greptile 4/5, portal#1035): head_sha was resolved once, used
  # to post the request, then reused unchecked to pick which workflow run's
  # gate job to rerun. A push landing in that window means the two diverge —
  # the posted request may cover different content than the run being
  # rerun — and the rerun then waits on a review that will never match. Close
  # the window as tightly as this API allows: re-resolve immediately before
  # the rerun and refuse to proceed on a mismatch, rather than rerun a gate
  # for a head the request may not actually cover.
  local head_sha_before_rerun
  head_sha_before_rerun="$(resolve_head_sha)"
  if [ "${head_sha_before_rerun}" != "${head_sha}" ]; then
    fail "the PR head changed from ${head_sha} to ${head_sha_before_rerun} while this script was running — the review just requested may not cover the current head. Re-run the script fresh (without --rerun-only) against the new head rather than rerunning the gate for a request that may be stale."
  fi

  rerun_gate_job "${head_sha}"
}

main "$@"
