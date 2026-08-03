#!/usr/bin/env bash
#
# Tests for .github/scripts/trunk-deploy-state.sh (ENG-837).
#
# `gh` is replaced with a scripted mock on PATH, so every branch runs for real
# without touching GitHub. Run with:
#
#   bash .github/scripts/trunk-deploy-state.test.sh
#
# What this gate is for
# ---------------------
# On 2026-08-01 PR #2237 merged at 07:50Z and its production deploy failed at
# 07:53Z. Nothing noticed. At least two more PRs merged onto that undeployable
# trunk over the following ~17 hours, each queuing another doomed deploy behind
# the same wall, because the merge gate interrogates the PR exhaustively and
# never asks whether the DESTINATION can currently ship.
#
# ENG-757 proved a PR's own checks really executed. This is its complement:
# per-PR evidence is necessary and not sufficient.
#
# The fail-closed rule, inherited deliberately from merge-evidence.sh
# -------------------------------------------------------------------
# "Absence of failure is not evidence of success." A repo with no Deploy runs,
# an unreadable payload, or a `gh` that errors out all yield UNKNOWN — and
# UNKNOWN blocks under --require-deployable. There is no path from "I could not
# measure the trunk" to "the trunk is fine".

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE_SCRIPT="${SCRIPT_DIR}/trunk-deploy-state.sh"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

install_mock_gh() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
MOCK_DIR="${TRUNK_STATE_MOCK_DIR:?TRUNK_STATE_MOCK_DIR must be set}"

if [ "${1:-}" = "run" ] && [ "${2:-}" = "list" ]; then
  code=0
  [ -f "${MOCK_DIR}/runlist_exit" ] && code=$(cat "${MOCK_DIR}/runlist_exit")
  if [ "${code}" != "0" ]; then
    printf 'mock gh: simulated API failure\n' >&2
    exit "${code}"
  fi
  cat "${MOCK_DIR}/runlist.json" 2>/dev/null || printf '[]'
  exit 0
fi

if [ "${1:-}" = "api" ]; then
  # TWO distinct calls share this verb and must not be conflated:
  #   repos/X/commits/BRANCH   -> the head sha        (fixture: trunk_head_sha)
  #   repos/X/commits?sha=...  -> trunk history list  (fixture: trunk_commits)
  # A missing fixture simulates an API failure, which the gate must survive.
  case "${2:-}" in
    *'commits?'*)
      if [ -f "${MOCK_DIR}/trunk_commits" ]; then
        cat "${MOCK_DIR}/trunk_commits"
        exit 0
      fi
      printf 'mock gh: simulated commits-list failure\n' >&2
      exit 1
      ;;
    *)
      if [ -f "${MOCK_DIR}/trunk_head_sha" ]; then
        cat "${MOCK_DIR}/trunk_head_sha"
        exit 0
      fi
      printf 'mock gh: simulated api failure\n' >&2
      exit 1
      ;;
  esac
fi

printf 'mock gh: unexpected invocation: %s\n' "$*" >&2
exit 64
MOCK
  chmod +x "${WORKDIR}/bin/gh"
  PATH="${WORKDIR}/bin:${PATH}"
  export PATH
}

new_fixture_dir() {
  mktemp -d "${WORKDIR}/fixture.XXXXXX"
}

# runlist <dir> <json array of {databaseId,status,conclusion,url,headSha}>
# Newest first, exactly as `gh run list` returns it.
runlist() {
  printf '%s\n' "$2" >"$1/runlist.json"
}

RUN_OK='{"databaseId":30809209797,"status":"completed","conclusion":"success",
         "url":"https://github.com/AgentWebPro/agentweb/actions/runs/30809209797",
         "headSha":"9db4d5947"}'

# The real 2026-08-01 failure: #2237's deploy, which held prod for ~17h.
RUN_FAILED='{"databaseId":30712345678,"status":"completed","conclusion":"failure",
             "url":"https://github.com/AgentWebPro/agentweb/actions/runs/30712345678",
             "headSha":"aa11bb22"}'

