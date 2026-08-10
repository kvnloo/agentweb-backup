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

  describe-events)
    # ENG-837: ERROR-severity events are how an ASYNCHRONOUS EB rejection
    # becomes visible. Fixtures: `events` (message text, one per line),
    # `events_exit` (simulate an API/IAM failure).
    code=0
    [ -f "${MOCK_DIR}/events_exit" ] && code=$(cat "${MOCK_DIR}/events_exit")
    if [ "$code" != "0" ]; then
      printf 'mock aws: simulated describe-events failure\n' >&2
      exit "$code"
    fi
    if [ -f "${MOCK_DIR}/events" ]; then
      cat "${MOCK_DIR}/events"
    else
      printf 'None\n'
    fi
    exit 0
    ;;

  describe-instances-health)
    # ENG-878: the non-lagging per-instance signal. Fixture `instances_health`
    # holds "<instance-id><TAB><HealthStatus>" lines, the literal token NONE for
    # an empty environment, or "ERROR|<message>" to simulate an API/IAM failure.
    if [ -f "${MOCK_DIR}/instances_health" ]; then
      first=$(head -n 1 "${MOCK_DIR}/instances_health")
      if [ "${first%%|*}" = "ERROR" ]; then
        printf '%s\n' "${first#*|}" >&2
        exit 255
      fi
      if [ "$first" = "NONE" ]; then
        printf 'None\n'
        exit 0
      fi
      cat "${MOCK_DIR}/instances_health"
    else
      printf 'None\n'
    fi
    exit 0
    ;;

  describe-environment-resources)
    # Fixture `lb_arns`: tab/newline separated ALB ARNs, NONE, or "ERROR|<msg>".
    if [ -f "${MOCK_DIR}/lb_arns" ]; then
      first=$(head -n 1 "${MOCK_DIR}/lb_arns")
      if [ "${first%%|*}" = "ERROR" ]; then
        printf '%s\n' "${first#*|}" >&2
        exit 255
      fi
      if [ "$first" = "NONE" ]; then
        printf 'None\n'
        exit 0
      fi
      cat "${MOCK_DIR}/lb_arns"
    else
      printf 'None\n'
    fi
    exit 0
    ;;

  describe-target-groups)
    if [ -f "${MOCK_DIR}/tg_arns" ]; then
      first=$(head -n 1 "${MOCK_DIR}/tg_arns")
      if [ "${first%%|*}" = "ERROR" ]; then
        printf '%s\n' "${first#*|}" >&2
        exit 255
      fi
      cat "${MOCK_DIR}/tg_arns"
    else
      printf 'None\n'
    fi
    exit 0
    ;;

  describe-target-health)
    # Fixture `target_health`: "<target-id><TAB><State>" lines, NONE, or ERROR|.
    if [ -f "${MOCK_DIR}/target_health" ]; then
      first=$(head -n 1 "${MOCK_DIR}/target_health")
      if [ "${first%%|*}" = "ERROR" ]; then
        printf '%s\n' "${first#*|}" >&2
        exit 255
      fi
      if [ "$first" = "NONE" ]; then
        printf 'None\n'
        exit 0
      fi
      cat "${MOCK_DIR}/target_health"
    else
      printf 'None\n'
    fi
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
  local started
  started=$(date +%s)
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
    EB_TOTAL_TIMEOUT_SECONDS='30' \
    EB_HEALTH_SETTLE_SECONDS='1' \
    "$@" \
    bash "${EB_DEPLOY_SCRIPT}" >"${WORKDIR}/out.txt" 2>&1
  LAST_EXIT=$?
  set -e
  LAST_DURATION=$(( $(date +%s) - started ))
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
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='30'
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
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='30'
check 'AC2: an already-exists collision continues with the reason logged' 0 \
  'already exists; reusing the existing version'

# AC3 — the environment settles Ready but on the wrong version: never success.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='1' EB_TOTAL_TIMEOUT_SECONDS='2'
check 'AC3: Ready on the wrong version fails instead of reporting success' 1 \
  'did not come up Ready on version'
check 'AC3: the failure names the version actually observed' 1 'Version=old-version'

# AC3 — right version, Red health.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Ready|Red|backend-20260729-pr2216'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='1' EB_TOTAL_TIMEOUT_SECONDS='30' EB_HEALTH_SETTLE_SECONDS='2'
check 'AC3: Red health on the new version fails the job' 1 'but its health stayed Red'

# AC3 — Grey is transient and must not fail early.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Ready|Grey|backend-20260729-pr2216' \
  'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='0' EB_TOTAL_TIMEOUT_SECONDS='30' EB_HEALTH_SETTLE_SECONDS='30'
