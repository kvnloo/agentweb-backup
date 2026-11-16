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
#   clock              ENG-1522: the virtual clock eb-deploy.sh reads through
#                      EB_CLOCK_FILE. Advanced by clock_tick on every
#                      describe-environments call, so one tick == one poll.
#   clock_tick         seconds added per poll (default 1).
MOCK_DIR="${EB_MOCK_DIR:?EB_MOCK_DIR must be set}"

operation="${2:-}"
all_args="$*"

# Preserve the exact AWS operation order so lifecycle-hook tests can prove the
# hook is installed before update-environment starts terminating old instances.
printf '%s\n' "$operation" >>"${MOCK_DIR}/operations"

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

    # ENG-1522: one describe-environments call is exactly one poll iteration, so
    # advancing here makes eb-deploy.sh's clock a function of the scripted event
    # sequence instead of the runner's wall clock. That is what removes the race:
    # now_seconds() is now CONSTANT within an iteration, so the two reads that
    # stamp and then test `ready_since` can no longer straddle a second boundary.
    if [ -f "${MOCK_DIR}/clock" ]; then
      tick=1
      [ -f "${MOCK_DIR}/clock_tick" ] && tick=$(cat "${MOCK_DIR}/clock_tick")
      printf '%s\n' "$(( $(cat "${MOCK_DIR}/clock") + tick ))" >"${MOCK_DIR}/clock"
    fi

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
    #
    # ENG-3039: a `--severity INFO` call is the rollout-completion scan, served
    # from its own fixtures (`info_events`, one message per line NEWEST FIRST
    # as EB returns them, and `info_events_exit`) so the ERROR scan above keeps
    # reading exactly what it always read.
    case "$all_args" in
      *'--severity INFO'*)
        printf '%s\n' "$all_args" >"${MOCK_DIR}/info_events_args"
        code=0
        [ -f "${MOCK_DIR}/info_events_exit" ] && code=$(cat "${MOCK_DIR}/info_events_exit")
        if [ "$code" != "0" ]; then
          printf 'mock aws: simulated describe-events (INFO) failure\n' >&2
          exit "$code"
        fi
        if [ -f "${MOCK_DIR}/info_events" ]; then
          cat "${MOCK_DIR}/info_events"
        else
          printf 'None\n'
        fi
        exit 0
        ;;
    esac
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
    # ENG-3082: the per-instance DEPLOYMENT read (which version each instance
    # reports as deployed) has its own fixture, `instances_deployment`, holding
    # "<instance-id><TAB><HealthStatus><TAB><VersionLabel><TAB><DeployStatus>"
    # lines or "ERROR|<message>", so the ENG-878 health fixture below keeps
    # serving exactly what it always served.
    if grep -qF 'Deployment.VersionLabel' <<<"$query"; then
      if [ -f "${MOCK_DIR}/instances_deployment" ]; then
        first=$(head -n 1 "${MOCK_DIR}/instances_deployment")
        if [ "${first%%|*}" = "ERROR" ]; then
          printf '%s\n' "${first#*|}" >&2
          exit 255
        fi
        cat "${MOCK_DIR}/instances_deployment"
      else
        printf 'None\n'
      fi
      exit 0
    fi
    # ENG-878: the non-lagging per-instance signal. Fixture `instances_health`
    # holds "<instance-id><TAB><HealthStatus>" lines, the literal token NONE for
    # an empty environment, or "ERROR|<message>" to simulate an API/IAM failure.
    if [ -f "${MOCK_DIR}/instances_health" ]; then
      first=$(head -n 1 "${MOCK_DIR}/instances_health")
      if [ "${first%%|*}" = "ERROR" ]; then
        printf '%s\n' "${first#*|}" >&2
        exit 255
      fi
      if [ "${first%%|*}" = "SLEEP" ]; then
        # Simulates a stalled/throttled AWS call so the dry run's own timeout
        # is exercised rather than assumed. The PID is recorded so a test can
        # prove the descendant was actually reaped, not just its wrapper.
        printf '%s\n' "$$" >"${MOCK_DIR}/stall_pid"
        sleep "${first#*|}"
        printf 'None\n'
        exit 0
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
    # ENG-1277: here-string, not a pipe — avoids a SIGPIPE-under-pipefail race
    # if grep exits early on a match (see trunk-deploy-state.test.sh's fix).
    if grep -qF 'AutoScalingGroups' <<<"$query"; then
      cat "${MOCK_DIR}/asg_name" 2>/dev/null || printf 'awseb-e-test-stack-AWSEBAutoScalingGroup-test\n'
      exit 0
    fi
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

  put-lifecycle-hook)
    code=0
    [ -f "${MOCK_DIR}/put_lifecycle_hook_exit" ] && code=$(cat "${MOCK_DIR}/put_lifecycle_hook_exit")
    if [ "$code" != "0" ]; then
      cat "${MOCK_DIR}/put_lifecycle_hook_error" 2>/dev/null >&2 || \
        printf 'mock aws: simulated put-lifecycle-hook failure\n' >&2
      exit "$code"
    fi
    printf '%s\n' "$all_args" >"${MOCK_DIR}/put_lifecycle_hook_args"
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

  describe-target-group-attributes)
    # Fixture `tg_attrs`: current deregistration_delay value, or "ERROR|<msg>".
    if [ -f "${MOCK_DIR}/tg_attrs_exit" ]; then
      code=$(cat "${MOCK_DIR}/tg_attrs_exit")
      printf 'mock aws: simulated describe-target-group-attributes failure\n' >&2
      exit "$code"
    fi
    val='20'
    [ -f "${MOCK_DIR}/tg_attrs" ] && val=$(cat "${MOCK_DIR}/tg_attrs")
    printf '%s\n' "$val"
    exit 0
    ;;

  modify-target-group-attributes)
    printf '%s\n' "$all_args" >>"${MOCK_DIR}/modify_tg_calls"
    if [ -f "${MOCK_DIR}/modify_tg_exit" ]; then
      code=$(cat "${MOCK_DIR}/modify_tg_exit")
      printf 'mock aws: simulated modify-target-group-attributes failure\n' >&2
      exit "$code"
    fi
    # Applying the mutation updates what the next describe call reports,
    # unless the fixture wants to prove a silent-drop scenario (tg_attrs_stuck).
    if [ ! -f "${MOCK_DIR}/tg_attrs_stuck" ]; then
      for pair in $all_args; do
        case "$pair" in
          Key=deregistration_delay.timeout_seconds,Value=*)
            printf '%s\n' "${pair#*Value=}" >"${MOCK_DIR}/tg_attrs"
            ;;
        esac
      done
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
  printf '0\n' >"${dir}/clock"
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
    EB_CLOCK_FILE="${dir}/clock" \
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

  # ENG-1277: here-string, not a pipe. Under `set -o pipefail` (line 15),
  # `grep -q` exiting early on the first match can SIGPIPE the upstream
  # printf, and pipefail then reports THAT nonzero for the whole pipeline even
  # though grep genuinely matched — a race that passes locally most of the
  # time and fails intermittently (this is very likely the root cause of the
  # local 1-in-5 flake observed on this exact file during ENG-1277). A
  # here-string has no live producer process for grep to SIGPIPE.
  if [ -n "${needle}" ] && ! grep -qF "${needle}" <<<"${LAST_OUTPUT}"; then
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
# ENG-823 — ensure_deregistration_delay sets DeregistrationDelay directly
# against the live target group after a verified deploy, since two straight
# `.ebextensions` fixes both silently failed to apply it.
# ---------------------------------------------------------------------------

