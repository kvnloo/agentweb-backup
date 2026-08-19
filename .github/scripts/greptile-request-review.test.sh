#!/usr/bin/env bash
#
# Tests for .github/scripts/greptile-request-review.sh (ENG-1282).
#
# `gh` is replaced with a scripted mock on PATH so every branch runs for real
# without touching GitHub. The mock applies the SAME `--jq` filters the real
# script passes, against fixture JSON, using the real `jq` binary — so a
# filter typo in the script fails the test the same way it would fail in
# production, instead of being masked by a mock that just returns a
# pre-baked answer.
#
# Run with:  bash .github/scripts/greptile-request-review.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/greptile-request-review.sh"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

HEAD_SHA='e1ffbbf7e1cb196b55a9892f0b8e489fa7c615e6'
RUN_ID='31962373883'
JOB_ID='95202232733'

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
#
# $MOCK_DIR/
#   pull.json           `gh pr view --json headRefOid` response
#   runs.json            `gh api .../actions/runs?head_sha=...` response
#   jobs.json             `gh api .../actions/runs/<id>/jobs` response
#   comments.json          `gh api .../issues/<pr>/comments` response
#   comment_exit          exit code for `gh pr comment` (default 0)
#   rerun_exit             exit code for the job rerun POST (default 0)
#   calls.log              one line per gh invocation, args space-joined

# A request comment carrying the per-head marker the real script posts —
# this is what --rerun-only looks for, independent of whether Greptile has
# answered it yet (a landed verdict is NOT required — see the script header
# for why checking the verdict footer alone was the earlier, wrong fix).
marker_comment_for() {
  local sha="$1"
  cat <<EOF
[
  {"user": {"type": "User", "login": "harshmoney123"},
   "body": "@greptileai\n<!-- greptile-request-review: head=${sha} -->"}
]
EOF
}

# A LANDED Greptile verdict naming ${1} — the shape greptile_reviewed_head()
# looks for, distinct from marker_comment_for's own request comment (that one
# is authored by a User and carries no footer; this one is authored by the
# Bot and carries the footer greptile-gate.sh itself parses).
greptile_verdict_comment_for() {
  local sha="$1"
  cat <<EOF
[
  {"user": {"type": "Bot", "login": "greptileai[bot]"},
   "body": "<h3>Greptile Summary</h3>\n<h3>Confidence Score: 4/5</h3>\n<sub>Reviews (3): Last reviewed commit: [\\"fix: x\\"](https://github.com/owner/repo/commit/${sha})</sub>"}
]
EOF
}

write_default_fixtures() {
  cat >"${MOCK_DIR}/pull.json" <<EOF
{"headRefOid": "${HEAD_SHA}"}
EOF
  cat >"${MOCK_DIR}/runs.json" <<EOF
{"workflow_runs": [
  {"id": 111, "run_number": 1, "name": "Tests", "head_sha": "stale"},
  {"id": ${RUN_ID}, "run_number": 2, "name": "Tests", "head_sha": "${HEAD_SHA}"}
]}
EOF
  cat >"${MOCK_DIR}/jobs.json" <<EOF
{"jobs": [
  {"id": 1, "name": "Detect changed projects"},
  {"id": ${JOB_ID}, "name": "Require Greptile Review"},
  {"id": 2, "name": "CI script tests"}
]}
EOF
  # Default: a request marker already exists for HEAD_SHA — the common case
  # for a --rerun-only retry (the original call's comment did post).
  marker_comment_for "${HEAD_SHA}" >"${MOCK_DIR}/comments.json"
  echo 0 >"${MOCK_DIR}/comment_exit"
  echo 0 >"${MOCK_DIR}/rerun_exit"
  echo 0 >"${MOCK_DIR}/comments_exit"
  : >"${MOCK_DIR}/rerun_stderr"
  : >"${MOCK_DIR}/calls.log"
}

install_mock_gh() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${MOCK_DIR}/calls.log"

# Extract a --jq '<filter>' argument if present.
jq_filter=''
prev=''
for arg in "$@"; do
  if [ "${prev}" = "--jq" ]; then
    jq_filter="${arg}"
  fi
  prev="${arg}"
done

