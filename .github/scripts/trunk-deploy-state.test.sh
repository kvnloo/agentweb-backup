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
run_gate "${d}" --require-deployable
check 'a deploy in flight above a success does not block' 0 'state=DEPLOYABLE'

# A cancelled deploy never shipped. Treating it as success is how a trunk goes
# quietly unshipped.
d="$(new_fixture_dir)"; runlist "${d}" "[${RUN_CANCELLED}]"
run_gate "${d}" --require-deployable
check 'a cancelled deploy is not a successful deploy' 1 'TRUNK_NOT_DEPLOYABLE'

printf '\n%s tests, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ]
