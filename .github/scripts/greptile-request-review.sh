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
#
# main() also re-resolves the head immediately before calling the rerun (not
# just once at the top) — caught live a third time (Greptile 4/5,
# portal#1035): reusing the head resolved at the top for the rerun call too
# means a push in between could make the request and the rerun target
# different commits.
#
# CAUGHT LIVE A FOURTH TIME (Greptile P1, agentweb#2427, "Head-race recovery
# duplicates reviews"): the head-mismatch branch below unconditionally told
# the operator to re-run WITHOUT --rerun-only. But the request comment posted
# a moment earlier carries no SHA pin on Greptile's side — Greptile reviews
# whatever the PR's head is when it gets around to processing the mention.
# If the new commit lands, THEN Greptile processes the original mention, its
# review can end up covering the NEW head anyway — and the unconditional
# "post another request" advice pays for a second review of a head that's
# already covered.
#
# CAUGHT LIVE A FIFTH TIME (Greptile 4/5, agentweb#2427, reviewing THAT fix):
# it only handled "a landed verdict already names the new head." It still
# guessed wrong on the other case — no verdict landed for the new head YET —
# by treating "not yet covered" as equivalent to "will never be covered" and
# advising a fresh request anyway, which can still turn out to be a paid
# duplicate if the original, still-in-flight request resolves against the new
# head moments later. Distinguishing "never requested" from "requested and
# still in flight" is not observable from this script's vantage point at all
# — Greptile exposes no "in progress" signal, only a landed verdict once one
# exists.
#
# The actual fix: STOP TRYING TO DISTINGUISH THEM. On any head mismatch —
# covered, not-yet-covered, or the lookup itself failing — post nothing new.
# Just rerun the gate job against the new head and hand the whole question to
# greptile-gate.sh's OWN poll loop, which is already correct and already
# tested for exactly this shape of ambiguity: it waits (up to
# GREPTILE_GATE_TIMEOUT_SECONDS) for a verdict matching the CURRENT head and
# treats any verdict for a different commit as pending, not a failure. Either
# the in-flight request resolves against the new head (the gate catches it,
# scores it normally) or it doesn't (the gate times out to UNAVAILABLE — exit
# 75 — which is PROOF no verdict for this head ever landed, and only then is
# re-running this script fresh the correct next step, not a guess). This
# branch itself can never pay for a duplicate again: it posts nothing.
#
# ONE KNOWN, DELIBERATE LIMIT, flagged in the same portal#1035 review (3/5)
# and left as-is rather than chased further: the window between the final
# re-check and the actual rerun API call is still non-atomic — GitHub has no
# "rerun this job, but only if HEAD is still X" endpoint. Every fix so far
# has narrowed this from "however long a human takes to notice and retry"
# down to consecutive API calls milliseconds apart. Closing it completely
# isn't possible without a capability this API doesn't offer, and the
# fail-closed gate means the worst residual outcome is a wasted credit and a
# retry — never a false pass. Diminishing returns past this point.
#
# A LOOKUP failure inside request_marker_exists_for (the GitHub API call
# itself erroring — reproduced for real by a transient DNS failure during
# this script's own development) is retried 3x before giving up, and
# reported as a DISTINCT outcome from "confirmed absent" — see that function
# and the case statement in main() for why conflating the two was the actual
# bug, not the retry count. A network blip lasting longer than the retry
# window still ends the script; that's the correct failure mode (loud, not a
# duplicate request), not a bug to fix by retrying harder. The same
# lookup-failure-is-not-absence distinction applies to
# greptile_reviewed_head() below, for the same reason.

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