check 'AC3: transient Grey settles to Green and succeeds' 0 'health=Green'

# AC3 — Yellow (degraded but serving) is accepted, matching prior behaviour.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Ready|Yellow|backend-20260729-pr2216'
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='30'
check 'AC3: Yellow health is accepted (only Red fails)' 0 'health=Yellow'

# AC3 — the verify poll never terminates on a stuck environment.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Updating|Grey|old-version'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='1' EB_TOTAL_TIMEOUT_SECONDS='2'
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
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='30'
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

# AC3 — the health settle window restarts when the environment leaves and
# re-enters Ready. Without the reset, the second Ready state is judged against
# the first one's timestamp and fails immediately. (Greptile review, #2219.)
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Ready|Red|backend-20260729-pr2216' \
  'Updating|Grey|old-version' \
  'Ready|Red|backend-20260729-pr2216' \
  'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='1' EB_TOTAL_TIMEOUT_SECONDS='30' EB_HEALTH_SETTLE_SECONDS='1'
check 'AC3: leaving and re-entering Ready restarts the health settle window' 0 \
  'restarting the health settle window'
check 'AC3: the re-entered Ready state still verifies to success' 0 'SUCCESS: environment'

# AC4 — the overall budget caps settling + retries + verification together, so
# the script always reports the reason instead of being killed by the runner's
# step timeout. (Greptile review, #2219.)
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version'
run_deploy "$M" EB_POLL_INTERVAL_SECONDS='1' EB_SETTLE_TIMEOUT_SECONDS='60' \
  EB_UPDATE_MAX_ATTEMPTS='3' EB_TOTAL_TIMEOUT_SECONDS='2'
check 'AC4: the overall budget bounds the run and names itself in the failure' 1 \
  'overall deploy budget of 2s was exhausted'
TESTS_RUN=$(( TESTS_RUN + 1 ))
if [ "${LAST_DURATION}" -le 20 ]; then
  pass 'AC4: the run really stopped at the overall budget, not the 60s settle cap'
else
  printf '  FAIL %s\n       ran for %ss, expected <= 20s\n' \
    'AC4: the run really stopped at the overall budget, not the 60s settle cap' "${LAST_DURATION}"
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

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
# ENG-837 — an ASYNCHRONOUS EB rejection must fail fast and say why
# ---------------------------------------------------------------------------
#
# The 2026-08-01 production incident, reproduced. PR #2237 changed resource
# configuration (.ebextensions ALB IdleTimeout) and instance configuration
# (.platform nginx + app bundle) in one deploy. EB ACCEPTED update-environment,
# validated asynchronously, rejected it, and left the environment Ready on its
# previous version.
#
# The old script therefore polled a perfectly healthy environment for the full
# 2700s budget and reported a generic "did not come up Ready" timeout. The real
# reason sat in the EB event log the entire time, and the failure was
# misattributed twice to the ENG-777 autoscaling race because nothing surfaced
# it. Production stayed undeployable for ~17 hours.

printf '\nENG-837 (asynchronous EB rejection)\n'

IMMUTABLE_REJECTION='Service:AmazonCloudFormation, Message:Cannot update resource configuration and instance configuration simultaneously with immutable deployments.'

M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version'
printf '%s\n' "${IMMUTABLE_REJECTION}" >"$M/events"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_REJECTION_GRACE_SECONDS='1'
check 'ENG-837: an EB rejection fails the deploy' 1 'Elastic Beanstalk REJECTED this update'
check 'ENG-837: EB own error text is surfaced, not a generic timeout' 1 \
  'Cannot update resource configuration and instance configuration simultaneously'
check 'ENG-837: the failure states the version was not applied' 1 \
  "Version 'backend-20260729-pr2216' was NOT applied"

# AC3 states the rejection must surface "not after the full 2700s budget".
# The budget above is 60s; a correct fail-fast lands in a couple of seconds.
TESTS_RUN=$((TESTS_RUN + 1))
if [ "${LAST_DURATION}" -lt 15 ]; then
  printf "  ok   ENG-837: it fails FAST (%ss) rather than burning the 60s budget\n" "${LAST_DURATION}"
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf "  FAIL ENG-837: took %ss — a rejection must not burn the deploy budget\n" "${LAST_DURATION}"
fi

# Without any event to read, the same state is still terminal: Ready on the old
# version long after the update was accepted means EB took the request and
# declined to apply it. This is the backstop for a rejection EB never events,
# or one whose wording is not in the terminal-pattern list.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version'
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_REJECTION_GRACE_SECONDS='1'
check 'ENG-837: Ready on the old version is terminal even with no ERROR event' 1 \
  'declined to apply it, so this will never converge'