RUN_INFLIGHT='{"databaseId":30800000001,"status":"in_progress","conclusion":null,
               "url":"https://github.com/AgentWebPro/agentweb/actions/runs/30800000001",
               "headSha":"cc33dd44"}'

RUN_CANCELLED='{"databaseId":30700000002,"status":"completed","conclusion":"cancelled",
                "url":"https://github.com/AgentWebPro/agentweb/actions/runs/30700000002",
                "headSha":"ee55ff66"}'

STDOUT=''
STATUS=0

# run_gate <fixture dir> [args...]
run_gate() {
  local dir="$1"; shift
  STDOUT="$(TRUNK_STATE_MOCK_DIR="${dir}" bash "${GATE_SCRIPT}" "$@" 2>&1)"
  STATUS=$?
}

# check <label> <expected exit> <substring that must appear>
check() {
  local label="$1" want_status="$2" want_text="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "${STATUS}" != "${want_status}" ]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "FAIL  %s\n      expected exit %s, got %s\n      output: %s\n" \
      "${label}" "${want_status}" "${STATUS}" "${STDOUT}"
    return
  fi
  if ! printf '%s' "${STDOUT}" | grep -qF "${want_text}"; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "FAIL  %s\n      expected output to contain '%s'\n      output: %s\n" \
      "${label}" "${want_text}" "${STDOUT}"
    return
  fi
  printf "ok    %s\n" "${label}"
}

install_mock_gh

# ---------------------------------------------------------------------------
# AC4 — deploy state is queryable without parsing `gh run list` by eye
# ---------------------------------------------------------------------------

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OK}]"
printf '%s\n' '9db4d5947' >"${d}/trunk_commits"
run_gate "${d}"
check 'AC4: a healthy trunk reports DEPLOYABLE and exits 0' 0 'state=DEPLOYABLE'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_FAILED}]"
run_gate "${d}"
check 'AC4: a failed latest deploy reports BLOCKED' 0 'state=BLOCKED'

# Reporting mode stays exit 0 so a monitoring caller can read state without
# treating a broken trunk as its own crash. Enforcement is opt-in, below.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_FAILED}]"
run_gate "${d}"
check 'AC4: BLOCKED still exits 0 in report mode' 0 'run_url=https://github.com/AgentWebPro/agentweb/actions/runs/30712345678'

# ---------------------------------------------------------------------------
# AC2 — the merge gate refuses to merge onto a broken trunk, and NAMES it
# ---------------------------------------------------------------------------

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_FAILED}]"
run_gate "${d}" --require-deployable
check 'AC2: --require-deployable refuses a broken trunk' 1 'TRUNK_NOT_DEPLOYABLE'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_FAILED}]"
run_gate "${d}" --require-deployable
check 'AC2: the refusal names the failing run so it is actionable' 1 '30712345678'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OK}]"
printf '%s\n' '9db4d5947' >"${d}/trunk_commits"
run_gate "${d}" --require-deployable
check 'AC2: a healthy trunk passes enforcement' 0 'state=DEPLOYABLE'

# The override exists because a fix FOR the broken deploy must be mergeable.
# Requiring a reason is the whole point: it has to be a decision, not a flag.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_FAILED}]"
STDOUT="$(TRUNK_STATE_MOCK_DIR="${d}" TRUNK_DEPLOY_OVERRIDE_REASON='#2241 reverts the deploy that broke trunk' \
  bash "${GATE_SCRIPT}" --require-deployable 2>&1)"; STATUS=$?
check 'AC2: an explicit override merges and is recorded' 0 'override=#2241 reverts the deploy that broke trunk'

# An empty override must not silently disable the gate — that is how a control
# becomes decorative.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_FAILED}]"
STDOUT="$(TRUNK_STATE_MOCK_DIR="${d}" TRUNK_DEPLOY_OVERRIDE_REASON='' \
  bash "${GATE_SCRIPT}" --require-deployable 2>&1)"; STATUS=$?