# Exit 0: the marker was found. Exit 1: comments were fetched fine and the
# marker is genuinely absent. Exit 2: the lookup itself failed after retries
# — a DIFFERENT outcome from "absent", and the caller must not conflate them.
#
# CAUGHT LIVE (Greptile 3/5, portal#1035) — and then reproduced for real by
# this session's own transient DNS failure mid-dogfood: the original version
# collapsed "confirmed no marker" and "couldn't check because the GitHub API
# call itself failed" into the same `return 1`. main()'s caller treated both
# as "no request exists, post a new one" — so a one-off network blip during
# the CHECK made a perfectly valid outstanding request look absent, and the
# advice was to pay for a duplicate. A transient failure must never look
# like a confirmed negative.
#
# CAUGHT LIVE A SECOND TIME (Greptile 4/5, agentweb#2427, reviewing that
# exact fix): the fix above checked `comments_json` for EMPTINESS as its
# failure signal, discarding `gh`'s actual exit code (`2>/dev/null || true`
# swallows it). `--paginate` fetches this endpoint across multiple pages on
# a busy PR — if an early page succeeds and a LATER page fails (rate limit,
# blip mid-pagination), `gh` can still have printed the early page(s) to
# stdout before erroring. That output is non-empty, so the old code treated
# a truncated, incomplete comment list as "fetched fine, search it" — and
# if the marker's comment happened to be among the pages that never
# arrived, this searched a PARTIAL list, found nothing, and returned a
# confirmed-absent verdict for a request that was actually still there.
# Reintroduces the exact duplicate-billing bug the first fix closed, via a
# different failure shape (partial success) the first fix didn't consider.
#
# Fix: capture the REAL exit code (`set +e` / `set -e` around the call, the
# same idiom used elsewhere in this file), not just whether stdout is
# empty. Any non-zero exit — whatever partial output came with it — is
# retried exactly like a total failure. Never trust partial pagination
# output as if it were the complete list.
request_marker_exists_for() {
  local head_sha="$1" comments_json rc attempt
  for attempt in 1 2 3; do
    # Deliberately NOT `set +e; ...; rc=$?; set -e` here: that toggle
    # re-enables errexit as a side effect of this function's own body, and
    # a caller that wrapped ITS OWN call to this function in `set +e`
    # cannot rely on that surviving once this function starts flipping the
    # global errexit flag internally — bash's `set -e` state is a single
    # process-wide flag, not scoped per function call. A function ending
    # with errexit back on, then returning non-zero as a bare statement,
    # kills the whole script before the caller ever reads $? — which is
    # exactly what happened live (empty output, wrong exit code) building
    # this fix. The `if cmd; then rc=0; else rc=$?; fi` form is immune to
    # this: POSIX exempts the tested command of an `if` from errexit
    # regardless of what that command does internally, with no shared
    # mutable state to leak across the call boundary.
    if comments_json="$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100" 2>/dev/null)"; then
      rc=0
    else
      rc=$?
    fi
    if [ "${rc}" -eq 0 ]; then
      if printf '%s' "${comments_json}" | grep -qF "$(request_marker "${head_sha}")"; then
        return 0
      fi
      return 1
    fi
    if [ "${attempt}" -lt 3 ]; then
      sleep 3
    fi
  done
  return 2
}