# Not opted in (EB_DEREGISTRATION_DELAY_SECONDS unset): zero extra AWS calls.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60'
check 'ENG-823: opted-out deploy still succeeds' 0 'SUCCESS: environment'
if grep -qF 'DeregistrationDelay' "${WORKDIR}/out.txt"; then
  printf '  FAIL ENG-823: opted-out deploy made a DeregistrationDelay call anyway\n'
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
else
  pass 'ENG-823: opted-out deploy makes no DeregistrationDelay call'
fi
TESTS_RUN=$(( TESTS_RUN + 1 ))

# Opted in, target group currently at the AWS default: applies and verifies.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf '20\n' >"$M/tg_attrs"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_DEREGISTRATION_DELAY_SECONDS='600'
check 'ENG-823: opted-in deploy still succeeds' 0 'SUCCESS: environment'
check 'ENG-823: sets DeregistrationDelay on the live target group' 0 \
  'Setting DeregistrationDelay on target group def: 20s -> 600s.'
check 'ENG-823: confirms the value by re-reading it, not by trusting the call' 0 \
  'Confirmed DeregistrationDelay=600s on target group def.'

# Already at the desired value: no-op, no mutation call.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf '600\n' >"$M/tg_attrs"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_DEREGISTRATION_DELAY_SECONDS='600'
check 'ENG-823: already-correct value is a no-op' 0 \
  'already 600s on target group def; no change needed.'
if [ -f "$M/modify_tg_calls" ]; then
  printf '  FAIL ENG-823: no-op case still called modify-target-group-attributes\n'
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
else
  pass 'ENG-823: already-correct value makes no modify call'
fi
TESTS_RUN=$(( TESTS_RUN + 1 ))

# The regression this exists to catch: modify-target-group-attributes reports
# success but the value is silently dropped, exactly like .ebextensions did
# twice. Must fail the job rather than report a false green.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf '20\n' >"$M/tg_attrs"
: >"$M/tg_attrs_stuck"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_DEREGISTRATION_DELAY_SECONDS='600'
check 'ENG-823: a silently-dropped value fails the job, not a false green' 1 \
  'still reads 20s, not the desired 600s'

# A denied elbv2 call fails loudly rather than reporting the deploy as fully
# applied when it was not.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf '20\n' >"$M/tg_attrs"
printf '1\n' >"$M/modify_tg_exit"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_DEREGISTRATION_DELAY_SECONDS='600'
check 'ENG-823: a denied modify-target-group-attributes call fails the job' 1 \
  'modify-target-group-attributes failed for'

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
# ENG-1277: here-string, not a pipe — see the check() fix above for why.
if grep -qF 'probe dry run' <<<"${LAST_OUTPUT}"; then
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

# A stalled probe must not hold the script open past the step's timeout and turn
# an already-confirmed deploy into a false failure — the exact defect this whole
# change removes, which the diagnostic would otherwise reintroduce. The probe is
# abandoned on its own budget and reported as INERT.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
printf 'SLEEP|30\n' >"$M/instances_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_HEALTH_PROBE_DRYRUN='1' \
  EB_HEALTH_PROBE_DRYRUN_TIMEOUT_SECONDS='2'
check 'ENG-878 dry run: a stalled probe never fails the deploy' 0 'SUCCESS: environment'
check 'ENG-878 dry run: the stall is reported, not swallowed' 0 'was abandoned'
check 'ENG-878 dry run: and a stalled probe reads as INERT' 0 'probe dry run: INERT'

# Abandoning the probe must kill the stalled AWS call itself, not just the shell
# wrapping it: a surviving descendant keeps the script's stdout/stderr open and
# can hold the already-successful step until the workflow timeout kills it.
TESTS_RUN=$((TESTS_RUN + 1))
stall_pid=$(cat "$M/stall_pid" 2>/dev/null || true)
if [ -n "${stall_pid}" ] && ! kill -0 "${stall_pid}" 2>/dev/null; then
  printf 'PASS: ENG-878 dry run: the stalled AWS descendant is killed, not just its wrapper\n'
