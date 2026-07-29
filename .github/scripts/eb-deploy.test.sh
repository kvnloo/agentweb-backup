#!/usr/bin/env bash
#
# Tests for .github/scripts/eb-deploy.sh (ENG-734).
#
# The AWS CLI is replaced with a scripted mock on PATH, so every branch of the
# deploy/verify logic runs for real without touching AWS. Run with:
#
#   bash .github/scripts/eb-deploy.test.sh
#
# The final case is a regression proof: it runs the *previous* inline workflow
# logic (the `|| echo "...continuing..."` version) against the same mock that
# makes update-environment fail, and asserts that the old code exited 0. That is
# the false green this change removes.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EB_DEPLOY_SCRIPT="${SCRIPT_DIR}/eb-deploy.sh"

TESTS_RUN=0
TESTS_FAILED=0
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

# ---------------------------------------------------------------------------
# Mock AWS CLI
# ---------------------------------------------------------------------------

install_mock_aws() {
  mkdir -p "${WORKDIR}/bin"
  cat >"${WORKDIR}/bin/aws" <<'MOCK'
#!/usr/bin/env bash
# Scripted stand-in for the AWS CLI. Fixtures live in $EB_MOCK_DIR:
#   create_result      "<exit>|<stderr message>"
#   update_results     one "<exit>|<stderr message>" per update-environment call
#   describe_states    one "<Status>|<Health>|<VersionLabel>" per describe call,
#                      or "NOTFOUND", or "ERROR|<message>". Last line repeats.
MOCK_DIR="${EB_MOCK_DIR:?EB_MOCK_DIR must be set}"

operation="${2:-}"

query=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--query" ]; then
    query="${2:-}"
  fi
  shift
done

next_line() {
  # $1 = fixture file, $2 = counter file. Returns the Nth line, last repeating.
  local fixture="$1" counter="$2" n line
  n=0
  [ -f "$counter" ] && n=$(cat "$counter")
  n=$(( n + 1 ))
  echo "$n" >"$counter"
  line=$(sed -n "${n}p" "$fixture" 2>/dev/null)
  if [ -z "$line" ]; then
    line=$(tail -n 1 "$fixture" 2>/dev/null)
  fi
  printf '%s' "$line"
}

case "$operation" in
  create-application-version)
    line=$(cat "${MOCK_DIR}/create_result" 2>/dev/null || printf '0|')
    code="${line%%|*}"
    msg="${line#*|}"
    [ -n "$msg" ] && printf '%s\n' "$msg" >&2
    exit "$code"
    ;;

  update-environment)
    line=$(next_line "${MOCK_DIR}/update_results" "${MOCK_DIR}/update_calls")
    code="${line%%|*}"
    msg="${line#*|}"
    [ -n "$msg" ] && printf '%s\n' "$msg" >&2
    exit "$code"
    ;;

  describe-environments)
    line=$(next_line "${MOCK_DIR}/describe_states" "${MOCK_DIR}/describe_calls")

    if [ "$line" = "NOTFOUND" ]; then
      printf 'None\n'
      exit 0
    fi

    if [ "${line%%|*}" = "ERROR" ]; then
      printf '%s\n' "${line#*|}" >&2
      exit 255
    fi

    status="${line%%|*}"
    rest="${line#*|}"
    health="${rest%%|*}"
    version="${rest#*|}"

    case "$query" in
      *'[Status,Health,VersionLabel]'*) printf '%s\t%s\t%s\n' "$status" "$health" "$version" ;;
      *'.Status'*)                      printf '%s\n' "$status" ;;
      *'.Health'*)                      printf '%s\n' "$health" ;;
      *'.VersionLabel'*)                printf '%s\n' "$version" ;;
      *)                                printf '%s\t%s\t%s\n' "$status" "$health" "$version" ;;
    esac
    exit 0
    ;;

  *)
    printf 'mock aws: unhandled operation %s\n' "$operation" >&2
    exit 64
    ;;
esac
MOCK
  chmod +x "${WORKDIR}/bin/aws"
}