case "$1 $2" in
  "pr comment")
    exit "$(cat "${MOCK_DIR}/comment_exit")"
    ;;
  "pr view")
    # If a sha-sequence fixture exists, each successive call advances one
    # line (sticking on the last line once exhausted) — this is how a test
    # simulates the head changing mid-script (a push landing between the
    # script's first and second `gh pr view` call).
    if [ -f "${MOCK_DIR}/pull_sha_sequence.txt" ]; then
      n=$(( $(cat "${MOCK_DIR}/pull_view_count" 2>/dev/null || echo 0) + 1 ))
      echo "${n}" >"${MOCK_DIR}/pull_view_count"
      total=$(wc -l <"${MOCK_DIR}/pull_sha_sequence.txt" | tr -d '[:space:]')
      idx=$(( n < total ? n : total ))
      sha="$(sed -n "${idx}p" "${MOCK_DIR}/pull_sha_sequence.txt")"
      if [ -n "${jq_filter}" ]; then
        printf '{"headRefOid": "%s"}' "${sha}" | jq -r "${jq_filter}"
      else
        printf '{"headRefOid": "%s"}' "${sha}"
      fi
      exit 0
    fi
    if [ -n "${jq_filter}" ]; then
      jq -r "${jq_filter}" "${MOCK_DIR}/pull.json"
    else
      cat "${MOCK_DIR}/pull.json"
    fi
    exit 0
    ;;
esac

