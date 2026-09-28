#!/usr/bin/env bash
#
# Tests for .github/scripts/deploy-base-sha.sh (ENG-2170).
#
# `gh` is replaced with a scripted mock on PATH, so every branch runs for real
# without touching GitHub. Run with:
#
#   bash .github/scripts/deploy-base-sha.test.sh
#
# The bug this closes
# --------------------
# `dorny/paths-filter` on `push` with no `base` compares only against
# `github.event.before`. `concurrency: { group: deploy-production }` keeps
# only one PENDING run, so a merge that lands while a deploy is already
# pending cancels the older pending run before `detect-changes` ever runs.
# The next run that actually executes only diffs against its own previous
# commit, so a component change that only existed in the cancelled run's diff
# is never compared against again and is silently never deployed. Observed
# live 2026-09-25: PR #3079's portal change was in a run that GitHub cancelled
# while pending, and the portal stayed on the prior build through several
# later successful backend-only deploys.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_SHA_SCRIPT="${SCRIPT_DIR}/deploy-base-sha.sh"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

install_mock_gh() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/gh" <<'MOCK'
#!/usr/bin/env bash
MOCK_DIR="${BASE_SHA_MOCK_DIR:?BASE_SHA_MOCK_DIR must be set}"

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
  # repos/OWNER/REPO/actions/runs/<id>/jobs
  run_id="$(printf '%s' "${2:-}" | sed -n 's#.*/runs/\([0-9]*\)/jobs#\1#p')"
  jobs_file="${MOCK_DIR}/jobs_${run_id}.json"
  if [ -f "${jobs_file}" ]; then
    cat "${jobs_file}"
    exit 0
  fi
  printf 'mock gh: simulated jobs-list failure for run %s\n' "${run_id}" >&2
  exit 1
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

# runlist <dir> <json array of {databaseId,status,headSha}>, newest first.
runlist() {
  printf '%s\n' "$2" >"$1/runlist.json"
}

# jobs <dir> <run_id> <detect-changes conclusion, or "absent"> \
#      [backend-deploy conclusion] [partner-deploy conclusion]
# backend/partner default to "success" when the detect-changes conclusion is
# not "absent", matching the common case where both deploy jobs ran cleanly.
jobs_fixture() {
  local dir="$1" run_id="$2" conclusion="$3" backend="${4:-success}" partner="${5:-success}"
  if [ "${conclusion}" = "absent" ]; then
    printf '{"jobs":[{"name":"Backend deploy to production","conclusion":"skipped"}]}' \
      >"${dir}/jobs_${run_id}.json"
  else
    printf '{"jobs":[{"name":"Detect changed projects","conclusion":"%s"},{"name":"Backend deploy to production","conclusion":"%s"},{"name":"Partner portal deploy to production","conclusion":"%s"}]}' \
      "${conclusion}" "${backend}" "${partner}" >"${dir}/jobs_${run_id}.json"
  fi
}

STDOUT=''
STATUS=0

# run_script <fixture dir> [env assignments already exported by caller]
run_script() {
  local dir="$1"
  STDOUT="$(BASE_SHA_MOCK_DIR="${dir}" DEPLOY_CURRENT_RUN_ID='99999999' \
    bash "${BASE_SHA_SCRIPT}" 2>&1)"
  STATUS=$?
}

# check <label> <substring that must appear>
check() {
  local label="$1" want_text="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "${STATUS}" != "0" ]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "FAIL  %s\n      expected exit 0, got %s\n      output: %s\n" \
      "${label}" "${STATUS}" "${STDOUT}"
    return
  fi
  # A here-string, not a pipeline — see trunk-deploy-state.test.sh (ENG-1277)
  # for why a producer/grep pipe can SIGPIPE-race pipefail into a false FAIL.
  if ! grep -qF "${want_text}" <<<"${STDOUT}"; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "FAIL  %s\n      expected output to contain '%s'\n      output: %s\n" \
      "${label}" "${want_text}" "${STDOUT}"
    return
  fi
  printf "ok    %s\n" "${label}"
}

# check_exact_line <label> <full line that must appear verbatim>
#
# `check` only proves substring containment, which cannot distinguish
# `base_sha=` (empty) from `base_sha=abc123` -- the former is a prefix of the
# latter. This asserts one whole line matches exactly.
check_exact_line() {
  local label="$1" want_line="$2"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [ "${STATUS}" != "0" ]; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "FAIL  %s\n      expected exit 0, got %s\n      output: %s\n" \
      "${label}" "${STATUS}" "${STDOUT}"
    return
  fi
  if ! grep -qxF "${want_line}" <<<"${STDOUT}"; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf "FAIL  %s\n      expected a line exactly matching '%s'\n      output: %s\n" \
      "${label}" "${want_line}" "${STDOUT}"
    return
  fi
  printf "ok    %s\n" "${label}"
}

install_mock_gh

# ---------------------------------------------------------------------------
# The core case: the newest completed run's detect-changes succeeded
# ---------------------------------------------------------------------------

RUN_A='{"databaseId":40000001,"status":"completed","headSha":"aaaaaaa1"}'

d="$(new_fixture_dir)"
runlist "${d}" "[${RUN_A}]"
jobs_fixture "${d}" 40000001 success
run_script "${d}"
check 'a run whose detect-changes succeeded is used as the base' 'resolved=true'

d="$(new_fixture_dir)"
runlist "${d}" "[${RUN_A}]"
jobs_fixture "${d}" 40000001 success
run_script "${d}"
check 'the base sha is that run head, not something else' 'base_sha=aaaaaaa1'