check 'AC2: an empty override reason does NOT unblock' 1 'TRUNK_NOT_DEPLOYABLE'

# ---------------------------------------------------------------------------
# Fail-closed: no measurement is never a pass
# ---------------------------------------------------------------------------

d="$(new_fixture_dir)"; runlist "${d}" '[]'
run_gate "${d}" --require-deployable
check 'fail-closed: no Deploy runs at all blocks rather than passing' 2 'UNKNOWN'

d="$(new_fixture_dir)"; printf '1' >"${d}/runlist_exit"
run_gate "${d}" --require-deployable
check 'fail-closed: a gh failure blocks rather than passing' 2 'UNKNOWN'

d="$(new_fixture_dir)"; printf 'not json at all' >"${d}/runlist.json"
run_gate "${d}" --require-deployable
check 'fail-closed: an unreadable payload blocks rather than passing' 2 'UNKNOWN'

# ---------------------------------------------------------------------------
# The 2026-08-01 shape specifically: a fix in flight does NOT clear the trunk
# ---------------------------------------------------------------------------
#
# `gh run list` returns newest first. An in-flight run sitting on top of a
# failure is the exact state that existed while #2234 and #2238 merged. The
# newest COMPLETED run is what decides; an in-flight run is reported, never
# mistaken for proof.

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_INFLIGHT},${RUN_FAILED}]"
run_gate "${d}" --require-deployable
check 'a deploy in flight above a failure still blocks' 1 'TRUNK_NOT_DEPLOYABLE'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_INFLIGHT},${RUN_FAILED}]"
run_gate "${d}"
check 'an in-flight run is reported rather than hidden' 0 'in_flight=true'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_INFLIGHT},${RUN_OK}]"
printf '%s\n' '9db4d5947' >"${d}/trunk_commits"
run_gate "${d}" --require-deployable
check 'a deploy in flight above a success does not block' 0 'state=DEPLOYABLE'

# A cancelled deploy never shipped. Treating it as success is how a trunk goes
# quietly unshipped.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_CANCELLED}]"
run_gate "${d}" --require-deployable
check 'a cancelled deploy is not a successful deploy' 1 'TRUNK_NOT_DEPLOYABLE'

# ---------------------------------------------------------------------------
# The verdict is bound to a COMMIT, not merely to recency (Greptile P1 on #2254)
# ---------------------------------------------------------------------------
#
# `gh run list` orders by creation time, so a run created earlier but finishing
# later cannot displace a newer one — ordering alone is sound. What ordering
# cannot express is WHICH COMMIT the verdict describes. A re-run of an older
# deploy, or a branch that was reset, leaves a newest-completed run whose
# headSha is not on the current trunk, and the gate would then report on a
# different line of history while sounding authoritative.
#
# So a completed run at the current trunk head wins outright.

TRUNK_SHA='9db4d5947aa11bb2200cc33dd4400ee55ff660011'

RUN_OTHER_SUCCESS='{"databaseId":30900000009,"status":"completed","conclusion":"success",
                    "url":"https://github.com/AgentWebPro/agentweb/actions/runs/30900000009",
                    "headSha":"ffffffffffffffffffffffffffffffffffffffff"}'

RUN_TRUNK_FAILED='{"databaseId":30900000010,"status":"completed","conclusion":"failure",
                   "url":"https://github.com/AgentWebPro/agentweb/actions/runs/30900000010",
                   "headSha":"9db4d5947aa11bb2200cc33dd4400ee55ff660011"}'

RUN_TRUNK_SUCCESS='{"databaseId":30900000011,"status":"completed","conclusion":"success",
                    "url":"https://github.com/AgentWebPro/agentweb/actions/runs/30900000011",
                    "headSha":"9db4d5947aa11bb2200cc33dd4400ee55ff660011"}'

