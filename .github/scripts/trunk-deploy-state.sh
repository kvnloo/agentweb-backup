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
#   TRUNK_COMMITS                 override trunk history, newest-first (testing)
#   TRUNK_COMMIT_LOOKBACK         trunk commits to walk, default 50
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
TRUNK_COMMIT_LOOKBACK="${TRUNK_COMMIT_LOOKBACK:-50}"
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
# True when the verdict was chosen by walking trunk history rather than by run recency.
COMMIT_RANKED='true'

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
  printf 'commit_ranked=%s\n' "${COMMIT_RANKED}"
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

# Rank candidate runs by COMMIT POSITION ON TRUNK, not by run creation time.
#
# Recency of the *run* is the wrong axis, and this is the defect that survived
# the first fix. `gh run list` orders by creation time, so re-running an old
# commit's deploy today makes that old run the newest completed one. If a newer
# commit's deploy failed in between, the stale success masks it and the gate
# waves a merge onto a trunk that genuinely cannot ship — ENG-837's exact shape.
#
# Ordering by commit instead makes the masking structurally impossible: walk
# trunk history newest-first and take the first commit that has a completed
# deploy. A re-run of an ancestor can never outrank a descendant's failure,
# because the descendant is reached first.
#
# The head commit itself usually has no completed deploy — main advances faster
# than a 12-20 minute deploy — so "no run at HEAD" is the normal steady state,
# not an error. Requiring one would serialise every merge behind a full deploy
# cycle. That may well be the right policy for a repo that ships to production
# on merge, but it is a throughput decision for a human, not something to
# smuggle in via a CI script. What matters here is that the answer describes
# the newest commit that HAS been tested, and says so.
# One call does both jobs: the commit list is trunk history, and its first entry
# IS the head. Resolving the head separately was a redundant API call and an
# extra failure mode — if it failed, history was never fetched at all.
TRUNK_COMMITS="${TRUNK_COMMITS:-}"
if [ -z "${TRUNK_COMMITS}" ]; then
  TRUNK_COMMITS="$(gh api \
    "repos/${TRUNK_REPO}/commits?sha=${TRUNK_BRANCH}&per_page=${TRUNK_COMMIT_LOOKBACK}" \
    -q '.[].sha' 2>/dev/null || printf '')"
fi

TRUNK_HEAD_SHA="${TRUNK_HEAD_SHA:-}"
if [ -z "${TRUNK_HEAD_SHA}" ] && [ -n "${TRUNK_COMMITS}" ]; then
  TRUNK_HEAD_SHA="$(printf '%s\n' "${TRUNK_COMMITS}" | head -n 1)"
fi

LATEST=''
if [ -n "${TRUNK_COMMITS}" ]; then
  while IFS= read -r commit; do
    [ -z "${commit}" ] && continue
    LATEST="$(printf '%s' "${RUNS}" \
      | jq -c --arg sha "${commit}" \
        '[.[] | select(.status == "completed") | select((.headSha // "") == $sha)][0] // empty' 2>/dev/null)"
    if [ -n "${LATEST}" ]; then
      [ "${commit}" = "${TRUNK_HEAD_SHA}" ] && HEAD_SHA_MATCHES_TRUNK='true'
      break
    fi
  done <<EOF
${TRUNK_COMMITS}
EOF
fi

# Only when trunk history is unavailable does run-recency get used, and the
# reason then states that the verdict is not commit-ranked.
if [ -z "${LATEST}" ]; then
  LATEST="$(printf '%s' "${RUNS}" | jq -c '[.[] | select(.status == "completed")][0] // empty' 2>/dev/null)"
  COMMIT_RANKED='false'
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
if [ "${COMMIT_RANKED}" != 'true' ]; then
  SHA_NOTE=" Trunk history was unavailable, so this verdict was chosen by run recency and is NOT ranked by commit — a re-run of an older commit could be masking a newer failure."
elif [ "${HEAD_SHA_MATCHES_TRUNK}" != 'true' ]; then
  SHA_NOTE=" This is the newest trunk commit that has a completed deploy (${RUN_HEAD_SHA:-unknown}); the current ${TRUNK_BRANCH} head ${TRUNK_HEAD_SHA:-unknown} has not deployed yet."
fi

# Ranking decides whether the run is evidence about TRUNK at all; the run's
# conclusion decides what that evidence says. Those are separate questions and
# conflating them is what produced the earlier asymmetry.
#
# An unrankable run is not authoritative in EITHER direction. An unrankable
# success might be an ancestor re-run masking a newer failure; an unrankable
# failure might be a run older than the history window, or a commit that was
# force-pushed away, and blaming current trunk for it sends someone hunting a
# problem that is not there. Both are UNKNOWN, and UNKNOWN fails closed under
# enforcement exactly as a missing run or an unreadable payload does — so
# nothing becomes less safe, only less falsely confident.
if [ "${COMMIT_RANKED}" != 'true' ]; then
  STATE='UNKNOWN'
  REASON="a ${TRUNK_DEPLOY_WORKFLOW} run on ${TRUNK_BRANCH} ended '${CONCLUSION:-no conclusion}', but it could not be ranked against trunk history, so it says nothing authoritative about ${TRUNK_BRANCH}.${SHA_NOTE}"
else
  case "${CONCLUSION}" in
    success)
      # A success at an ANCESTOR does not authorize the current head. The head
      # carries commits whose deploy has not been observed, and "the previous
      # commit shipped fine" is exactly the reasoning that let merges stack
      # onto a trunk that could not ship on 2026-08-01.
      #
      # The throughput cost is real and deliberate: after each merge the trunk
      # reads UNKNOWN until that merge's deploy completes, so merges serialise
      # behind deploy verification. On a repo where merging IS deploying to
      # production, that is the behaviour the name --require-deployable claims.
      # TRUNK_DEPLOY_OVERRIDE_REASON remains the documented way through.
      if [ "${HEAD_SHA_MATCHES_TRUNK}" = 'true' ]; then
        STATE='DEPLOYABLE'
        REASON="the current ${TRUNK_BRANCH} head deployed successfully."
      else
        STATE='UNKNOWN'
        REASON="the newest ${TRUNK_BRANCH} commit with a completed ${TRUNK_DEPLOY_WORKFLOW} run succeeded, but that is an ancestor — the current head has not been deployed, so ${TRUNK_BRANCH} is not PROVEN deployable.${SHA_NOTE}"
      fi
      ;;
    '' | null)
      STATE='UNKNOWN'
      REASON="the deciding ${TRUNK_DEPLOY_WORKFLOW} run (${RUN_ID}) reported no conclusion."
      ;;
    *)
      # failure, cancelled, timed_out, startup_failure, action_required, neutral.
      # Only `success` means the trunk shipped. A cancelled deploy never reached
      # production, so counting it as fine is how a trunk goes quietly unshipped.
      STATE='BLOCKED'
      REASON="the newest ${TRUNK_BRANCH} commit with a completed ${TRUNK_DEPLOY_WORKFLOW} run ended '${CONCLUSION}', so ${TRUNK_BRANCH} is not deployable.${SHA_NOTE}"
      ;;
  esac
fi

finish