if [ "$1" = "api" ]; then
  # Rerun POST: `api -X POST repos/.../actions/jobs/<id>/rerun`
  for arg in "$@"; do
    case "${arg}" in
      */rerun)
        cat "${MOCK_DIR}/rerun_stderr" >&2 2>/dev/null || true
        exit "$(cat "${MOCK_DIR}/rerun_exit")"
        ;;
    esac
  done

  # Find the path argument (first non-flag, non -X-value token after "api").
  path=''
  skip_next=0
  for arg in "${@:2}"; do
    if [ "${skip_next}" = 1 ]; then
      skip_next=0
      continue
    fi
    case "${arg}" in
      -X) skip_next=1 ;;
      --jq) skip_next=1 ;;
      -*) ;;
      *) path="${arg}"; break ;;
    esac
  done

  case "${path}" in
    */actions/runs\?*)
      # CAUGHT LIVE (independent deep-dive verification, 2026-08-17): this
      # used to always serve the SAME runs.json regardless of the head_sha=
      # query param, which made every head-mismatch test structurally unable
      # to prove WHICH head's job actually got rerun -- mutation testing
      # showed reintroducing the exact "rerun against the stale head" bug
      # still passed 31/31. Parse head_sha= out of the path and, if a
      # per-head fixture exists, serve THAT one instead -- so a test can
      # assert the rerun targeted the run/job specific to the NEW head, not
      # whatever the mock happens to always return.
      head_sha_param="$(printf '%s' "${path}" | grep -oE 'head_sha=[0-9a-fA-F]+' | cut -d= -f2)"
      if [ -n "${head_sha_param}" ] && [ -f "${MOCK_DIR}/runs_${head_sha_param}.json" ]; then
        jq -r "${jq_filter}" "${MOCK_DIR}/runs_${head_sha_param}.json"
      else
        jq -r "${jq_filter}" "${MOCK_DIR}/runs.json"
      fi
      exit 0
      ;;
    */jobs\?*)
      # Same fix, keyed by run_id this time: .../actions/runs/<run_id>/jobs
      run_id_param="$(printf '%s' "${path}" | grep -oE '/runs/[0-9]+/jobs' | grep -oE '[0-9]+')"
      if [ -n "${run_id_param}" ] && [ -f "${MOCK_DIR}/jobs_${run_id_param}.json" ]; then
        jq -r "${jq_filter}" "${MOCK_DIR}/jobs_${run_id_param}.json"
      else
        jq -r "${jq_filter}" "${MOCK_DIR}/jobs.json"
      fi
      exit 0
      ;;
    */issues/*/comments\?*)
      # comments_exit=1 simulates a total failure (no output at all).
      # comments_exit=2 simulates a PARTIAL pagination failure: `gh
      # --paginate` printed an earlier page to stdout, then a LATER page
      # failed — non-empty output, non-zero exit. Both must be treated as
      # "the fetch failed", never as "here is the complete list".
      exit_code="$(cat "${MOCK_DIR}/comments_exit" 2>/dev/null || echo 0)"
      if [ "${exit_code}" = "1" ]; then
        echo "mock gh: simulated total transient failure" >&2
        exit 1
      fi
      if [ "${exit_code}" = "2" ]; then
        cat "${MOCK_DIR}/comments_partial.json" 2>/dev/null || true
        echo "mock gh: simulated partial-pagination failure (later page errored)" >&2
        exit 1
      fi
      # No --jq on this call in the real script (parsed in bash instead), so
      # serve the raw fixture, same convention as `pr view` with no --jq.
      cat "${MOCK_DIR}/comments.json"
      exit 0
      ;;
  esac
  echo "mock gh: unhandled api path: ${path}" >&2
  exit 99
fi

echo "mock gh: unhandled invocation: $*" >&2
exit 99
MOCK
  chmod +x "${WORKDIR}/bin/gh"
}

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

run_script() {
  MOCK_DIR="${WORKDIR}/mock"
  set +e
  LAST_OUTPUT=$(
    PATH="${WORKDIR}/bin:${PATH}" \
    MOCK_DIR="${MOCK_DIR}" \
    REPO="${TEST_REPO:-}" \
    PR_NUMBER="${TEST_PR_NUMBER:-}" \
    bash "${SCRIPT}" "$@" 2>&1
  )
  LAST_RC=$?
  set -e
}

new_mock() {
  MOCK_DIR="${WORKDIR}/mock"
  rm -rf "${MOCK_DIR}"
  mkdir -p "${MOCK_DIR}"
  write_default_fixtures
}

check() {
  local desc="$1" expect_rc="$2" expect_substr="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "${LAST_RC}" -ne "${expect_rc}" ]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL: %s\n  expected exit %s, got %s\n  output: %s\n' \
      "${desc}" "${expect_rc}" "${LAST_RC}" "${LAST_OUTPUT}"
    return
  fi
  if [ -n "${expect_substr}" ] && [[ "${LAST_OUTPUT}" != *"${expect_substr}"* ]]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL: %s\n  expected output to contain: %s\n  actual output: %s\n' \
      "${desc}" "${expect_substr}" "${LAST_OUTPUT}"
    return
  fi
  printf 'PASS: %s\n' "${desc}"
}

check_call_logged() {
  local desc="$1" needle="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if grep -qF "${needle}" "${MOCK_DIR}/calls.log" 2>/dev/null; then
    printf 'PASS: %s\n' "${desc}"
  else
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf 'FAIL: %s\n  calls.log:\n%s\n' "${desc}" "$(cat "${MOCK_DIR}/calls.log" 2>/dev/null)"
  fi
}

install_mock_gh
TEST_REPO='AgentWebPro/agentweb'
TEST_PR_NUMBER='2427'

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

MOCK_DIR="${WORKDIR}/mock"
TEST_REPO=''
run_script
check 'missing REPO fails loudly and names the variable' 1 'REPO'

TEST_REPO='AgentWebPro/agentweb'
TEST_PR_NUMBER=''
run_script
check 'missing PR_NUMBER fails loudly and names the variable' 1 'PR_NUMBER'

TEST_PR_NUMBER='2427'
new_mock
run_script
check 'happy path posts the comment AND re-runs the gate job' 0 "re-ran 'Require Greptile Review'"
check_call_logged 'the comment carries the @greptileai mention' '@greptileai'
check_call_logged 'the comment carries the per-head request marker' \
  "greptile-request-review: head=${HEAD_SHA}"
check_call_logged "the rerun POST targets the resolved job id (${JOB_ID})" \
  "actions/jobs/${JOB_ID}/rerun"

# This is the entire point of the redesign: the comment alone is not success.
new_mock
echo 1 >"${MOCK_DIR}/rerun_exit"
run_script
check 'a rerun failure fails loudly even though the comment posted fine' 1 \
  'GREPTILE_REQUEST_REVIEW_FAILED'
check_call_logged 'the comment was still posted before the rerun failed' \
  'pr comment 2427'

# Verified live against PR #2427: GitHub 403s a single-job rerun while the
# parent run still has other jobs in_progress (the greptile job itself was
# long completed/failed; the backend Jest pair was not). That is a retryable
# "not yet", not a real failure — must be exit 2, not exit 1, and must not
# print GREPTILE_REQUEST_REVIEW_FAILED (that string means "something is
# actually broken", which this is not).
new_mock
echo 1 >"${MOCK_DIR}/rerun_exit"
echo 'gh: The workflow run containing this job is already running (HTTP 403)' >"${MOCK_DIR}/rerun_stderr"
run_script
check 'a run-still-in-progress rerun refusal exits 2 (retryable), not 1' 2 \
  'retry with'
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "${LAST_OUTPUT}" == *'GREPTILE_REQUEST_REVIEW_FAILED'* ]]; then
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  a retryable "still running" state must not read as a hard failure\n  output: %s\n' \
    'the retryable case is not reported as GREPTILE_REQUEST_REVIEW_FAILED' "${LAST_OUTPUT}"
else
  printf 'PASS: %s\n' 'the retryable case is not reported as GREPTILE_REQUEST_REVIEW_FAILED'
fi

# ENG-1282 fix: a retry after the retryable "still running" case must use
# --rerun-only, or it silently pays for a second @greptileai review of the
# same head. Verify --rerun-only skips the comment post entirely.
new_mock
run_script --rerun-only
check '--rerun-only re-runs the gate job without posting a comment' 0 \
  "re-ran 'Require Greptile Review'"
TESTS_RUN=$((TESTS_RUN + 1))
if grep -qF 'pr comment' "${MOCK_DIR}/calls.log" 2>/dev/null; then
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  --rerun-only must not post a review request\n  calls.log:\n%s\n' \
    '--rerun-only skips the comment post' "$(cat "${MOCK_DIR}/calls.log")"
else
  printf 'PASS: %s\n' '--rerun-only skips the comment post'
fi
check_call_logged '--rerun-only still targets the resolved job id' \
  "actions/jobs/${JOB_ID}/rerun"

# Caught live by Greptile (4/5) reviewing the exit-2 fix itself: a push
# between the original request and a `--rerun-only` retry means no request
# marker exists for the current head — nobody ever asked for a review of it.
# Blindly rerunning the gate would poll for a review that will never arrive.
# Must fail loudly (exit 1) and must NOT attempt the rerun.
new_mock
marker_comment_for 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' >"${MOCK_DIR}/comments.json"
run_script --rerun-only
check '--rerun-only for a head with no matching marker fails loudly, not a silent rerun' 1 \
  'the head changed since the original request'
TESTS_RUN=$((TESTS_RUN + 1))
if grep -qF 'jobs/' "${MOCK_DIR}/calls.log" 2>/dev/null; then
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  a stale --rerun-only must not touch the jobs API at all\n  calls.log:\n%s\n' \
    'stale --rerun-only never attempts a rerun' "$(cat "${MOCK_DIR}/calls.log")"
else
  printf 'PASS: %s\n' 'stale --rerun-only never attempts a rerun'
fi

# Same failure mode when no request was ever made at all (e.g. the very
# first exit-2 happened before this script ever ran successfully).
new_mock
echo '[]' >"${MOCK_DIR}/comments.json"
run_script --rerun-only
check '--rerun-only with no comments at all fails loudly, not a silent rerun' 1 \
  'the head changed since the original request'

# THE core fix, caught live by Greptile a SECOND time on the same PR: the
# request has posted but Greptile has not answered yet — no "Last reviewed
# commit" verdict has landed, only the plain request marker exists. The
# earlier (wrong) fix checked the verdict footer and would treat this
# in-flight state as "stale", triggering a needless duplicate request. The
# marker-based check must treat "requested, pending" the same as
# "requested, landed" — both mean skip the comment and just rerun.
new_mock
marker_comment_for "${HEAD_SHA}" >"${MOCK_DIR}/comments.json"
run_script --rerun-only
check '--rerun-only succeeds on a PENDING request with no landed verdict yet' 0 \
  "re-ran 'Require Greptile Review'"
TESTS_RUN=$((TESTS_RUN + 1))
if grep -qF 'pr comment' "${MOCK_DIR}/calls.log" 2>/dev/null; then
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  a pending (unanswered) request must not be treated as absent\n  calls.log:\n%s\n' \
    '--rerun-only does not re-request when the answer is merely pending' "$(cat "${MOCK_DIR}/calls.log")"
else
  printf 'PASS: %s\n' '--rerun-only does not re-request when the answer is merely pending'
fi

# CAUGHT LIVE (Greptile 3/5, portal#1035) — and then reproduced for real by
# this session's own transient DNS failure mid-dogfood: a lookup FAILURE
# (the GitHub API call erroring) must not read the same as a CONFIRMED
# absence. The old code returned 1 either way, and main() told the caller
# to post a duplicate paid request on a network blip that had nothing to do
# with whether a request actually existed. Must fail loudly with a message
# that does NOT recommend posting a fresh request.
new_mock
echo 1 >"${MOCK_DIR}/comments_exit"
run_script --rerun-only
check '--rerun-only on a transient lookup failure fails loudly, distinct from "absent"' 1 \
  'could not confirm whether a request exists'
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "${LAST_OUTPUT}" == *'Re-run WITHOUT --rerun-only'* ]] || [[ "${LAST_OUTPUT}" == *'head changed since the original request'* ]]; then
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  a lookup failure must not be advised the same way as a confirmed-absent marker\n  output: %s\n' \
    'a transient lookup failure is never advised as "post a duplicate"' "${LAST_OUTPUT}"
else
  printf 'PASS: %s\n' 'a transient lookup failure is never advised as "post a duplicate"'
fi
TESTS_RUN=$((TESTS_RUN + 1))
if grep -qF 'jobs/' "${MOCK_DIR}/calls.log" 2>/dev/null; then
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  a lookup failure must not proceed to the rerun API\n' \
    'no rerun attempted after a transient lookup failure'
else
  printf 'PASS: %s\n' 'no rerun attempted after a transient lookup failure'
fi

# CAUGHT LIVE A SECOND TIME (Greptile 4/5, agentweb#2427, reviewing the fix
# above): a PARTIAL pagination failure is a different shape than a total
# one -- `gh --paginate` can print an earlier page's real comments to
# stdout, THEN fail fetching a later page. Non-empty output, non-zero
# exit. The old fix only checked "is the output empty" and would have
# treated this truncated (but non-empty) list as the complete one --
# searched it, found no marker on the missing later page, and returned a
# false "confirmed absent". Must be treated exactly like a total failure:
# retryable, never a confirmed negative.
new_mock
echo 2 >"${MOCK_DIR}/comments_exit"
marker_comment_for 'cccccccccccccccccccccccccccccccccccccccc' >"${MOCK_DIR}/comments_partial.json"
run_script --rerun-only
check 'a PARTIAL pagination failure (non-empty output, non-zero exit) is treated as a failure, not a confirmed-absent marker' 1 \
  'could not confirm whether a request exists'
TESTS_RUN=$((TESTS_RUN + 1))
if [[ "${LAST_OUTPUT}" == *'Re-run WITHOUT --rerun-only'* ]] || [[ "${LAST_OUTPUT}" == *'head changed since the original request'* ]]; then
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  a partial-pagination failure must not be advised as "post a duplicate"\n  output: %s\n' \
    'a partial pagination failure is never advised as "post a duplicate"' "${LAST_OUTPUT}"
else
  printf 'PASS: %s\n' 'a partial pagination failure is never advised as "post a duplicate"'
fi

# Caught live by Greptile (4/5) a THIRD time on this same PR (portal#1035):
# head_sha is resolved once and reused unchecked to pick which run's gate
# job to rerun. If the PR head changes between the initial resolve (used to
# post the request) and the rerun call, the request may not cover whatever
# gets rerun.
NEW_HEAD_SHA='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

# CAUGHT LIVE A SIXTH TIME (Greptile 4/5, agentweb#2427, THREE findings
# reviewing the "defer to the gate's poll loop" fix): that design assumed
# the original request either resolves against the new head, or never
# resolves at all (timing out to UNAVAILABLE, the documented recovery
# signal). Greptile found the real third case it missed — the original
# request resolving against the OLD head — which makes greptile-gate.sh
# report REFUSED instead of UNAVAILABLE, with no working recovery signal. A
# second, independent finding on the same commit: the exit-2 `--rerun-only`
# retry path assumed a marker would exist for the new head, which that
# design deliberately never posted.
#
# The fix: stop trying to infer what an un-pinned mention will resolve
# against. On ANY head mismatch, request AND rerun the new head explicitly
# — the exact same two calls a clean run makes, just retargeted. This is
# deterministic, so every downstream recovery path (the exit-2 retry
# included) has exactly the state it expects. Accepted cost, on purpose: if
# the original request ALSO resolves against this same new head, that's a
# second, redundant review in an already-rare race — a wasted credit, not a
# correctness bug.
# A run/job fixture keyed to NEW_HEAD_SHA specifically, DISTINCT from
# HEAD_SHA's (JOB_ID) -- this is what makes the assertion below able to
# actually catch a regression. Under the old mock (one shared runs.json/
# jobs.json regardless of head_sha=), reintroducing the exact "rerun against
# the stale head" bug this test is named for still passed 31/31, because the
# mock returned JOB_ID either way.
NEW_RUN_ID='31962373999'
NEW_JOB_ID='95202299999'
new_mock
printf '%s\n%s\n' "${HEAD_SHA}" "${NEW_HEAD_SHA}" >"${MOCK_DIR}/pull_sha_sequence.txt"
cat >"${MOCK_DIR}/runs_${NEW_HEAD_SHA}.json" <<EOF
{"workflow_runs": [
  {"id": ${NEW_RUN_ID}, "run_number": 3, "name": "Tests", "head_sha": "${NEW_HEAD_SHA}"}
]}
EOF
cat >"${MOCK_DIR}/jobs_${NEW_RUN_ID}.json" <<EOF
{"jobs": [
  {"id": ${NEW_JOB_ID}, "name": "Require Greptile Review"}
]}
EOF
run_script
check 'a head change explicitly requests AND reruns the gate for the NEW head, deterministically' 0 \
  "re-ran 'Require Greptile Review'"
check_call_logged 'the request comment was posted for the NEW head, not the stale one' \
  "greptile-request-review: head=${NEW_HEAD_SHA}"
# Deliberately TWO comments here, not one: the original head's request was
# already posted by main()'s normal flow before the mismatch was detected,
# and the mismatch branch explicitly posts a second, targeted request for
# the new head — that's the accepted cost documented above, not a bug.
TESTS_RUN=$((TESTS_RUN + 1))
if [ "$(grep -cF 'pr comment' "${MOCK_DIR}/calls.log" 2>/dev/null || echo 0)" = "2" ]; then
  printf 'PASS: %s\n' 'two review requests were posted — the original head, then explicitly the new head (the accepted cost)'
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  calls.log:\n%s\n' 'two review requests were posted — the original head, then explicitly the new head (the accepted cost)' \
    "$(cat "${MOCK_DIR}/calls.log")"
fi
# THE assertion that used to be vacuous: targets NEW_JOB_ID specifically,
# not the shared JOB_ID constant. A regression that reruns the STALE head's
# job (JOB_ID) instead of the new head's (NEW_JOB_ID) now genuinely fails
# this check, rather than passing by coincidence because both fixtures used
# to be the same file.
check_call_logged 'the gate was rerun against the NEW head''s own job id, not the stale head''s' \
  "actions/jobs/${NEW_JOB_ID}/rerun"
TESTS_RUN=$((TESTS_RUN + 1))
if grep -qF "actions/jobs/${JOB_ID}/rerun" "${MOCK_DIR}/calls.log" 2>/dev/null; then
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  the stale head''s job id (%s) was reran instead of the new head''s (%s)\n  calls.log:\n%s\n' \
    'the STALE head''s job id must never be the one rerun' "${JOB_ID}" "${NEW_JOB_ID}" "$(cat "${MOCK_DIR}/calls.log")"
else
  printf 'PASS: %s\n' 'the stale head''s job id was never the one rerun'
fi

# The head-mismatch recovery reuses post_review_request and rerun_gate_job
# directly, so their own existing failure-mode tests (comment-post failure,
# no matching run, no matching job, the exit-2 retryable rerun case) already
# cover this path's failure modes without needing separate mismatch-specific
# duplicates of each.

new_mock
echo 1 >"${MOCK_DIR}/comment_exit"
run_script
check 'a comment-post failure fails loudly and never reaches the rerun step' 1 \
  'GREPTILE_REQUEST_REVIEW_FAILED'
TESTS_RUN=$((TESTS_RUN + 1))
if grep -qF 'jobs/' "${MOCK_DIR}/calls.log"; then
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: %s\n  the script called the jobs API despite the comment failing\n' \
    'no rerun attempted after a failed comment post'
else
  printf 'PASS: %s\n' 'no rerun attempted after a failed comment post'
fi

# If the workflow run for the current head can't be found (e.g. it hasn't
# started yet, or the head SHA changed underneath us), this must fail loudly
# — a silently skipped rerun is the dangerous case this script exists to
# prevent (a real 5/5 sitting unread behind a stale required check).
new_mock
cat >"${MOCK_DIR}/runs.json" <<'EOF'
{"workflow_runs": []}
EOF
run_script
check 'no matching workflow run fails loudly, not silently' 1 \
  'could not find a'

new_mock
cat >"${MOCK_DIR}/jobs.json" <<'EOF'
{"jobs": [{"id": 1, "name": "Detect changed projects"}]}
EOF
run_script
check 'no matching job in the run fails loudly, not silently' 1 \
  "could not find the 'Require Greptile Review' job"

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