else
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf 'FAIL: ENG-878 dry run: the stalled AWS descendant is killed, not just its wrapper (pid=%s)\n' "${stall_pid:-<none>}"
fi

# With almost none of the deploy budget left, the diagnostic is skipped outright
# rather than spending the seconds the script needs to exit on its own terms.
M=$(new_mock_dir)
set_describe_states "$M" 'Updating|Grey|old-version' 'Ready|Green|backend-20260729-pr2216'
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_HEALTH_PROBE_DRYRUN='1' \
  EB_HEALTH_PROBE_DRYRUN_MARGIN_SECONDS='9999'
check 'ENG-878 dry run: skipped when the budget is nearly spent' 0 'probe dry run: SKIPPED'
check 'ENG-878 dry run: skipping still leaves the deploy successful' 0 'SUCCESS: environment'

# ---------------------------------------------------------------------------
# ENG-1127: an aborted rollout is recoverable, not terminal.
#
# 2026-08-11, PR #2313: an ASG replacement instance joined 31s before the deploy
# landed, ran its self-startup pipeline concurrently with app-deploy, and both
# staged into /var/app/staging/. One flipped it to /var/app/current/ and the
# other's container_command then died on the missing directory. EB got 3-of-4,
# aborted the rollout, and reverted the environment's version pointer.
#
# verify_deployment saw Ready-on-the-old-version and declared "this will never
# converge" — which was false. Nothing was wrong with the bundle or the config;
# the next deploy to land (PR #2352, 28 minutes later) applied cleanly and took
# the environment Green. The cost of calling it terminal is a red PR and a
# ~30 runner-minute re-run of a suite that had just passed.
#
# So: this exact signature re-applies within the existing budget. Every other
# terminal condition is untouched, and a terminal pattern still wins outright.
# ---------------------------------------------------------------------------

ABORT_EVENTS='During an aborted deployment, some instances may have deployed the new application version.	Failed to deploy application.	Unsuccessful command execution on instance id(s) '"'"'i-05f5717b884b5ec85'"'"'. Aborting the operation.'

# The rollout aborts once, the re-apply converges, and the job goes green.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Ready|Green|old-version' \
  'Ready|Green|old-version' \
  'Ready|Green|old-version' \
  'Updating|Grey|old-version' \
  'Ready|Green|backend-20260729-pr2216'
printf '%s\n' "${ABORT_EVENTS}" >"$M/events"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_REJECTION_GRACE_SECONDS='1' \
  EB_POLL_INTERVAL_SECONDS='1'
check 'ENG-1127: an aborted rollout is re-applied instead of failing the job' 0 \
  'SUCCESS: environment'
check 'ENG-1127: the re-apply is announced, not silent' 0 \
  'aborted the rollout on a subset of instances'

# Bounded. An abort that keeps aborting still fails — but with the real reason,
# not the false "will never converge" claim.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version'
printf '%s\n' "${ABORT_EVENTS}" >"$M/events"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_REJECTION_GRACE_SECONDS='1' \
  EB_POLL_INTERVAL_SECONDS='1'
check 'ENG-1127: a repeating abort still fails the job' 1 \
  'EB_DEPLOY_FAILED'
check 'ENG-1127: and the failure names the abort rather than claiming it never converges' 1 \
  'aborted the rollout of version'

# The re-apply is opt-outable, so a bad day can be pinned back to old behaviour
# without a code change.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version'
printf '%s\n' "${ABORT_EVENTS}" >"$M/events"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_REJECTION_GRACE_SECONDS='1' \
  EB_POLL_INTERVAL_SECONDS='1' EB_ABORT_MAX_RETRIES='0'
check 'ENG-1127: EB_ABORT_MAX_RETRIES=0 restores the immediate failure' 1 \
  'EB_DEPLOY_FAILED'

# Safety: a genuine terminal rejection must still fail immediately even when an
# abort event is sitting next to it. Terminal wins; recoverable never masks it.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version'
printf '%s\n' "${ABORT_EVENTS}	Configuration validation exception: Invalid option value" >"$M/events"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='60' EB_REJECTION_GRACE_SECONDS='1' \
  EB_POLL_INTERVAL_SECONDS='1'
check 'ENG-1127: a terminal pattern still wins over a co-occurring abort' 1 \
  'Elastic Beanstalk REJECTED this update'

# ---------------------------------------------------------------------------

# ENG-764 — every deploy must recreate the termination lifecycle hook before
# update-environment can retire an old instance. A one-time console hook is
# lost when EB replaces its ASG, silently reviving deploy-killed scheduled runs.
M=$(new_mock_dir)
set_describe_states "$M" \
  'Ready|Green|old-version' \
  'Updating|Grey|old-version' \
  'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='30'
TESTS_RUN=$(( TESTS_RUN + 1 ))
if [ "$(grep -c '^put-lifecycle-hook$' "$M/operations" 2>/dev/null || true)" = 1 ]; then
  pass 'ENG-764: the deploy installs exactly one termination lifecycle hook'
else
  printf '  FAIL ENG-764: the deploy installs exactly one termination lifecycle hook\n'
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

TESTS_RUN=$(( TESTS_RUN + 1 ))
hook_line=$(grep -n '^put-lifecycle-hook$' "$M/operations" | cut -d: -f1 || true)
update_line=$(grep -n '^update-environment$' "$M/operations" | head -1 | cut -d: -f1 || true)
if [ -n "$hook_line" ] && [ -n "$update_line" ] && [ "$hook_line" -lt "$update_line" ]; then
  pass 'ENG-764: the lifecycle hook is installed before update-environment'
else
  printf '  FAIL ENG-764: lifecycle hook must precede update-environment (hook=%s update=%s)\n' \
    "${hook_line:-missing}" "${update_line:-missing}"
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