# ---------------------------------------------------------------------------
# Fixture + assertion helpers
# ---------------------------------------------------------------------------

# new_mock_dir <create_result> <update_results...> -- <describe_states...>
new_mock_dir() {
  local dir
  dir="$(mktemp -d "${WORKDIR}/mock.XXXXXX")"
  printf '0|\n' >"${dir}/create_result"
  printf '0|\n' >"${dir}/update_results"
  printf 'Ready|Green|old-version\n' >"${dir}/describe_states"
  printf '%s' "${dir}"
}

set_create_result() { printf '%s\n' "$2" >"$1/create_result"; }

set_update_results() {
  local dir="$1"
  shift
  : >"${dir}/update_results"
  local line
  for line in "$@"; do printf '%s\n' "${line}" >>"${dir}/update_results"; done
}

set_describe_states() {
  local dir="$1"
  shift
  : >"${dir}/describe_states"
  local line
  for line in "$@"; do printf '%s\n' "${line}" >>"${dir}/describe_states"; done
}

# run_deploy <mock_dir> [extra env assignments...]
run_deploy() {
  local dir="$1"
  shift
  set +e
  env \
    PATH="${WORKDIR}/bin:${PATH}" \
    EB_MOCK_DIR="${dir}" \
    EB_APPLICATION_NAME='test-app' \
    EB_ENVIRONMENT_NAME='test-env' \
    EB_VERSION_LABEL='backend-20260729-pr2216' \
    EB_SOURCE_BUNDLE_S3_BUCKET='test-bucket' \
    EB_SOURCE_BUNDLE_S3_KEY='builds/backend-20260729-pr2216.zip' \
    EB_POLL_INTERVAL_SECONDS='0' \
    EB_SETTLE_TIMEOUT_SECONDS='2' \
    EB_DEPLOY_TIMEOUT_SECONDS='2' \
    EB_HEALTH_SETTLE_SECONDS='1' \
    "$@" \
    bash "${EB_DEPLOY_SCRIPT}" >"${WORKDIR}/out.txt" 2>&1
  LAST_EXIT=$?
  set -e
  LAST_OUTPUT="$(cat "${WORKDIR}/out.txt")"
}

pass() { printf '  ok   %s\n' "$1"; }

check() {
  # check <description> <expected_exit> <expected substring>
  local desc="$1" expected_exit="$2" needle="$3"
  TESTS_RUN=$(( TESTS_RUN + 1 ))

  if [ "${LAST_EXIT}" -ne "${expected_exit}" ]; then
    printf '  FAIL %s\n       expected exit %s, got %s\n       output:\n%s\n' \
      "${desc}" "${expected_exit}" "${LAST_EXIT}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi

  if [ -n "${needle}" ] && ! printf '%s' "${LAST_OUTPUT}" | grep -qF "${needle}"; then
    printf '  FAIL %s\n       output did not contain: %s\n       output:\n%s\n' \
      "${desc}" "${needle}" "${LAST_OUTPUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
    return
  fi

  pass "${desc}"
}

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

install_mock_aws
printf 'eb-deploy.sh\n'

# AC5 — happy path: settle poll sees Ready, update accepted, environment comes
# up on the new version, Green.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Updating|Grey|old-version' \
  'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_DEPLOY_TIMEOUT_SECONDS='30'
check 'happy path exits 0 once the environment reports the new version' 0 \
  'SUCCESS: environment '"'"'test-env'"'"' is Ready, running version '"'"'backend-20260729-pr2216'"'"', health=Green.'

# AC1 — update-environment fails for a non-collision reason.
M=$(new_mock_dir)
set_update_results "$M" '255|An error occurred (AccessDenied) when calling the UpdateEnvironment operation: not authorized'
run_deploy "$M"
check 'AC1: a failing update-environment fails the job' 1 'EB_DEPLOY_FAILED: update-environment failed'
check 'AC1: the AWS error text is surfaced, not swallowed' 1 'AccessDenied'