# A gate that fails recoverable deploys gets switched off within a week, so the
# terminal-pattern list is deliberately narrow. An unrelated ERROR event must be
# logged for attribution and must NOT fail a deploy that then succeeds.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
printf '%s\n' 'Service:Amazon EC2, Message:Instance i-0abc has been health-check flagged and replaced.' >"$M/events"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_REJECTION_GRACE_SECONDS='1'
check 'ENG-837: a NON-terminal ERROR event does not fail a recoverable deploy' 0 \
  'SUCCESS: environment'
check 'ENG-837: but it is logged, so the next failure is not misattributed' 0 \
  'health-check flagged and replaced'

# The event scan is a diagnostic overlay. An IAM gap or a throttle on
# describe-events must never take down a deploy that verifies correctly.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
printf '255' >"$M/events_exit"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_REJECTION_GRACE_SECONDS='1'
check 'ENG-837: an unreadable event log is non-fatal' 0 'SUCCESS: environment'
check 'ENG-837: and the inability to read it is stated plainly' 0 'could not read EB events'

# The grace window exists because immediately after update-environment is
# accepted the environment legitimately still reports Ready on the old version
# for a few seconds. A deploy that transitions normally must not be killed.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version' 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_REJECTION_GRACE_SECONDS='120'
check 'ENG-837: a normal deploy passing through Ready-on-old-version is not killed' 0 \
  'SUCCESS: environment'

# ---------------------------------------------------------------------------
# ENG-878 — a lagging environment-health rollup must not fail a healthy deploy.
#
# Live on 2026-08-03: #2252's deploy job failed with "health stayed Red" while
# the instance was Ok, the target group was healthy, the app served 100% 2xx,
# and the environment went Green on its own minutes later. Because ENG-837's
# trunk gate keys off the deploy run's conclusion, that single false failure
# blocked every merge onto main.
# ---------------------------------------------------------------------------

set_healthy_underlying() {
  local dir="$1"
  printf 'i-0d6a42c54cfc58bd7\tOk\n' >"${dir}/instances_health"
  printf 'arn:aws:elasticloadbalancing:us-west-2:1:loadbalancer/app/awseb-AWSEB-X/abc\n' >"${dir}/lb_arns"
  printf 'arn:aws:elasticloadbalancing:us-west-2:1:targetgroup/awseb-AWSEB-UUBAGFYEVPQ1/def\n' >"${dir}/tg_arns"
  printf 'i-0d6a42c54cfc58bd7\thealthy\n' >"${dir}/target_health"
}

# AC1 — Red rollup, everything underneath healthy: PASSES, and says why.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Red|backend-20260729-pr2216'
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878 AC1: a lagging Red rollup over healthy instances/targets passes' 0 \
  'SUCCESS: environment'
check 'ENG-878 AC1: and the log names the lag rather than hiding it' 0 \
  'lagging aggregate'

# Same for Grey, which is the other rollup value that lags.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Grey|backend-20260729-pr2216'
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878 AC1: a lagging Grey rollup over healthy signals also passes' 0 \
  'SUCCESS: environment'

# AC2 — the gate must NOT become "always pass". A genuinely unhealthy instance
# under a Red rollup still fails, and the instance is named.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Red|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf 'i-0d6a42c54cfc58bd7\tSevere\n' >"$M/instances_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878 AC2: a genuinely unhealthy instance still fails the deploy' 1 \
  'EB_DEPLOY_FAILED'
check 'ENG-878 AC3: and the failure names the unhealthy instance' 1 \
  'instance i-0d6a42c54cfc58bd7=Severe'

# AC2 — an unhealthy TARGET also still fails, even with every instance Ok. This
# is the exact shape of the incident's event text ("One or more TargetGroups
# ... Degraded"), so it must be the thing that can still fail the job.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Red|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf 'i-0d6a42c54cfc58bd7\tunhealthy\n' >"$M/target_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878 AC2: an unhealthy load-balancer target still fails the deploy' 1 \
  'EB_DEPLOY_FAILED'
check 'ENG-878 AC3: and the failure names the unhealthy target' 1 \
  'target i-0d6a42c54cfc58bd7=unhealthy'

# Fail-closed: if the probe cannot run, the old failure stands. A probe that
# cannot see the instances must never be read as proof they are fine.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Red|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf 'ERROR|AccessDeniedException: not authorized to perform DescribeInstancesHealth\n' \
  >"$M/instances_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878: an unreadable instance-health probe fails closed, not open' 1 \
  'EB_DEPLOY_FAILED'
check 'ENG-878 AC3: and says the health could not be established' 1 \
  'could not be established'

