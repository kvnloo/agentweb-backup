#!/usr/bin/env bash
#
# Resolve the git SHA to diff against for this Deploy run's paths-filter
# (ENG-2170).
#
# The problem
# -----------
# `dorny/paths-filter` on a `push` event with no `base` compares only against
# `github.event.before` -- the ONE commit immediately preceding this push.
# That is the wrong base whenever an earlier Deploy run never got to make its
# own comparison: `concurrency: { group: deploy-production }` keeps only one
# PENDING run in the queue, so a merge that lands while a deploy is already
# pending cancels that older pending run *before `detect-changes` ever runs*.
# The next run that does execute only diffs against ITS OWN previous commit,
# so whatever the cancelled run would have caught is never compared against
# again. A component whose only change sat in the cancelled run's diff is
# silently never deployed -- it waits for some unrelated later merge to
# happen to also touch the same paths.
#
# The fix
# -------
# Diff against the head SHA of the most recent PRIOR Deploy run whose
# `detect-changes` job actually completed. That run's filter step (or the
# workflow_dispatch fallback, which deploys everything) correctly decided
# what needed deploying as of its head, so resuming the comparison from there
# is correct by induction -- regardless of whether backend-deploy or
# partner-deploy themselves later succeeded, failed, or were skipped by the
# filter. A run whose own `detect-changes` job never completed (queued and
# then cancelled, or failed outright) is walked past, because in either case
# its own comparison never happened either -- exactly the gap this closes.
#
# Fail-safe
# ---------
# If no such run is found within the lookback window, or the GitHub API is
# unreachable, this prints `resolved=false` and the caller must deploy BOTH
# components unconditionally. A redundant deploy is cheap and idempotent; a
# silently skipped one is the bug this script exists to close.
#
# Usage:
#   GH_TOKEN=... bash deploy-base-sha.sh
#
# Output (appended to $GITHUB_OUTPUT if set, and always echoed to stdout):
#   resolved=true|false
#   base_sha=<sha>          (empty when resolved=false)
#
# Environment:
#   DEPLOY_REPO              default AgentWebPro/agentweb
#   DEPLOY_WORKFLOW          default Deploy
#   DEPLOY_BRANCH            default main
#   DEPLOY_BASE_LOOKBACK     prior runs to inspect, default 20
#   DEPLOY_DETECT_JOB_NAME   default "Detect changed projects"
#   DEPLOY_CURRENT_RUN_ID    exclude this run id from consideration (defaults
#                            to $GITHUB_RUN_ID; override for local testing)

set -uo pipefail

DEPLOY_REPO="${DEPLOY_REPO:-AgentWebPro/agentweb}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-Deploy}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_BASE_LOOKBACK="${DEPLOY_BASE_LOOKBACK:-20}"
DEPLOY_DETECT_JOB_NAME="${DEPLOY_DETECT_JOB_NAME:-Detect changed projects}"
DEPLOY_CURRENT_RUN_ID="${DEPLOY_CURRENT_RUN_ID:-${GITHUB_RUN_ID:-}}"

RESOLVED='false'
BASE_SHA=''

emit() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      printf 'resolved=%s\n' "${RESOLVED}"
      printf 'base_sha=%s\n' "${BASE_SHA}"
    } >>"${GITHUB_OUTPUT}"
  fi
  printf 'resolved=%s\n' "${RESOLVED}"
  printf 'base_sha=%s\n' "${BASE_SHA}"
}

# Captured separately from the assignment: under `set -uo pipefail` a command
# substitution's status is only readable on its own line.
RUNS="$(gh run list \
  --repo "${DEPLOY_REPO}" \
  --branch "${DEPLOY_BRANCH}" \
  --workflow "${DEPLOY_WORKFLOW}" \
  --limit "${DEPLOY_BASE_LOOKBACK}" \
  --json databaseId,status,headSha 2>&1)"
GH_STATUS=$?

if [ "${GH_STATUS}" -ne 0 ] || ! printf '%s' "${RUNS}" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "[deploy-base-sha] could not list ${DEPLOY_WORKFLOW} runs for ${DEPLOY_REPO}@${DEPLOY_BRANCH}: ${RUNS}" >&2
  emit
  exit 0
fi

# Newest first, exactly as `gh run list` returns it. The in-progress run this
# script is itself running inside of is excluded explicitly rather than relying
# on `status != completed` alone, in case a retry or a race leaves it briefly
# reporting `completed` before this step observes it.
CANDIDATES="$(printf '%s' "${RUNS}" | jq -r --arg cur "${DEPLOY_CURRENT_RUN_ID}" \
  '[.[] | select(.status == "completed") | select((.databaseId | tostring) != $cur)] | .[] | .databaseId')"

if [ -z "${CANDIDATES}" ]; then
  echo "[deploy-base-sha] no completed prior ${DEPLOY_WORKFLOW} runs found on ${DEPLOY_BRANCH} within the last ${DEPLOY_BASE_LOOKBACK}." >&2
  emit
  exit 0
fi

while IFS= read -r run_id; do
  [ -z "${run_id}" ] && continue

  JOBS="$(gh api "repos/${DEPLOY_REPO}/actions/runs/${run_id}/jobs" 2>/dev/null)"
  if [ -z "${JOBS}" ] || ! printf '%s' "${JOBS}" | jq -e '.jobs? // empty' >/dev/null 2>&1; then
    echo "[deploy-base-sha] could not read jobs for run ${run_id}, skipping." >&2
    continue
  fi

  CONCLUSION="$(printf '%s' "${JOBS}" | jq -r --arg name "${DEPLOY_DETECT_JOB_NAME}" \
    '[.jobs[] | select(.name == $name)][0].conclusion // ""')"

  if [ "${CONCLUSION}" = 'success' ]; then
    SHA="$(printf '%s' "${RUNS}" | jq -r --arg id "${run_id}" \
      '[.[] | select((.databaseId | tostring) == $id)][0].headSha // ""')"
    if [ -n "${SHA}" ]; then
      BASE_SHA="${SHA}"
      RESOLVED='true'
      break
    fi
  fi
done <<EOF
${CANDIDATES}
EOF

if [ "${RESOLVED}" != 'true' ]; then
  echo "[deploy-base-sha] no run in the last ${DEPLOY_BASE_LOOKBACK} completed with a successful '${DEPLOY_DETECT_JOB_NAME}' job; falling back to deploying every component unconditionally." >&2
fi

emit