# AC2 — create-application-version fails with a real error.
M=$(new_mock_dir)
set_create_result "$M" '255|An error occurred (InvalidParameterValue) when calling the CreateApplicationVersion operation: S3 object does not exist'
run_deploy "$M"
check 'AC2: a failing create-application-version fails the job' 1 \
  'EB_DEPLOY_FAILED: create-application-version failed'

# AC2 — the one tolerated create failure: the version already exists.
M=$(new_mock_dir)
set_create_result "$M" '255|An error occurred (InvalidParameterValue) when calling the CreateApplicationVersion operation: Application Version backend-20260729-pr2216 already exists.'
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_DEPLOY_TIMEOUT_SECONDS='30'
check 'AC2: an already-exists collision continues with the reason logged' 0 \
  'already exists; reusing the existing version'

# AC3 — the environment settles Ready but on the wrong version: never success.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='1' EB_DEPLOY_TIMEOUT_SECONDS='2'
check 'AC3: Ready on the wrong version fails instead of reporting success' 1 \
  'did not come up Ready on version'
check 'AC3: the failure names the version actually observed' 1 'Version=old-version'

# AC3 — right version, Red health.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Ready|Red|backend-20260729-pr2216'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='1' EB_DEPLOY_TIMEOUT_SECONDS='30' EB_HEALTH_SETTLE_SECONDS='2'
check 'AC3: Red health on the new version fails the job' 1 'but its health stayed Red'

# AC3 — Grey is transient and must not fail early.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Ready|Grey|backend-20260729-pr2216' \
  'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='0' EB_DEPLOY_TIMEOUT_SECONDS='30' EB_HEALTH_SETTLE_SECONDS='30'
check 'AC3: transient Grey settles to Green and succeeds' 0 'health=Green'

# AC3 — Yellow (degraded but serving) is accepted, matching prior behaviour.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Ready|Yellow|backend-20260729-pr2216'
run_deploy "$M" EB_DEPLOY_TIMEOUT_SECONDS='30'
check 'AC3: Yellow health is accepted (only Red fails)' 0 'health=Yellow'

# AC3 — the verify poll never terminates on a stuck environment.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Updating|Grey|old-version'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='1' EB_DEPLOY_TIMEOUT_SECONDS='2'
check 'AC3: a never-finishing update times out and fails' 1 'did not come up Ready on version'

# AC3 — a terminated environment fails immediately rather than burning the timeout.
M=$(new_mock_dir)
set_describe_states "$M" 'Terminating|Grey|old-version'
run_deploy "$M"
check 'AC3: a Terminating environment fails fast' 1 'is Terminating during'

# AC4 — collision on the first attempt, then the environment settles and the
# version is applied.
M=$(new_mock_dir)
set_update_results "$M" \
  '255|An error occurred (InvalidParameterValue) when calling the UpdateEnvironment operation: Environment named test-env is in an invalid state for this operation. Must be Ready.' \
  '0|'
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Ready|Green|old-version' \
  'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_DEPLOY_TIMEOUT_SECONDS='30'
check 'AC4: a concurrent-update collision is retried and then applied' 0 \
  'was mid-update on attempt 1/3'
check 'AC4: the retried deploy still verifies the version' 0 'SUCCESS: environment'

# AC4 — collision on every attempt: fails with that stated reason, never success.
M=$(new_mock_dir)
set_update_results "$M" \
  '255|An error occurred (InvalidParameterValue) when calling the UpdateEnvironment operation: Environment named test-env is in an invalid state for this operation. Must be Ready.'
run_deploy "$M"
check 'AC4: an unresolvable collision fails with the stated reason' 1 \
  'kept reporting a concurrent update in progress'
check 'AC4: the failure states the version was not applied' 1 \
  "Version 'backend-20260729-pr2216' was NOT applied."

# AC4 — the environment never settles before update-environment is attempted.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='1' EB_SETTLE_TIMEOUT_SECONDS='2'
check 'AC4: a never-settling environment fails before claiming a deploy' 1 \
  'for an in-progress update to finish'

# Environment lookup failures are fatal, not treated as "no version yet".
M=$(new_mock_dir)
set_describe_states "$M" 'NOTFOUND'
run_deploy "$M"
check 'a missing environment fails loudly' 1 'was not found'