# An environment with no instances is an empty environment, not a stale rollup.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Red|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf 'NONE\n' >"$M/instances_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878: zero instances is not treated as "nothing unhealthy"' 1 \
  'returned no instances'

# An ALB with zero target groups gave the target loop zero iterations, so
# `unhealthy` stayed empty and the verdict came back LAGGING — vouching for the
# deploy without having checked a single target. Greptile P1 on #2264; the same
# hole the no-instances and no-registered-targets guards already covered.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Red|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf 'None\n' >"$M/tg_arns"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878: an ALB with zero target groups does not silently pass' 1 \
  'returned no target groups'

# A classic (non-ALB) load balancer exposes no target-group ARN, so the probe
# cannot speak for it and must not vouch for the deploy.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Red|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf 'awseb-e-classic-lb\n' >"$M/lb_arns"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878: a classic load balancer leaves the verdict UNKNOWN, so it fails' 1 \
  'no Application Load Balancer ARN'

# Green never reaches the probe at all — the happy path must stay free of the
# extra AWS calls, so a Green deploy passes even with no probe fixtures present.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878: a Green deploy never invokes the probe' 0 'SUCCESS: environment'

# ---------------------------------------------------------------------------
# ENG-878 follow-up — EB_HEALTH_PROBE_DRYRUN exercises the probe on a healthy
# deploy.
#
# The probe only runs when the rollup is still Grey/Red past the settle window,
# which has not happened since #2264 merged. So the branch the fix exists for,
# and the four extra IAM actions it needs, have never executed in production —
# an inert probe and a working one look identical from outside. The dry run
# makes the probe deliberately reachable on an ordinary Green deploy: it runs
# the real AWS calls, reports what it saw, and never touches the exit status.
# ---------------------------------------------------------------------------

# A Green deploy with the dry run on: the probe runs, reports LAGGING-equivalent
# healthy underlying signals, and the deploy still passes on its own merits.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_HEALTH_PROBE_DRYRUN='1'
check 'ENG-878 dry run: a Green deploy still succeeds' 0 'SUCCESS: environment'
check 'ENG-878 dry run: and reports the probe verdict it would have used' 0 \
  'probe dry run: verdict=LAGGING'
check 'ENG-878 dry run: and says the verdict did not affect this deploy' 0 \
  'did not affect this deploy'

# The case this exists to catch: the deploy role is missing one of the four IAM
# actions, so the probe is inert. Today that only surfaces during a real Red
# rollup — i.e. exactly when it is too late. The dry run must name it loudly on
# an otherwise-passing deploy, without failing that deploy.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf 'ERROR|An error occurred (AccessDenied) when calling the DescribeInstancesHealth operation\n' \
  >"$M/instances_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_HEALTH_PROBE_DRYRUN='1'
check 'ENG-878 dry run: an inert probe does not fail a healthy deploy' 0 \
  'SUCCESS: environment'
check 'ENG-878 dry run: but it is reported as INERT, not quietly swallowed' 0 \
  'probe dry run: verdict=UNKNOWN'
check 'ENG-878 dry run: and names the denied AWS call' 0 'AccessDenied'

# A genuinely unhealthy target under a Green rollup is still only an
# observation: the dry run reports it and the deploy's own verdict stands.
# Making the dry run able to fail a deploy would turn a diagnostic into a new
# and untested gate.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf 'i-0d6a42c54cfc58bd7\tunhealthy\n' >"$M/target_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_HEALTH_PROBE_DRYRUN='1'
check 'ENG-878 dry run: never changes the deploy verdict' 0 'SUCCESS: environment'
check 'ENG-878 dry run: reports UNHEALTHY as an observation' 0 \
  'probe dry run: verdict=UNHEALTHY'

# Default off: no flag, no extra AWS calls, output identical to before. This is
# the property the merged fix deliberately has, and the dry run must not cost
# every deploy four API calls to keep it.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-878 dry run: off by default' 0 'SUCCESS: environment'
if printf '%s' "${LAST_OUTPUT}" | grep -qF 'probe dry run'; then
  printf '  FAIL ENG-878 dry run: off by default emits no probe output\n       output:\n%s\n' \
    "${LAST_OUTPUT}"
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
else
  pass 'ENG-878 dry run: off by default emits no probe output'
fi
TESTS_RUN=$(( TESTS_RUN + 1 ))

# The Red-rollup path is authoritative and must be unchanged by the flag: with
# the dry run on, a real lagging rollup still passes through the normal probe
# and reports the lag, not a dry-run observation.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Red|backend-20260729-pr2216'
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_HEALTH_PROBE_DRYRUN='1'
check 'ENG-878 dry run: the authoritative Red path is unaffected' 0 'lagging aggregate'

# ---------------------------------------------------------------------------

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