# The defect Greptile named: a newer completed run for a DIFFERENT commit
# succeeded, while the current trunk head's own deploy failed. Recency alone
# says DEPLOYABLE and would wave a merge onto a trunk that cannot ship.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OTHER_SUCCESS},${RUN_TRUNK_FAILED}]"
printf '%s' "${TRUNK_SHA}" >"${d}/trunk_head_sha"
printf '%s\n' "${TRUNK_SHA}" >"${d}/trunk_commits"
run_gate "${d}" --require-deployable
check 'SHA-bound: the trunk head run decides, not merely the newest' 1 'TRUNK_NOT_DEPLOYABLE'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OTHER_SUCCESS},${RUN_TRUNK_FAILED}]"
printf '%s' "${TRUNK_SHA}" >"${d}/trunk_head_sha"
printf '%s\n' "${TRUNK_SHA}" >"${d}/trunk_commits"
run_gate "${d}"
check 'SHA-bound: it names the trunk head run, not the unrelated one' 0 'run_id=30900000010'

# The converse must also hold, or the fix trades one wrong answer for another:
# an unrelated FAILED run must not block a trunk whose own deploy succeeded.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_FAILED},${RUN_TRUNK_SUCCESS}]"
printf '%s' "${TRUNK_SHA}" >"${d}/trunk_head_sha"
printf '%s\n' "${TRUNK_SHA}" >"${d}/trunk_commits"
run_gate "${d}" --require-deployable
check 'SHA-bound: an unrelated failure does not block a healthy trunk head' 0 'state=DEPLOYABLE'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_TRUNK_SUCCESS}]"
printf '%s' "${TRUNK_SHA}" >"${d}/trunk_head_sha"
printf '%s\n' "${TRUNK_SHA}" >"${d}/trunk_commits"
run_gate "${d}"
check 'SHA-bound: a match is reported as such' 0 'head_sha_matches_trunk=true'

# Main moves faster than deploys, so "no run at the current head" is the NORMAL
# case, not an error. It must still produce a verdict — and say out loud that
# the verdict is older than the trunk rather than implying otherwise.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OK}]"
printf '%s' "${TRUNK_SHA}" >"${d}/trunk_head_sha"
printf '%s\n%s\n' "${TRUNK_SHA}" '9db4d5947' >"${d}/trunk_commits"
run_gate "${d}" --require-deployable
check 'SHA-bound: no run at trunk head still yields a verdict' 0 'state=DEPLOYABLE'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OK}]"
printf '%s' "${TRUNK_SHA}" >"${d}/trunk_head_sha"
printf '%s\n%s\n' "${TRUNK_SHA}" '9db4d5947' >"${d}/trunk_commits"
run_gate "${d}"
check 'SHA-bound: and it discloses that the verdict is not at trunk head' 0 'has not deployed yet'

# Resolving the trunk head is best-effort. If that call fails the gate must
# still work — degrading to recency — and must not silently imply a SHA match.
# Fail-closed, and this is the case Greptile pushed on: an unrankable success
# is not evidence. Report mode still shows what was found; ENFORCEMENT refuses.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OK}]"
run_gate "${d}" --require-deployable
check 'SHA-bound: an unrankable success does NOT pass enforcement' 2 'UNKNOWN'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OK}]"
run_gate "${d}"
check 'SHA-bound: and says the verdict is not commit-ranked' 0 'NOT ranked by commit'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OK}]"
run_gate "${d}"
check 'SHA-bound: never claims a match it could not verify' 0 'head_sha_matches_trunk=false'

# ---------------------------------------------------------------------------
# Ranking by COMMIT, not by run recency (Greptile round 2 on #2254)
# ---------------------------------------------------------------------------
#
# The masking case. Trunk history is Z (head), Y, X — newest first.
#   - Z has no completed deploy yet (normal: main outruns a 12-20 min deploy)
#   - Y's deploy FAILED — trunk genuinely cannot ship
#   - X's deploy was RE-RUN today and succeeded, so by run-creation time it is
#     the newest completed run of all
#
# Ranking by run recency picks X's re-run, reports DEPLOYABLE, and waves a merge
# onto a trunk whose latest real deploy failed. That is ENG-837 happening again
# through a different door. Ranking by commit reaches Y first and blocks.