M=$(new_mock_dir)
set_describe_states "$M" 'ERROR|An error occurred (ExpiredToken) when calling the DescribeEnvironments operation'
run_deploy "$M"
check 'a describe-environments API error fails loudly' 1 'describe-environments failed'

# Misconfiguration fails closed rather than deploying something unintended.
M=$(new_mock_dir)
run_deploy "$M" EB_VERSION_LABEL=''
check 'an empty required variable fails closed' 1 'EB_VERSION_LABEL is empty or unset'

# ---------------------------------------------------------------------------
# Regression proof: the previous inline logic reported success on a failed deploy
# ---------------------------------------------------------------------------

printf '\nregression proof (pre-ENG-734 inline workflow logic)\n'

cat >"${WORKDIR}/legacy-deploy.sh" <<'LEGACY'
#!/usr/bin/env bash
# Verbatim shape of the pre-ENG-734 workflow steps: the two swallowing `|| echo`
# lines, then the version-blind readiness wait, then the success banner.
VERSION_LABEL="$EB_VERSION_LABEL"

aws elasticbeanstalk create-application-version \
  --application-name "$EB_APPLICATION_NAME" \
  --version-label "$VERSION_LABEL" \
  --source-bundle "S3Bucket=$EB_SOURCE_BUNDLE_S3_BUCKET,S3Key=$EB_SOURCE_BUNDLE_S3_KEY" || echo "⚠️  Version creation failed (may already exist), continuing..."

aws elasticbeanstalk update-environment \
  --environment-name "$EB_ENVIRONMENT_NAME" \
  --version-label "$VERSION_LABEL" || echo "⚠️  Environment update failed (may be updating), but AWS deployment likely succeeded"

set -euo pipefail
for attempt in 1 2 3; do
  STATUS=$(aws elasticbeanstalk describe-environments \
    --environment-names "$EB_ENVIRONMENT_NAME" \
    --query 'Environments[0].Status' --output text)
  HEALTH=$(aws elasticbeanstalk describe-environments \
    --environment-names "$EB_ENVIRONMENT_NAME" \
    --query 'Environments[0].Health' --output text)
  echo "Status=$STATUS Health=$HEALTH attempt=$attempt"
  if [ "$STATUS" = "Ready" ] && [ "$HEALTH" != "Grey" ]; then
    echo "🚀 Deployment initiated successfully!"
    exit 0
  fi
done
exit 1
LEGACY

# Same failing-update fixture as the AC1 case above, and the environment is left
# Ready on the OLD version because the update never landed.
M=$(new_mock_dir)
set_update_results "$M" '255|An error occurred (AccessDenied) when calling the UpdateEnvironment operation: not authorized'
set_describe_states "$M" 'Ready|Green|old-version'

set +e
env PATH="${WORKDIR}/bin:${PATH}" EB_MOCK_DIR="${M}" \
  EB_APPLICATION_NAME='test-app' EB_ENVIRONMENT_NAME='test-env' \
  EB_VERSION_LABEL='backend-20260729-pr2216' \
  EB_SOURCE_BUNDLE_S3_BUCKET='test-bucket' \
  EB_SOURCE_BUNDLE_S3_KEY='builds/backend-20260729-pr2216.zip' \
  bash "${WORKDIR}/legacy-deploy.sh" >"${WORKDIR}/out.txt" 2>&1
LAST_EXIT=$?
set -e
LAST_OUTPUT="$(cat "${WORKDIR}/out.txt")"
check 'OLD logic exited 0 on a failed update-environment (the false green)' 0 \
  'Deployment initiated successfully'

# The same fixture through the new script must fail.
M=$(new_mock_dir)
set_update_results "$M" '255|An error occurred (AccessDenied) when calling the UpdateEnvironment operation: not authorized'
set_describe_states "$M" 'Ready|Green|old-version'
run_deploy "$M"
check 'NEW logic fails on the identical fixture' 1 'EB_DEPLOY_FAILED: update-environment failed'

# ---------------------------------------------------------------------------

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
