#!/usr/bin/env bash
#
# Answer one question: can `main` deploy right now? (ENG-837)
#
# Why this exists
# ---------------
# On 2026-08-01 PR #2237 merged at 07:50Z. Its production deploy failed at
# 07:53Z. Nothing alerted, and production stayed undeployable for ~17 hours
# while at least two more PRs merged onto that trunk — each queuing another
# doomed deploy behind the same wall. It was found only because an agent
# happened to read `gh run list` for an unrelated reason.
#
# The merge gate in autonomous-execution-and-merge.md interrogates the PR
# exhaustively: base currency, CI, Greptile, staging, attribution, complexity.
# It never asks whether the DESTINATION can currently ship. ENG-757 closed the
# "did this PR's checks really run?" hole; this closes the complementary one.
# Per-PR evidence is necessary and not sufficient.
#
# Two modes
# ---------
#   (report, default)     Print the trunk's deploy state and exit 0. Safe for
#                         monitoring: a broken trunk is data, not a crash.
#   --require-deployable  Enforce. A trunk that is not provably deployable
#                         exits non-zero and names the run that broke it.
#
# Fail-closed, deliberately
# -------------------------
# UNKNOWN — no Deploy runs, an unreadable payload, a `gh` that errors — blocks
# under --require-deployable. This inherits merge-evidence.sh's rule verbatim:
# absence of failure is not evidence of success. There is no path from "I could
# not measure the trunk" to "the trunk is fine".
#
# The override
# ------------
# A fix FOR the broken deploy must be mergeable, or the gate deadlocks the very
# repair it is waiting for. TRUNK_DEPLOY_OVERRIDE_REASON supplies that escape,
# and it must be non-empty: requiring a written reason is what keeps this a
# decision rather than a flag someone exports once and forgets.
#
# Environment:
#   TRUNK_REPO                    default AgentWebPro/agentweb
#   TRUNK_BRANCH                  default main
#   TRUNK_DEPLOY_WORKFLOW         default Deploy
#   TRUNK_DEPLOY_LOOKBACK         runs to inspect, default 20
#   TRUNK_DEPLOY_OVERRIDE_REASON  non-empty text unblocks --require-deployable
#   TRUNK_HEAD_SHA                override the resolved trunk head (testing)
#
# Exit status:
#   0  DEPLOYABLE, or report mode, or an accepted override
#   1  BLOCKED under --require-deployable
#   2  UNKNOWN under --require-deployable (fail-closed)

set -uo pipefail

TRUNK_REPO="${TRUNK_REPO:-AgentWebPro/agentweb}"
TRUNK_BRANCH="${TRUNK_BRANCH:-main}"
TRUNK_DEPLOY_WORKFLOW="${TRUNK_DEPLOY_WORKFLOW:-Deploy}"
TRUNK_DEPLOY_LOOKBACK="${TRUNK_DEPLOY_LOOKBACK:-20}"
TRUNK_DEPLOY_OVERRIDE_REASON="${TRUNK_DEPLOY_OVERRIDE_REASON:-}"

REQUIRE_DEPLOYABLE=0
for arg in "$@"; do
  case "${arg}" in
    --require-deployable) REQUIRE_DEPLOYABLE=1 ;;
    -h | --help)
      sed -n '2,48p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "trunk-deploy-state: unknown argument '${arg}'" >&2
      exit 64
      ;;
  esac
done

# Emitted as key=value lines so a caller can grep them without parsing prose.
# Every field is always printed, even when empty, so a consumer never has to
# distinguish "absent" from "empty".
STATE='UNKNOWN'
REASON=''
RUN_URL=''
RUN_ID=''
CONCLUSION=''
IN_FLIGHT='false'
RUN_HEAD_SHA=''
HEAD_SHA_MATCHES_TRUNK='false'

emit() {
  printf 'state=%s\n' "${STATE}"
  printf 'reason=%s\n' "${REASON}"
  printf 'run_id=%s\n' "${RUN_ID}"
  printf 'run_url=%s\n' "${RUN_URL}"
  printf 'conclusion=%s\n' "${CONCLUSION}"
  printf 'in_flight=%s\n' "${IN_FLIGHT}"
  printf 'run_head_sha=%s\n' "${RUN_HEAD_SHA}"
  printf 'trunk_head_sha=%s\n' "${TRUNK_HEAD_SHA:-}"
  printf 'head_sha_matches_trunk=%s\n' "${HEAD_SHA_MATCHES_TRUNK}"
  printf 'repo=%s\n' "${TRUNK_REPO}"
  printf 'branch=%s\n' "${TRUNK_BRANCH}"
}

finish() {
  emit

  if [ "${REQUIRE_DEPLOYABLE}" -eq 0 ]; then
    exit 0
  fi

  if [ "${STATE}" = 'DEPLOYABLE' ]; then
    exit 0
  fi

  # The override applies to BLOCKED and UNKNOWN alike: both mean "not provably
  # shippable", and the repair PR needs through either way.
  if [ -n "${TRUNK_DEPLOY_OVERRIDE_REASON}" ]; then
    printf 'override=%s\n' "${TRUNK_DEPLOY_OVERRIDE_REASON}"
    echo "[trunk-deploy-state] OVERRIDDEN: trunk is ${STATE} but an explicit reason was supplied." >&2
    echo "[trunk-deploy-state] reason: ${TRUNK_DEPLOY_OVERRIDE_REASON}" >&2
    exit 0
  fi

  echo "::error::TRUNK_NOT_DEPLOYABLE: ${TRUNK_REPO}@${TRUNK_BRANCH} is ${STATE}. ${REASON}" >&2
  echo "[trunk-deploy-state] TRUNK_NOT_DEPLOYABLE: ${STATE} — ${REASON}" >&2
  if [ -n "${RUN_URL}" ]; then
    echo "[trunk-deploy-state] offending run: ${RUN_URL}" >&2
  fi
  echo "[trunk-deploy-state] To merge a fix for this anyway, set TRUNK_DEPLOY_OVERRIDE_REASON." >&2

  if [ "${STATE}" = 'BLOCKED' ]; then
    exit 1
  fi
  exit 2
}