TESTS_RUN=$(( TESTS_RUN + 1 ))
if grep -q -- '--lifecycle-hook-name agentweb-drain-before-terminate' "$M/put_lifecycle_hook_args" 2>/dev/null && \
   grep -q -- '--heartbeat-timeout 900' "$M/put_lifecycle_hook_args" 2>/dev/null && \
   grep -q -- '--default-result CONTINUE' "$M/put_lifecycle_hook_args" 2>/dev/null; then
  pass 'ENG-764: the installed hook keeps the reviewed name and bounded fail-open settings'
else
  printf '  FAIL ENG-764: hook arguments do not match the reviewed safety contract\n'
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

# Passing control in the red phase: the existing deploy behavior is unchanged
# until the new hook assertions above are implemented.
check 'ENG-764 control: the underlying deploy still reaches success' 0 'SUCCESS: environment'

M=$(new_mock_dir)
printf '255\n' >"$M/put_lifecycle_hook_exit"
printf 'AccessDenied: not authorized to perform autoscaling:PutLifecycleHook\n' \
  >"$M/put_lifecycle_hook_error"
run_deploy "$M"
check 'ENG-764: a denied lifecycle-hook install fails the deploy closed' 1 \
  'refusing to start a deploy that could cut off scheduled work'
TESTS_RUN=$(( TESTS_RUN + 1 ))
if ! grep -q '^update-environment$' "$M/operations"; then
  pass 'ENG-764: hook failure happens before update-environment can terminate an instance'
else
  printf '  FAIL ENG-764: update-environment ran after the hook failed\n'
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

M=$(new_mock_dir)
printf 'None\n' >"$M/asg_name"
run_deploy "$M"
check 'ENG-764: an environment with no ASG fails loudly' 1 \
  'returned no Auto Scaling group'

# ---------------------------------------------------------------------------
# ENG-1522 — the clock seam must never reach production.
#
# now_seconds() honours EB_CLOCK_FILE so this suite can drive time from the
# mocked event sequence instead of the wall clock. That seam is harmless only
# while it stays test-only: a workflow that set EB_CLOCK_FILE would freeze the
# deploy's sense of time, and every budget in eb-deploy.sh -- the overall run
# deadline, the settle timeout, the health settle window, the EB rejection
# grace -- is a comparison against now_seconds(). A frozen clock means none of
# them can ever expire, so a hung or rejected deploy would poll forever instead
# of failing, in the script whose false-success and non-convergence modes cost
# ~17h (ENG-865) and ~29h (ENG-836) of production downtime.
#
# No script under test here: this asserts the workflows themselves, the same
# shape as paths-filter-hygiene.test.sh. It lives in this suite rather than a
# new file on purpose -- three suites have already been found orphaned and
# silently red in this repo (staging-deploy-gate, coverage-report,
# paths-filter negation), and this one is already wired into `CI script tests`.
printf '\nENG-1522: the clock seam is test-only\n'

WORKFLOW_DIR="${SCRIPT_DIR}/../workflows"