SHA_Z='cccccccccccccccccccccccccccccccccccccccc'
SHA_Y='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
SHA_X='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
TRUNK_HISTORY="${SHA_Z}
${SHA_Y}
${SHA_X}"

RUN_X_RERUN_SUCCESS='{"databaseId":31000000001,"status":"completed","conclusion":"success",
                      "url":"https://github.com/AgentWebPro/agentweb/actions/runs/31000000001",
                      "headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
RUN_Y_FAILED='{"databaseId":31000000002,"status":"completed","conclusion":"failure",
               "url":"https://github.com/AgentWebPro/agentweb/actions/runs/31000000002",
               "headSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
RUN_Y_SUCCESS='{"databaseId":31000000003,"status":"completed","conclusion":"success",
                "url":"https://github.com/AgentWebPro/agentweb/actions/runs/31000000003",
                "headSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'

# Note the run order: X's re-run is FIRST, i.e. newest by creation time.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_X_RERUN_SUCCESS},${RUN_Y_FAILED}]"
printf '%s' "${SHA_Z}" >"${d}/trunk_head_sha"
STDOUT="$(TRUNK_STATE_MOCK_DIR="${d}" TRUNK_COMMITS="${TRUNK_HISTORY}" \
  bash "${GATE_SCRIPT}" --require-deployable 2>&1)"; STATUS=$?
check 'commit-ranked: an ancestor re-run cannot mask a newer commit failure' 1 'TRUNK_NOT_DEPLOYABLE'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_X_RERUN_SUCCESS},${RUN_Y_FAILED}]"
printf '%s' "${SHA_Z}" >"${d}/trunk_head_sha"
STDOUT="$(TRUNK_STATE_MOCK_DIR="${d}" TRUNK_COMMITS="${TRUNK_HISTORY}" \
  bash "${GATE_SCRIPT}" 2>&1)"; STATUS=$?
check 'commit-ranked: it names the newer commit run, not the newer-created one' 0 'run_id=31000000002'

# The converse: with Y green, X's older state is irrelevant and must not block.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_FAILED},${RUN_Y_SUCCESS}]"
printf '%s' "${SHA_Z}" >"${d}/trunk_head_sha"
STDOUT="$(TRUNK_STATE_MOCK_DIR="${d}" TRUNK_COMMITS="${TRUNK_HISTORY}" \
  bash "${GATE_SCRIPT}" --require-deployable 2>&1)"; STATUS=$?
check 'commit-ranked: an off-trunk failure does not block a green trunk commit' 0 'state=DEPLOYABLE'

# "Head has not deployed yet" is the normal steady state and must stay
# non-blocking, but it has to be stated rather than implied.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_Y_SUCCESS}]"
printf '%s' "${SHA_Z}" >"${d}/trunk_head_sha"
STDOUT="$(TRUNK_STATE_MOCK_DIR="${d}" TRUNK_COMMITS="${TRUNK_HISTORY}" \
  bash "${GATE_SCRIPT}" 2>&1)"; STATUS=$?
check 'commit-ranked: an untested head is disclosed, not hidden' 0 'has not deployed yet'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_Y_SUCCESS}]"
printf '%s' "${SHA_Z}" >"${d}/trunk_head_sha"
STDOUT="$(TRUNK_STATE_MOCK_DIR="${d}" TRUNK_COMMITS="${TRUNK_HISTORY}" \
  bash "${GATE_SCRIPT}" 2>&1)"; STATUS=$?
check 'commit-ranked: and flagged as commit-ranked' 0 'commit_ranked=true'

# Without trunk history the gate still answers, but must not pretend the answer
# is commit-ranked — the masking above becomes possible again and it says so.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OK}]"
run_gate "${d}"
check 'commit-ranked: unavailable history is declared, not papered over' 0 'commit_ranked=false'

d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_OK}]"
run_gate "${d}"
check 'commit-ranked: and the masking risk is spelled out' 0 'masking a newer failure'

printf '\n%s tests, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ]