# Exit 0: a landed Greptile verdict's "Last reviewed commit" footer already
# names ${1}. Exit 1: comments were fetched fine and no landed verdict names
# it (still pending, or genuinely never requested). Exit 2: the lookup itself
# failed after retries — same three-way split as request_marker_exists_for,
# for the same reason: a transient failure must never read as "not covered".
#
# Mirrors greptile-gate.sh's own comment selection exactly (same query, same
# reply-thread-avoidance), because that is the one place in this repo that
# has already been proven correct against Greptile's actual comment-editing
# behavior — re-deriving different selection logic here risks re-introducing
# a bug that file's own header describes fixing.
greptile_reviewed_head() {
  local head_sha="$1" comments_json rc body reviewed_sha
  for attempt in 1 2 3; do
    if comments_json="$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100" 2>/dev/null)"; then
      rc=0
    else
      rc=$?
    fi
    if [ "${rc}" -eq 0 ]; then
      body="$(printf '%s' "${comments_json}" | jq -r '
          [ .[]
            | select((.user.type // "") == "Bot")
            | select(((.user.login // "") | ascii_downcase | startswith("greptile")))
            | (.body // "")
          ] as $bodies
          | ( [ $bodies[] | select(test("last reviewed commit"; "i")) ] | last )
            // ""
        ' 2>/dev/null || true)"
      if [ -z "${body}" ]; then
        return 1
      fi
      reviewed_sha="$(printf '%s' "${body}" \
        | grep -oiE 'commit/[0-9a-f]{40}' \
        | head -n 1 \
        | cut -d/ -f2 \
        | tr '[:upper:]' '[:lower:]')"
      if [ -n "${reviewed_sha}" ] && [ "${reviewed_sha}" = "${head_sha}" ]; then
        return 0
      fi
      return 1
    fi
    if [ "${attempt}" -lt 3 ]; then
      sleep 3
    fi
  done
  return 2
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
    # A LOOKUP failure (exit 2) is a DIFFERENT outcome from a confirmed
    # absence (exit 1) and must never be told to post a duplicate — see
    # request_marker_exists_for's header for why that distinction exists.
    # Same errexit hazard as inside request_marker_exists_for itself (see
    # its header) -- `if fn; then rc=0; else rc=$?; fi`, not a `set +e` /
    # `set -e` pair, so this call site can't be taken down by whatever
    # errexit state the function leaves behind internally.
    local marker_rc
    if request_marker_exists_for "${head_sha}"; then
      marker_rc=0
    else
      marker_rc=$?
    fi
    case "${marker_rc}" in
      0) ;;
      2) fail "--rerun-only could not confirm whether a request exists for head ${head_sha} — the GitHub API lookup itself failed after retries (see the log above for the underlying error). This is NOT the same as 'no request exists': do not post a fresh review request. Re-run '$0 --rerun-only' again once the API is reachable." ;;
      *) fail "--rerun-only was called for head ${head_sha}, but no review request marker was found for it — the head changed since the original request (or none was ever made for this head). Re-run WITHOUT --rerun-only so the current head actually gets a review requested." ;;
    esac
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
    # CAUGHT LIVE A FIFTH TIME (Greptile 4/5, agentweb#2427, reviewing the
    # FOURTH fix — "head-race recovery can still duplicate a review when the
    # original request is in-flight, not yet landed, for the new head"):
    # the fourth fix only handled "a landed verdict already names the new
    # head". It still FAILED (advising a fresh request) whenever the new
    # head wasn't YET covered — but "not yet covered" and "will never be
    # covered" look identical from here, and Greptile has no SHA pin on our
    # mention, so the original, still-in-flight request MAY resolve against
    # this exact new head moments later. Trying to tell those two states
    # apart from this script is exactly the mistake the previous four fixes
    # made, one narrower version at a time (see the trap list above).
    #
    # Fix: stop guessing. On ANY head mismatch — covered, not-yet-covered,
    # or the lookup itself failing — never post a second request from here.
    # Just rerun the gate job against the new head and let greptile-gate.sh's
    # OWN poll loop (already correct, already tested, up to
    # GREPTILE_GATE_TIMEOUT_SECONDS) do what it already does for exactly this
    # situation: wait for a verdict matching the CURRENT head, and treat any
    # verdict for a DIFFERENT commit as pending, not a failure. Two outcomes,
    # both correct, neither guessed:
    #   - the in-flight request DOES resolve against the new head → the gate
    #     sees a matching verdict and passes/fails on score, same as always.
    #   - it does NOT → the gate times out to UNAVAILABLE (exit 75), which is
    #     PROOF no verdict for this head ever landed within the window. Only
    #     THEN does re-running this script fresh (without --rerun-only) become
    #     the correct, no-longer-a-guess next step for a human/agent watching
    #     the gate's outcome — not something this script decides preemptively.
    # This can never itself pay for a duplicate: it posts nothing.
    local covered_rc
    if greptile_reviewed_head "${head_sha_before_rerun}"; then
      covered_rc=0
    else
      covered_rc=$?
    fi
    case "${covered_rc}" in
      0)
        log "the PR head changed from ${head_sha} to ${head_sha_before_rerun} while this script was running, but Greptile already has a landed verdict for ${head_sha_before_rerun} — no duplicate request needed. Rerunning the gate against the new head." ;;
      2)
        log "the PR head changed from ${head_sha} to ${head_sha_before_rerun} while this script was running, and checking whether Greptile already covered the new head failed after retries — proceeding to rerun the gate anyway; its own poll loop resolves this correctly regardless (see above)." ;;
      *)
        log "the PR head changed from ${head_sha} to ${head_sha_before_rerun} while this script was running, and no landed verdict covers the new head yet. NOT guessing by posting a second request — the original request may still resolve against this head. Rerunning the gate against the new head; its own poll loop will catch a late-landing verdict or time out to UNAVAILABLE if none arrives, which is the correct signal to re-run this script fresh." ;;
    esac
    rerun_gate_job "${head_sha_before_rerun}"
    return
  fi

  rerun_gate_job "${head_sha}"
}

main "$@"