TESTS_RUN=$(( TESTS_RUN + 1 ))
clock_offenders=""
for wf in "${WORKFLOW_DIR}"/*.yml "${WORKFLOW_DIR}"/*.yaml; do
  [ -e "${wf}" ] || continue
  if grep -qE '(^|[^A-Z_])EB_CLOCK_FILE' "${wf}"; then
    clock_offenders="${clock_offenders} $(basename "${wf}")"
  fi
done
if [ -z "${clock_offenders}" ]; then
  pass 'ENG-1522: no workflow sets EB_CLOCK_FILE'
else
  printf '  FAIL ENG-1522: workflow(s) reference EB_CLOCK_FILE:%s\n' "${clock_offenders}"
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

# Self-check. Current exposure is zero, so without proving the detector can
# fail, a broken scan and a clean repo are indistinguishable -- exactly the
# fail-open shape CodeRabbit caught in paths-filter-hygiene.
TESTS_RUN=$(( TESTS_RUN + 1 ))
probe_dir="$(mktemp -d "${WORKDIR}/wfprobe.XXXXXX")"
printf 'jobs:\n  deploy:\n    env:\n      EB_CLOCK_FILE: /tmp/x\n' >"${probe_dir}/bad.yml"
probe_hits=""
for wf in "${probe_dir}"/*.yml; do
  grep -qE '(^|[^A-Z_])EB_CLOCK_FILE' "${wf}" && probe_hits="yes"
done
if [ -n "${probe_hits}" ]; then
  pass 'ENG-1522: self-check — the scan detects a workflow that does set it'
else
  printf '  FAIL ENG-1522: the EB_CLOCK_FILE scan cannot detect an offender (fail-open)\n'
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

# The production default must remain a real clock read.
TESTS_RUN=$(( TESTS_RUN + 1 ))
real_now=$(env -u EB_CLOCK_FILE bash -c \
  "$(sed -n '/^now_seconds() {/,/^}/p' "${EB_DEPLOY_SCRIPT}"); now_seconds")
if [ "${real_now}" -gt 1000000000 ]; then
  pass 'ENG-1522: with EB_CLOCK_FILE unset, now_seconds() returns real epoch time'
else
  printf '  FAIL ENG-1522: now_seconds() did not fall back to date +%%s when unset\n'
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

# ---------------------------------------------------------------------------
# ENG-1183 — the deploy budgets must be consistent with the deployment policy.
#
# Three numbers govern a deploy and they are declared in two different files:
# `timeout-minutes` and EB_TOTAL_TIMEOUT_SECONDS/EB_SETTLE_TIMEOUT_SECONDS in
# deploy.yml, and EB's own command Timeout in backend/.ebextensions. Nothing
# related them to each other, so they drifted: the settle cap sat on the
# script's 600s default -- a Rolling-era number -- for the two months after
# rolling.config switched the environment to Immutable on 2026-07-01.
#
# The settle cap is not a soft wait. On expiry wait_for_environment_ready()
# calls fail(), so an environment that is merely busy is reported as
# "Version was NOT applied". Under Immutable, busy-for-longer-than-600s is
# ordinary: 24 consecutive production deploys measured median ~535s, max 1352s.
#
# These are structural assertions over the workflow and the EB config -- no
# script under test -- the same shape as the ENG-1522 block above, and they
# live in this suite for the same reason: it is already wired into
# `CI script tests`, and orphaned suites in this repo have a habit of going
# silently red (staging-deploy-gate, coverage-report, paths-filter negation).
printf '\nENG-1183: deploy budgets are consistent with the deployment policy\n'

REPO_ROOT="${SCRIPT_DIR}/../.."
DEPLOY_WORKFLOW="${WORKFLOW_DIR}/deploy.yml"

# Emits one `job|timeout-minutes|total|settle` record per step that actually
# runs eb-deploy.sh. Steps are flushed when the next one starts, so the `run:`
# line at the bottom of a step is still attributed to it.
eb_budget_records() {
  awk '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/     { job=$1; sub(/:$/,"",job); next }
    /^      - /                           { if (has) print job "|" tmo "|" tot "|" stl
                                            has=0; tmo=""; tot=""; stl="" }
    /^        timeout-minutes:/           { tmo=$2 }
    /EB_TOTAL_TIMEOUT_SECONDS:/           { v=$2; gsub(/[^0-9]/,"",v); tot=v }
    /EB_SETTLE_TIMEOUT_SECONDS:/          { v=$2; gsub(/[^0-9]/,"",v); stl=v }
    /run: bash \.github\/scripts\/eb-deploy\.sh/ { has=1 }
    END                                   { if (has) print job "|" tmo "|" tot "|" stl }
  ' "$1"
}

# The script's own default, read rather than hardcoded: raising it there instead
# of in the workflow is an equally valid fix and must keep this suite green.
DEFAULT_SETTLE=$(grep -m1 '^EB_SETTLE_TIMEOUT_SECONDS=' "${EB_DEPLOY_SCRIPT}")
DEFAULT_SETTLE="${DEFAULT_SETTLE##*:-}"   # ...:-600}"  ->  600}"
DEFAULT_SETTLE="${DEFAULT_SETTLE%%\}*}"   # 600}"       ->  600

# EB's command Timeout on the Immutable environment. Waiting less than this
# means failing a deploy while EB still considers the in-flight command live.
EB_COMMAND_TIMEOUT=""
for cfg in "${REPO_ROOT}"/backend/.ebextensions/*.config; do
  [ -e "${cfg}" ] || continue
  if grep -qE 'DeploymentPolicy:[[:space:]]*Immutable' "${cfg}"; then
    EB_COMMAND_TIMEOUT=$(awk '/^[[:space:]]+Timeout:[[:space:]]*[0-9]+/ {print $2; exit}' "${cfg}")
  fi
done

# Worst observed single Immutable rollout on production (1352s) plus margin.
# What must remain of the budget after settling to still run our own deploy.
MIN_OWN_DEPLOY_SECONDS=1400

BUDGET_RECORDS=$(eb_budget_records "${DEPLOY_WORKFLOW}")

# Fail-open guard first: every assertion below is a no-op if the extractor
# matched nothing, which is indistinguishable from a clean repo.
TESTS_RUN=$(( TESTS_RUN + 1 ))
if [ "$(printf '%s\n' "${BUDGET_RECORDS}" | grep -c '|')" -ge 2 ]; then
  pass 'ENG-1183: the budget extractor found both eb-deploy.sh steps'
else
  printf '  FAIL ENG-1183: extractor found %s eb-deploy.sh step(s) in deploy.yml (fail-open)\n' \
    "$(printf '%s\n' "${BUDGET_RECORDS}" | grep -c '|')"
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

TESTS_RUN=$(( TESTS_RUN + 1 ))
if [ -n "${EB_COMMAND_TIMEOUT}" ]; then
  pass "ENG-1183: read EB command Timeout=${EB_COMMAND_TIMEOUT}s from the Immutable config"
else
  printf '  FAIL ENG-1183: no .ebextensions config declares DeploymentPolicy: Immutable with a Timeout\n'
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

while IFS='|' read -r job tmo tot stl; do
  [ -n "${job}" ] || continue
  [ -n "${stl}" ] || stl="${DEFAULT_SETTLE}"
  step_budget=$(( tmo * 60 ))

  # The script budget must expire first, or the runner SIGKILLs it mid-poll and
  # the diagnostic that names the real cause is replaced by "step timed out".
  TESTS_RUN=$(( TESTS_RUN + 1 ))
  if [ "${tot}" -lt "${step_budget}" ]; then
    pass "ENG-1183: ${job} script budget ${tot}s expires before the ${step_budget}s step timeout"
  else
    printf '  FAIL ENG-1183: %s budget %ss >= step timeout %ss; the script can never report why\n' \
      "${job}" "${tot}" "${step_budget}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
  fi

  TESTS_RUN=$(( TESTS_RUN + 1 ))
  if [ "${stl}" -lt "${tot}" ]; then
    pass "ENG-1183: ${job} settle cap ${stl}s fits inside the ${tot}s budget"
  else
    printf '  FAIL ENG-1183: %s settle cap %ss >= budget %ss\n' "${job}" "${stl}" "${tot}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
  fi

  # Immutable-only bounds. partner-deploy is a different application with no
  # .ebextensions in this repo and ~60s deploys, so the 600s default is already
  # 10x headroom there and these two would be meaningless. If the environment
  # ever stops being Immutable these are skipped rather than compared against
  # an empty timeout -- the check above already went red naming that as the
  # reason, and every number here would need re-deriving anyway.
  case "${job}" in
    backend-*) ;;
    *) continue ;;
  esac
  [ -n "${EB_COMMAND_TIMEOUT}" ] || continue

  TESTS_RUN=$(( TESTS_RUN + 1 ))
  if [ "${stl}" -ge "${EB_COMMAND_TIMEOUT}" ]; then
    pass "ENG-1183: ${job} settle cap ${stl}s >= EB command Timeout ${EB_COMMAND_TIMEOUT}s"
  else
    printf '  FAIL ENG-1183: %s settle cap %ss gives up before EB command Timeout %ss; a busy-but-healthy environment is failed as "Version was NOT applied"\n' \
      "${job}" "${stl}" "${EB_COMMAND_TIMEOUT}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
  fi

  TESTS_RUN=$(( TESTS_RUN + 1 ))
  headroom=$(( tot - stl ))
  if [ "${headroom}" -ge "${MIN_OWN_DEPLOY_SECONDS}" ]; then
    pass "ENG-1183: ${job} leaves ${headroom}s after settling for its own Immutable rollout"
  else
    printf '  FAIL ENG-1183: %s leaves only %ss after settling, below the %ss an Immutable rollout has been measured to need\n' \
      "${job}" "${headroom}" "${MIN_OWN_DEPLOY_SECONDS}"
    TESTS_FAILED=$(( TESTS_FAILED + 1 ))
  fi
done <<EOF
${BUDGET_RECORDS}
EOF

# Self-check. Every assertion above currently passes, so without proving the
# extractor can see a violation, a broken parser reads exactly like a healthy
# repo -- the fail-open shape CodeRabbit caught in paths-filter-hygiene.
TESTS_RUN=$(( TESTS_RUN + 1 ))
budget_probe_dir="$(mktemp -d "${WORKDIR}/budgetprobe.XXXXXX")"
cat >"${budget_probe_dir}/deploy.yml" <<'PROBE'
jobs:
  backend-deploy:
    steps:
      - name: Deploy to Elastic Beanstalk and verify the environment took it
        timeout-minutes: 10
        env:
          EB_TOTAL_TIMEOUT_SECONDS: '600'
          EB_SETTLE_TIMEOUT_SECONDS: '30'
        run: bash .github/scripts/eb-deploy.sh
PROBE
probe_record=$(eb_budget_records "${budget_probe_dir}/deploy.yml")
if [ "${probe_record}" = "backend-deploy|10|600|30" ]; then
  pass 'ENG-1183: self-check — the extractor reads a step it has never seen'
else
  printf '  FAIL ENG-1183: extractor returned %s on the probe workflow (fail-open)\n' \
    "${probe_record:-<nothing>}"
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

# ---------------------------------------------------------------------------
# ENG-3039 -- a later update that this deploy did not start must not turn an
# applied release into a failed deploy.
#
# Production, 2026-11-06, run 42150471207 (merge of #3910). Elastic Beanstalk
# finished rolling out backend-20261106-pr3910 at 02:53:52Z. Eight seconds
# later, at 02:54:00Z, an environment-variable change made outside this
# workflow (CloudTrail: UpdateEnvironment with optionSettings, a different
# principal) started a second Immutable update that ran until 03:21:06Z. The
# environment was Ready for less time than one 15s poll, so every poll read
# `Status=Updating Health=Green Version=backend-20261106-pr3910` and the run
# failed at 03:16Z with "did not come up Ready ... within the overall deploy
# budget of 2700s" -- 22 minutes after the release was serving.
#
# The fixtures below are that sequence: the status line the run logged on every
# poll, and the INFO events EB recorded for the window, newest first.
# ---------------------------------------------------------------------------

printf '\nENG-3039: a later foreign update does not fail an applied release\n'

EB_ROLLOUT_DONE='New application version was deployed to running EC2 instances.'

# Newest first, as describe-events returns them.
set_rollout_then_foreign_update() {
  local dir="$1"
  {
    printf '%s\n' 'Created temporary auto scaling group awseb-e-x-immutable-stack-AWSEBAutoScalingGroup-kuBocPpTarbW.'
    printf '%s\n' 'Immutable deployment policy enabled. Launching one instance with the new settings to verify health.'
    printf '%s\n' 'Environment update is starting.'
    printf '%s\n' 'Environment update completed successfully.'
    printf '%s\n' "${EB_ROLLOUT_DONE}"
    printf '%s\n' 'Deployment succeeded. Terminating old instances and temporary Auto Scaling group.'
    printf '%s\n' 'Environment update is starting.'
  } >"${dir}/info_events"
}

# The 11-06 replay: rollout logged complete, instances and targets healthy,
# environment Updating on OUR version because of someone else's update.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version' 'Updating|Green|backend-20260729-pr2216'
set_rollout_then_foreign_update "$M"
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3039: the 2026-11-06 sequence is a success, not a budget timeout' 0 \
  'SUCCESS: environment'
check 'ENG-3039: the success says a later update is still running' 0 \
  'a later update that this deploy did not start'

# The event window must open before the accept stamp, or EB's own "update is
# starting" line (stamped while the request is still being handled, a second
# before the CLI returned on 11-06) falls outside it. The harness clock starts
# at 0, so a window that looks back lands in 1969 and one that does not lands
# in 1970.
TESTS_RUN=$(( TESTS_RUN + 1 ))
if grep -qF -- '--start-time 1969-12-31T23:59:' "$M/info_events_args" 2>/dev/null; then
  pass 'ENG-3039: the event window opens before the accept stamp'
else
  printf '  FAIL ENG-3039: event window did not look back before the accept stamp: %s\n' \
    "$(cat "$M/info_events_args" 2>/dev/null || echo '<no INFO describe-events call>')"
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

# A failed deploy must still fail. Each case below removes one leg of the proof.

# No completion event: this is an ordinary rollout still in flight (or stuck).
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version' 'Updating|Green|backend-20260729-pr2216'
{
  printf '%s\n' 'Deployment succeeded. Terminating old instances and temporary Auto Scaling group.'
  printf '%s\n' 'Environment update is starting.'
} >"$M/info_events"
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3039: Updating with no rollout-complete event still fails on the budget' 1 \
  'did not come up Ready'

# Completion logged but an instance is not Ok: not proven serving, keep failing.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version' 'Updating|Green|backend-20260729-pr2216'
set_rollout_then_foreign_update "$M"
set_healthy_underlying "$M"
printf 'i-0d6a42c54cfc58bd7\tSevere\n' >"$M/instances_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3039: rollout complete but an instance not Ok still fails' 1 \
  'did not come up Ready'

# A completion event with no "update is starting" before it belongs to the
# PREVIOUS deploy (runner clock a few seconds behind EB's). It proves nothing
# about this rollout.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version' 'Updating|Green|backend-20260729-pr2216'
{
  printf '%s\n' 'Immutable deployment policy enabled. Launching one instance with the new settings to verify health.'
  printf '%s\n' 'Environment update is starting.'
  printf '%s\n' 'Environment update completed successfully.'
  printf '%s\n' "${EB_ROLLOUT_DONE}"
} >"$M/info_events"
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3039: a completion event from the previous deploy is not accepted' 1 \
  'did not come up Ready'

# The environment is Updating on ANOTHER version: the event log is irrelevant.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version' 'Updating|Green|old-version'
set_rollout_then_foreign_update "$M"
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3039: Updating on another version is never a success' 1 \
  'did not come up Ready'

# An unreadable event log cannot be read as proof.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version' 'Updating|Green|backend-20260729-pr2216'
printf '255' >"$M/info_events_exit"
set_healthy_underlying "$M"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3039: an unreadable event log is not proof of a rollout' 1 \
  'did not come up Ready'

# And the ordinary path is untouched: Ready on our version succeeds as before,
# without claiming a later update.
M=$(new_mock_dir)
set_describe_states "$M" 'Ready|Green|old-version' 'Updating|Green|backend-20260729-pr2216' 'Ready|Green|backend-20260729-pr2216'
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3039: a normal deploy still succeeds through the Ready path' 0 \
  "is Ready, running version 'backend-20260729-pr2216'"

# ---------------------------------------------------------------------------
# ENG-3082 -- a release that is serving must not be reported failed because
# the environment's version label has not moved yet.
#
# Production, 2026-11-16, run 43832897163 (merge of #4118). The run waited
# from 08:41Z to 08:59Z behind a configuration update it did not start, so its
# own update was accepted at 08:59:57Z with about 26 minutes of budget left.
# Elastic Beanstalk logged "Deployment succeeded. Terminating old instances and
# temporary Auto Scaling group." at 09:06:20Z and then spent until 09:23:08Z
# removing the old instance. The environment's VersionLabel only moves when the
# whole update completes (09:28:10Z), so every poll read
# `Status=Updating Health=Green Version=backend-20261116-pr4116` and the run
# failed on its budget at 09:26:30Z, 100 seconds before EB finished and about
# 20 minutes after the release was serving.
#
# The fixtures are that sequence with the harness's labels ('old-version' is
# pr4116, the expected label is pr4118): the status line every poll logged, the
# INFO events for the window newest first, and the per-instance view read from
# production during the same phase of the next deploy (new instance on the new
# version, old instance still listed on the old one and draining).
# ---------------------------------------------------------------------------

printf '\nENG-3082: a serving release whose version label lags is not a failure\n'

EB_IMMUTABLE_SUCCEEDED='Deployment succeeded. Terminating old instances and temporary Auto Scaling group.'

# Newest first, as describe-events returns them.
set_immutable_succeeded_events() {
  local dir="$1"
  {
    printf '%s\n' "${EB_IMMUTABLE_SUCCEEDED}"
    printf '%s\n' 'Waiting for post-deployment configuration to complete.'
    printf '%s\n' 'Instance deployment completed successfully.'
    printf '%s\n' 'Starting post-deployment configuration on new instances.'
    printf '%s\n' 'Attached new instance(s) to the permanent auto scaling group awseb-e-x-stack-AWSEBAutoScalingGroup-SoB9a6hVCRje.'
    printf '%s\n' 'Created temporary auto scaling group awseb-e-x-immutable-stack-AWSEBAutoScalingGroup-uQBsl6uZEzRD.'
    printf '%s\n' 'Immutable deployment policy enabled. Launching one instance with the new settings to verify health.'
    printf '%s\n' 'Environment update is starting.'
  } >"${dir}/info_events"
}

# New instance serving the expected version, old instance still draining.
set_new_instance_serving() {
  local dir="$1"
  {
    printf 'i-0504eb4eaa2e817fc\tOk\tbackend-20260729-pr2216\tDeployed\n'
    printf 'i-088cef37b3ad334e5\tOk\told-version\tDeployed\n'
  } >"${dir}/instances_deployment"
  printf 'arn:aws:elasticloadbalancing:us-west-2:1:loadbalancer/app/awseb-AWSEB-X/abc\n' >"${dir}/lb_arns"
  printf 'arn:aws:elasticloadbalancing:us-west-2:1:targetgroup/awseb-AWSEB-UUBAGFYEVPQ1/def\n' >"${dir}/tg_arns"
  {
    printf 'i-0504eb4eaa2e817fc\thealthy\n'
    printf 'i-088cef37b3ad334e5\tdraining\n'
  } >"${dir}/target_health"
}

new_lagging_label_case() {
  M=$(new_mock_dir)
  set_describe_states "$M" 'Ready|Green|old-version' 'Updating|Green|old-version'
  set_immutable_succeeded_events "$M"
  set_new_instance_serving "$M"
}

# The 11-16 replay.
new_lagging_label_case
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: the 2026-11-16 sequence is a success, not a budget timeout' 0 \
  'SUCCESS: environment'
check 'ENG-3082: the success names the instance and the version it reports' 0 \
  "i-0504eb4eaa2e817fc reports 'backend-20260729-pr2216' as Deployed"
check 'ENG-3082: the success says the old instance is still being removed' 0 \
  'still removing the old instance'

# The run still uses its whole budget first: the proof is only consulted at the
# point where the deploy would otherwise be failed, so a later deploy is never
# released into an environment this one could still have waited for.
TESTS_RUN=$(( TESTS_RUN + 1 ))
if [ "$(cat "$M/clock")" -ge 20 ]; then
  pass 'ENG-3082: the proof is consulted only once the budget is spent'
else
  printf '  FAIL ENG-3082: succeeded before the budget was spent (clock=%s)\n' "$(cat "$M/clock")"
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

# The old instance already gone (the state at 09:26:30Z on 11-16): still a success.
new_lagging_label_case
printf 'i-0504eb4eaa2e817fc\tOk\tbackend-20260729-pr2216\tDeployed\n' >"$M/instances_deployment"
printf 'i-0504eb4eaa2e817fc\thealthy\n' >"$M/target_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: one remaining instance on the expected version is a success' 0 \
  'SUCCESS: environment'

# A deploy that did not apply must still fail. Each case removes one leg.

# No instance reports the expected version.
new_lagging_label_case
printf 'i-088cef37b3ad334e5\tOk\told-version\tDeployed\n' >"$M/instances_deployment"
printf 'i-088cef37b3ad334e5\thealthy\n' >"$M/target_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: instances on a different version still fail on the budget' 1 \
  'did not come up Ready'

# EB never logged the deployment as succeeded for this update.
new_lagging_label_case
{
  printf '%s\n' 'Instance deployment completed successfully.'
  printf '%s\n' 'Immutable deployment policy enabled. Launching one instance with the new settings to verify health.'
  printf '%s\n' 'Environment update is starting.'
} >"$M/info_events"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: no "Deployment succeeded" event for this update still fails' 1 \
  'did not come up Ready'

# The success line belongs to the update BEFORE ours (the 08:32Z line of the
# configuration update on 11-16): our own start comes after it.
new_lagging_label_case
{
  printf '%s\n' 'Immutable deployment policy enabled. Launching one instance with the new settings to verify health.'
  printf '%s\n' 'Environment update is starting.'
  printf '%s\n' 'Environment update completed successfully.'
  printf '%s\n' "${EB_IMMUTABLE_SUCCEEDED}"
  printf '%s\n' 'Environment update is starting.'
} >"$M/info_events"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: a success event from the previous update is not accepted' 1 \
  'did not come up Ready'

# The expected version is on the instance but its deployment has not finished.
new_lagging_label_case
printf 'i-0504eb4eaa2e817fc\tOk\tbackend-20260729-pr2216\tInProgress\n' >"$M/instances_deployment"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: expected version not yet Deployed on the instance still fails' 1 \
  'did not come up Ready'

# The instance on the expected version is not healthy.
new_lagging_label_case
printf 'i-0504eb4eaa2e817fc\tSevere\tbackend-20260729-pr2216\tDeployed\n' >"$M/instances_deployment"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: expected-version instance that is not Ok still fails' 1 \
  'did not come up Ready'

# The instance is not taking traffic from the load balancer.
new_lagging_label_case
printf 'i-0504eb4eaa2e817fc\tunhealthy\n' >"$M/target_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: expected-version instance not healthy in the target group still fails' 1 \
  'did not come up Ready'

# Healthy in one target group but failing in another (an environment with more
# than one process): not serving on every path.
new_lagging_label_case
{
  printf 'i-0504eb4eaa2e817fc\thealthy\n'
  printf 'i-0504eb4eaa2e817fc\tunhealthy\n'
  printf 'i-088cef37b3ad334e5\tdraining\n'
} >"$M/target_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: healthy in one target group and unhealthy in another still fails' 1 \
  'did not come up Ready'

# On the expected version but not registered with the load balancer at all.
new_lagging_label_case
printf 'i-088cef37b3ad334e5\tdraining\n' >"$M/target_health"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: expected-version instance not registered in a target group still fails' 1 \
  'did not come up Ready'

# Every read the proof makes is time-bounded, because it runs after the budget.
new_lagging_label_case
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
TESTS_RUN=$(( TESTS_RUN + 1 ))
if grep -qF -- '--cli-read-timeout 15' "$M/info_events_args" 2>/dev/null; then
  pass 'ENG-3082: the proof reads carry a read timeout'
else
  printf '  FAIL ENG-3082: the event read has no read timeout: %s\n' "$(cat "$M/info_events_args" 2>/dev/null)"
  TESTS_FAILED=$(( TESTS_FAILED + 1 ))
fi

# The per-instance read fails: no proof, so the failure stands.
new_lagging_label_case
printf 'ERROR|AccessDenied: not authorized to perform elasticbeanstalk:DescribeInstancesHealth\n' >"$M/instances_deployment"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: an unreadable instance view is not proof' 1 \
  'did not come up Ready'

# This path is only for a label that has NOT moved. Updating on our own label
# is the ENG-3039 state, which needs EB's rollout-complete line and is judged
# there; the evidence above must not open a second way through it.
new_lagging_label_case
set_describe_states "$M" 'Ready|Green|old-version' 'Updating|Green|backend-20260729-pr2216'
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: Updating on our own label is still judged by the ENG-3039 rule' 1 \
  'did not come up Ready'

# The event log cannot be read: no proof either.
new_lagging_label_case
printf '255' >"$M/info_events_exit"
run_deploy "$M" EB_TOTAL_TIMEOUT_SECONDS='20'
check 'ENG-3082: an unreadable event log is not proof' 1 \
  'did not come up Ready'

# ---------------------------------------------------------------------------

printf '\n%s checks run, %s failed\n' "${TESTS_RUN}" "${TESTS_FAILED}"
[ "${TESTS_FAILED}" -eq 0 ] || exit 1