# Captured separately from the assignment: under `set -uo pipefail` a command
# substitution's status is only readable on its own line.
RUNS="$(gh run list \
  --repo "${TRUNK_REPO}" \
  --branch "${TRUNK_BRANCH}" \
  --workflow "${TRUNK_DEPLOY_WORKFLOW}" \
  --limit "${TRUNK_DEPLOY_LOOKBACK}" \
  --json databaseId,status,conclusion,url,headSha 2>&1)"
GH_STATUS=$?

if [ "${GH_STATUS}" -ne 0 ]; then
  REASON="could not list ${TRUNK_DEPLOY_WORKFLOW} runs for ${TRUNK_REPO}@${TRUNK_BRANCH}. gh reported: ${RUNS}"
  finish
fi

if ! printf '%s' "${RUNS}" | jq -e 'type == "array"' >/dev/null 2>&1; then
  REASON="the ${TRUNK_DEPLOY_WORKFLOW} run list for ${TRUNK_REPO}@${TRUNK_BRANCH} was not readable as JSON."
  finish
fi

# An in-flight run is reported but never decides. A deploy currently running
# proves nothing yet, and treating it as reassurance is precisely how merges
# kept stacking onto a broken trunk on 2026-08-01.
if printf '%s' "${RUNS}" | jq -e '[.[] | select(.status != "completed")] | length > 0' >/dev/null 2>&1; then
  IN_FLIGHT='true'
fi

# Bind the verdict to a commit, not just to recency.
#
# `gh run list` orders by creation time, so a run created earlier but finishing
# later does not displace a newer one — the ordering alone is sound. What it
# cannot express is *which commit* the verdict describes. A re-run of an old
# deploy, or a branch that was reset, produces a newest-completed run whose
# `headSha` is not on the current trunk at all, and the gate would then report
# on a different line of history while sounding authoritative.
#
# So: a completed run for the CURRENT trunk head wins outright. Otherwise fall
# back to newest-completed and say plainly that the verdict is older than the
# trunk, which is normal (main moves faster than deploys) but must be visible
# rather than implied.
TRUNK_HEAD_SHA="${TRUNK_HEAD_SHA:-}"
if [ -z "${TRUNK_HEAD_SHA}" ]; then
  # Non-fatal: without it the gate still works, it just cannot claim SHA match.
  TRUNK_HEAD_SHA="$(gh api "repos/${TRUNK_REPO}/commits/${TRUNK_BRANCH}" -q '.sha' 2>/dev/null || printf '')"
fi

LATEST=''
if [ -n "${TRUNK_HEAD_SHA}" ]; then
  LATEST="$(printf '%s' "${RUNS}" \
    | jq -c --arg sha "${TRUNK_HEAD_SHA}" \
      '[.[] | select(.status == "completed") | select((.headSha // "") == $sha)][0] // empty' 2>/dev/null)"
  [ -n "${LATEST}" ] && HEAD_SHA_MATCHES_TRUNK='true'
fi

if [ -z "${LATEST}" ]; then
  LATEST="$(printf '%s' "${RUNS}" | jq -c '[.[] | select(.status == "completed")][0] // empty' 2>/dev/null)"
fi

if [ -z "${LATEST}" ]; then
  REASON="no completed ${TRUNK_DEPLOY_WORKFLOW} run found on ${TRUNK_REPO}@${TRUNK_BRANCH}, so deployability is unproven."
  finish
fi

RUN_ID="$(printf '%s' "${LATEST}" | jq -r '.databaseId // ""')"
RUN_URL="$(printf '%s' "${LATEST}" | jq -r '.url // ""')"
CONCLUSION="$(printf '%s' "${LATEST}" | jq -r '.conclusion // ""')"
RUN_HEAD_SHA="$(printf '%s' "${LATEST}" | jq -r '.headSha // ""')"

SHA_NOTE=''
if [ "${HEAD_SHA_MATCHES_TRUNK}" != 'true' ]; then
  if [ -z "${TRUNK_HEAD_SHA}" ]; then
    SHA_NOTE=" Could not resolve ${TRUNK_BRANCH}'s head commit, so this verdict is not bound to a specific commit."
  else
    SHA_NOTE=" This verdict describes commit ${RUN_HEAD_SHA:-unknown}, not the current ${TRUNK_BRANCH} head ${TRUNK_HEAD_SHA}."
  fi
fi

case "${CONCLUSION}" in
  success)
    STATE='DEPLOYABLE'
    REASON="the most recent completed ${TRUNK_DEPLOY_WORKFLOW} run on ${TRUNK_BRANCH} succeeded.${SHA_NOTE}"
    ;;
  '' | null)
    REASON="the most recent completed ${TRUNK_DEPLOY_WORKFLOW} run (${RUN_ID}) reported no conclusion."
    ;;
  *)
    # failure, cancelled, timed_out, startup_failure, action_required, neutral.
    # Only `success` means the trunk shipped. A cancelled deploy never reached
    # production, so counting it as fine is how a trunk goes quietly unshipped.
    STATE='BLOCKED'
    REASON="the most recent completed ${TRUNK_DEPLOY_WORKFLOW} run on ${TRUNK_BRANCH} ended '${CONCLUSION}', so ${TRUNK_BRANCH} is not known to be deployable.${SHA_NOTE}"
    ;;
esac

finish