# ---------------------------------------------------------------------------
# The 2026-09-25 shape: the newest run was cancelled WHILE PENDING, so its
# detect-changes job never ran at all. It must be walked past, not trusted.
# ---------------------------------------------------------------------------

RUN_CANCELLED_PENDING='{"databaseId":40000003,"status":"completed","headSha":"ccccccc3"}'
RUN_PRIOR_SUCCESS='{"databaseId":40000002,"status":"completed","headSha":"bbbbbbb2"}'

d="$(new_fixture_dir)"
runlist "${d}" "[${RUN_CANCELLED_PENDING},${RUN_PRIOR_SUCCESS}]"
jobs_fixture "${d}" 40000003 absent
jobs_fixture "${d}" 40000002 success
run_script "${d}"
check 'a run cancelled before detect-changes ran is walked past' 'base_sha=bbbbbbb2'

# A run whose detect-changes job FAILED outright is equally untrustworthy —
# backend-deploy/partner-deploy never ran under `needs:`, so that component
# was just as silently skipped as the cancelled-pending case.
RUN_DETECT_FAILED='{"databaseId":40000004,"status":"completed","headSha":"ddddddd4"}'

d="$(new_fixture_dir)"
runlist "${d}" "[${RUN_DETECT_FAILED},${RUN_PRIOR_SUCCESS}]"
jobs_fixture "${d}" 40000004 failure
jobs_fixture "${d}" 40000002 success
run_script "${d}"
check 'a run whose own detect-changes job failed is walked past too' 'base_sha=bbbbbbb2'

# A run whose detect-changes job SUCCEEDED but whose own backend-deploy job
# then FAILED must also be walked past: trusting that run's head as the new
# base would let the next run's filter report backend=false even though the
# backend change that run's own deploy was supposed to ship never landed --
# the same silent-drop bug via a failed-deploy path instead of a
# cancelled-pending-run path.
RUN_BACKEND_DEPLOY_FAILED='{"databaseId":40000005,"status":"completed","headSha":"eeeeeee5"}'

d="$(new_fixture_dir)"
runlist "${d}" "[${RUN_BACKEND_DEPLOY_FAILED},${RUN_PRIOR_SUCCESS}]"
jobs_fixture "${d}" 40000005 success failure success
jobs_fixture "${d}" 40000002 success
run_script "${d}"
check 'a run whose backend-deploy job failed is walked past' 'base_sha=bbbbbbb2'

# Same shape, but the partner-deploy job was cancelled instead of failed.
RUN_PARTNER_DEPLOY_CANCELLED='{"databaseId":40000006,"status":"completed","headSha":"fffffff6"}'

d="$(new_fixture_dir)"
runlist "${d}" "[${RUN_PARTNER_DEPLOY_CANCELLED},${RUN_PRIOR_SUCCESS}]"
jobs_fixture "${d}" 40000006 success success cancelled
jobs_fixture "${d}" 40000002 success
run_script "${d}"
check 'a run whose partner-deploy job was cancelled is walked past' 'base_sha=bbbbbbb2'

# A skipped deploy job (the filter legitimately decided not to run it) is NOT
# a reason to distrust the run -- only failure/cancelled are.
RUN_PARTNER_SKIPPED='{"databaseId":40000007,"status":"completed","headSha":"ggggggg7"}'

d="$(new_fixture_dir)"
runlist "${d}" "[${RUN_PARTNER_SKIPPED}]"
jobs_fixture "${d}" 40000007 success success skipped
run_script "${d}"
check 'a legitimately skipped deploy job does not disqualify the run' 'base_sha=ggggggg7'

# The currently-in-flight run (this very run) must never be its own base, even
# if it were somehow reported back as completed by a race.
RUN_SELF='{"databaseId":99999999,"status":"completed","headSha":"selfselfself"}'

d="$(new_fixture_dir)"
runlist "${d}" "[${RUN_SELF},${RUN_PRIOR_SUCCESS}]"
jobs_fixture "${d}" 99999999 success
jobs_fixture "${d}" 40000002 success
run_script "${d}"
check 'the current run id is excluded from candidates' 'base_sha=bbbbbbb2'

# ---------------------------------------------------------------------------
# Fail-safe: nothing usable in the lookback window means "deploy everything"
# ---------------------------------------------------------------------------

d="$(new_fixture_dir)"
runlist "${d}" '[]'
run_script "${d}"
check 'no prior runs at all falls back to unresolved' 'resolved=false'

d="$(new_fixture_dir)"
runlist "${d}" "[${RUN_CANCELLED_PENDING}]"
jobs_fixture "${d}" 40000003 absent
run_script "${d}"
check 'only-cancelled history falls back to unresolved' 'resolved=false'

d="$(new_fixture_dir)"
printf '1' >"${d}/runlist_exit"
run_script "${d}"
check 'a gh run-list failure falls back to unresolved rather than crashing' 'resolved=false'

d="$(new_fixture_dir)"
printf 'not json at all' >"${d}/runlist.json"
run_script "${d}"
check 'an unreadable run-list payload falls back to unresolved' 'resolved=false'

d="$(new_fixture_dir)"
runlist "${d}" "[${RUN_A}]"
# No jobs_*.json fixture written at all -> mock `gh api` fails for this run.
run_script "${d}"
check 'a jobs-list API failure for the only candidate falls back to unresolved' 'resolved=false'

# base_sha must be empty whenever unresolved, so a caller cannot accidentally
# treat a stale value as meaningful.
d="$(new_fixture_dir)"
runlist "${d}" '[]'
run_script "${d}"
check_exact_line 'an unresolved result carries no base_sha' 'base_sha='

printf '\ndeploy-base-sha: %d run, %d failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ]
