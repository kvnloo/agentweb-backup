#!/usr/bin/env bash
#
# Deploy an already-uploaded source bundle to an Elastic Beanstalk environment
# and prove the environment actually took it.
#
# This script exists because the previous inline workflow steps swallowed every
# AWS failure with `|| echo "...continuing..."` and then printed a success
# banner regardless, so a failed production deploy was reported to GitHub as a
# green check (ENG-734). Every failure here is loud, specific and greppable:
# there is no `|| true`, no `continue-on-error`, and no path that reports
# success without having observed the environment running the new version.
#
# Required environment:
#   EB_APPLICATION_NAME          Elastic Beanstalk application name
#   EB_ENVIRONMENT_NAME          Elastic Beanstalk environment name
#   EB_VERSION_LABEL             Version label to create and deploy
#   EB_SOURCE_BUNDLE_S3_BUCKET   S3 bucket holding the uploaded bundle
#   EB_SOURCE_BUNDLE_S3_KEY      S3 key of the uploaded bundle
#
# Optional environment (defaults tuned for the production jobs):
#   EB_TOTAL_TIMEOUT_SECONDS     Absolute wall-clock budget for the whole script (default 2700)
#   EB_SETTLE_TIMEOUT_SECONDS    Max wait per attempt for a pre-existing update (default 600)
#   EB_HEALTH_SETTLE_SECONDS     Grace for health to leave Grey/Red once Ready (default 180)
#   EB_POLL_INTERVAL_SECONDS     Seconds between describe-environments polls (default 15)
#   EB_UPDATE_MAX_ATTEMPTS       Retries for a concurrent-update collision (default 3)
#   EB_ABORT_MAX_RETRIES         Re-applies when EB aborts the rollout on a subset
#                                of instances (default 1). Set to 0 to restore the
#                                pre-ENG-1127 behaviour of failing immediately.
#                                Bounded by EB_TOTAL_TIMEOUT_SECONDS either way.
#   EB_HEALTH_PROBE_DRYRUN       '1' exercises the lagging-rollup health probe on
#                                an already-successful deploy and logs what it
#                                saw. Observation only — it runs after the deploy
#                                is confirmed and cannot change the exit status.
#                                Off by default, so a normal deploy still makes
#                                no extra AWS calls.
#   EB_HEALTH_PROBE_DRYRUN_TIMEOUT_SECONDS
#                                Wall-clock bound for that dry run (default 120).
#                                Exceeding it abandons the probe and reports it
#                                as INERT; it never fails the deploy.
#   EB_HEALTH_PROBE_DRYRUN_MARGIN_SECONDS
#                                Seconds of the overall budget the dry run must
#                                leave untouched (default 30). If less than that
#                                remains, the dry run is skipped outright.
#
# EB_TOTAL_TIMEOUT_SECONDS is an absolute deadline covering settling, retries and
# verification together, so the worst case cannot exceed it no matter how many
# concurrent-update retries happen. The calling step's `timeout-minutes` must sit
# above it, so this script always reports the reason rather than being killed
# mid-poll by the runner.
#
# Exit status: 0 only when the environment is Ready, reports EB_VERSION_LABEL as
# its running version, and is healthy. Anything else exits non-zero.
#
# "Healthy" means the environment health rollup is neither Grey nor Red — OR
# (ENG-878) the rollup is still Grey/Red after EB_HEALTH_SETTLE_SECONDS but
# every instance reports Ok and every load-balancer target reports healthy, in
# which case the rollup is a lagging aggregate and is not the deploy's verdict.
# If that probe cannot be completed the original failure stands: an unreadable
# probe is never read as proof of health.
#
# Extra IAM needed for that probe, beyond what the deploy already used:
#   elasticbeanstalk:DescribeInstancesHealth
#   elasticbeanstalk:DescribeEnvironmentResources
#   elbv2:DescribeTargetGroups
#   elbv2:DescribeTargetHealth
# Missing any of them degrades to today's behaviour (fail on a Red rollup) and
# names the denied call in the failure message. Because that degradation is
# silent until an incident, EB_HEALTH_PROBE_DRYRUN exists to exercise the probe
# on a healthy deploy and prove those permissions before they are needed.

set -euo pipefail

EB_TOTAL_TIMEOUT_SECONDS="${EB_TOTAL_TIMEOUT_SECONDS:-2700}"
EB_SETTLE_TIMEOUT_SECONDS="${EB_SETTLE_TIMEOUT_SECONDS:-600}"
EB_HEALTH_SETTLE_SECONDS="${EB_HEALTH_SETTLE_SECONDS:-180}"
EB_POLL_INTERVAL_SECONDS="${EB_POLL_INTERVAL_SECONDS:-15}"
EB_UPDATE_MAX_ATTEMPTS="${EB_UPDATE_MAX_ATTEMPTS:-3}"
EB_REJECTION_GRACE_SECONDS="${EB_REJECTION_GRACE_SECONDS:-180}"
EB_ABORT_MAX_RETRIES="${EB_ABORT_MAX_RETRIES:-1}"
EB_HEALTH_PROBE_DRYRUN="${EB_HEALTH_PROBE_DRYRUN:-0}"
EB_HEALTH_PROBE_DRYRUN_TIMEOUT_SECONDS="${EB_HEALTH_PROBE_DRYRUN_TIMEOUT_SECONDS:-120}"
EB_HEALTH_PROBE_DRYRUN_MARGIN_SECONDS="${EB_HEALTH_PROBE_DRYRUN_MARGIN_SECONDS:-30}"

# Absolute epoch deadline for the whole run; set in main().
EB_RUN_DEADLINE=0

# Epoch at which update-environment was accepted; anchors the event scan so a
# stale ERROR from a previous deploy cannot fail this one.
EB_UPDATE_ACCEPTED_AT=0

# Populated by read_environment_state.
EB_STATUS=''
EB_HEALTH=''
EB_CURRENT_VERSION=''

# ERROR-severity EB events that mean this update can never succeed (ENG-837).
#
# EB accepts `update-environment` and only THEN validates. On 2026-08-01 PR
# #2237 was accepted, rejected asynchronously with the first pattern below, and
# the environment stayed Ready on its previous version — so verify_deployment
# polled a perfectly healthy environment for the full 2700s budget and then
# reported a generic timeout. The cause was in the EB event log the whole time,
# and the failure was misattributed twice (to the ENG-777 autoscaling race)
# because nothing surfaced it.
#
# Deliberately narrow. Only conditions that cannot self-resolve belong here: a
# gate that fails a recoverable deploy gets switched off within a week. Every
# other ERROR event is logged for attribution but does not fail the job.
EB_TERMINAL_EVENT_PATTERNS=(
  'Cannot update resource configuration and instance configuration simultaneously'
  'Configuration validation exception'
  'Failed to deploy configuration'
  'You cannot configure a load balancer'
)

# ERROR-severity EB events that mean the rollout failed on a SUBSET of instances
# and can succeed on a re-apply (ENG-1127).
#
# EB requires every instance to succeed. One instance failing its app-deploy
# aborts the whole rollout, reverts the environment's version pointer, and
# leaves the instances that did succeed on the new version. The environment then
# sits Ready on the old version — indistinguishable, from status alone, from the
# ENG-837 rejection this script correctly treats as terminal.
#
# It is not the same thing. Nothing is wrong with the bundle or the config, so
# re-applying it converges. On 2026-08-11 the abort came from a concurrent
# self-startup on an ASG replacement instance that had joined 31 seconds before
# the deploy; the next deploy to land went Green untouched.
#
# Kept as narrow as the terminal list, and for the same reason: these two
# strings are EB's own wording for "some instances, not your config".
EB_ABORT_EVENT_PATTERNS=(
  'Unsuccessful command execution on instance id(s)'
  'During an aborted deployment'
)

# Raw text of the ERROR events read by the most recent scan, so the stale-Ready
# branch can tell a recoverable abort from a terminal rejection without paying
# for a second describe-events call.
EB_LAST_ERROR_EVENTS=''
EB_ABORT_RETRIES_USED=0

# verify_deployment's return code for "the rollout aborted on a subset of
# instances; re-apply". Distinct from 0/1 so main() cannot confuse it with a
# genuine failure.
readonly EB_VERIFY_RETRYABLE_ABORT=75

log() {
  echo "[eb-deploy] $*"
}

# Every failure exits non-zero with a stable, greppable prefix. GitHub renders
# the `::error::` annotation at the top of the job so the cause is visible
# without opening the log.
fail() {
  echo "::error::EB_DEPLOY_FAILED: $*" >&2
  echo "[eb-deploy] EB_DEPLOY_FAILED: $*" >&2
  exit 1
}

require_env() {
  local name="$1"
  # Indirect expansion keeps this readable under `set -u`.
  if [ -z "${!name:-}" ]; then
    fail "required environment variable ${name} is empty or unset."
  fi
}

now_seconds() {
  date +%s
}

# Clamps a phase deadline to the overall run deadline, so no phase can push the
# total past EB_TOTAL_TIMEOUT_SECONDS.
capped_deadline() {
  local own="$1"
  if [ "${own}" -gt "${EB_RUN_DEADLINE}" ]; then
    printf '%s' "${EB_RUN_DEADLINE}"
  else
    printf '%s' "${own}"
  fi
}

# True once the overall budget is spent, so timeout messages can name the right
# budget instead of blaming the phase that happened to be running.
run_budget_exhausted() {
  [ "$(now_seconds)" -ge "${EB_RUN_DEADLINE}" ]
}

# Reads Status, Health and VersionLabel in a single describe-environments call
# so all three always describe the same snapshot. Sets EB_STATUS, EB_HEALTH and
# EB_CURRENT_VERSION.
read_environment_state() {
  local out
  if ! out=$(aws elasticbeanstalk describe-environments \
    --environment-names "${EB_ENVIRONMENT_NAME}" \
    --query 'Environments[0].[Status,Health,VersionLabel]' \
    --output text 2>&1); then
    fail "describe-environments failed for environment '${EB_ENVIRONMENT_NAME}'. AWS reported: ${out}"
  fi

  # A here-string always supplies a trailing newline, so `read` returns 0 even
  # for empty input; the emptiness check below is the real gate, not this read.
  IFS=$'\t' read -r EB_STATUS EB_HEALTH EB_CURRENT_VERSION <<<"${out}"

  # An unknown/terminated environment makes the JMESPath expression collapse to
  # the single token "None"; treat anything without all three fields as fatal
  # rather than silently comparing against empty strings.
  if [ -z "${EB_STATUS}" ] || [ -z "${EB_HEALTH}" ] || [ -z "${EB_CURRENT_VERSION}" ]; then
    fail "environment '${EB_ENVIRONMENT_NAME}' was not found, or describe-environments returned an unusable response: '${out}'"
  fi
}

# Both set by underlying_health_verdict. It assigns globals rather than echoing
# its verdict because a command substitution runs in a SUBSHELL, so the detail
# string would be discarded and every failure would read "no detail available"
# — which is precisely the uninformative message ENG-878 AC3 exists to kill.
EB_UNHEALTHY_DETAIL=''
EB_HEALTH_VERDICT=''

# Is the environment's Red/Grey rollup real, or is it lagging? (ENG-878)
#
# EB's environment Health is an AGGREGATE and it lags. After an immutable
# deploy terminates the old instance the rollup can sit at Red for minutes
# while every underlying signal is already healthy. On 2026-08-03 that failed
# a deploy of #2252 whose instance was `Ok`, whose target group was `healthy`,
# which served 100% 2xx throughout, and which went Green on its own minutes
# later with no intervention. Because ENG-837's trunk gate keys off the deploy
# run's conclusion, that one false failure blocked every merge onto main.
#
# So before calling a Red rollup a failure, ask the two signals that do NOT
# lag: per-instance health, and target-group health.
#
# Sets EB_HEALTH_VERDICT to one of:
#   LAGGING   every instance Ok and every target healthy — the rollup is stale
#   UNHEALTHY something is genuinely wrong; EB_UNHEALTHY_DETAIL names it
#   UNKNOWN   the probe could not be completed
#
# UNKNOWN deliberately keeps the old failure. A probe that cannot see the
# instances must never be read as proof they are fine — that would convert this
# from "stop crying wolf" into "never bark", which is the far worse bug.
underlying_health_verdict() {
  local out instances unhealthy='' lb_arns tg_arns arn targets

  EB_UNHEALTHY_DETAIL=''

  if ! out=$(aws elasticbeanstalk describe-instances-health \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --attribute-names HealthStatus \
    --query 'InstanceHealthList[*].[InstanceId,HealthStatus]' \
    --output text 2>&1); then
    EB_UNHEALTHY_DETAIL="describe-instances-health failed: ${out}"
    EB_HEALTH_VERDICT='UNKNOWN'
    return 0
  fi

  instances=$(printf '%s' "${out}" | grep -v '^None$' | grep -v '^[[:space:]]*$' || true)
  if [ -z "${instances}" ]; then
    # No instances at all is not a lagging rollup, it is an empty environment.
    EB_UNHEALTHY_DETAIL='describe-instances-health returned no instances'
    EB_HEALTH_VERDICT='UNKNOWN'
    return 0
  fi

  # Only `Ok` counts. Warning/Degraded/Severe/Info/Pending/Unknown/NoData all
  # mean "not proven healthy", and this function's whole job is proving it.
  while IFS=$'\t' read -r iid ihealth; do
    [ -z "${iid}" ] && continue
    if [ "${ihealth}" != "Ok" ]; then
      unhealthy="${unhealthy}instance ${iid}=${ihealth} "
    fi
  done <<<"${instances}"

  if ! lb_arns=$(aws elasticbeanstalk describe-environment-resources \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --query 'EnvironmentResources.LoadBalancers[*].Name' \
    --output text 2>&1); then
    EB_UNHEALTHY_DETAIL="describe-environment-resources failed: ${lb_arns}"
    EB_HEALTH_VERDICT='UNKNOWN'
    return 0
  fi

  lb_arns=$(printf '%s' "${lb_arns}" | tr '\t' '\n' | grep '^arn:' || true)
  if [ -z "${lb_arns}" ]; then
    # A classic (non-ALB) load balancer reports a bare name, so there is no
    # target group to interrogate and this probe cannot speak for the ALB path.
    EB_UNHEALTHY_DETAIL='no Application Load Balancer ARN on this environment'
    EB_HEALTH_VERDICT='UNKNOWN'
    return 0
  fi

  while IFS= read -r lb; do
    [ -z "${lb}" ] && continue
    if ! tg_arns=$(aws elbv2 describe-target-groups \
      --load-balancer-arn "${lb}" \
      --query 'TargetGroups[*].TargetGroupArn' \
      --output text 2>&1); then
      EB_UNHEALTHY_DETAIL="describe-target-groups failed for ${lb}: ${tg_arns}"
      EB_HEALTH_VERDICT='UNKNOWN'
      return 0
    fi

    # A load balancer with zero target groups would give this loop zero
    # iterations, leaving `unhealthy` empty and returning LAGGING — i.e.
    # vouching for a deploy without having checked a single target. Same hole
    # as the no-instances and no-registered-targets cases below and above.
    tg_arns=$(printf '%s' "${tg_arns}" | tr '\t' '\n' | grep '^arn:' || true)
    if [ -z "${tg_arns}" ]; then
      EB_UNHEALTHY_DETAIL="describe-target-groups returned no target groups for ${lb}"
      EB_HEALTH_VERDICT='UNKNOWN'
      return 0
    fi

    for arn in ${tg_arns}; do
      if ! targets=$(aws elbv2 describe-target-health \
        --target-group-arn "${arn}" \
        --query 'TargetHealthDescriptions[*].[Target.Id,TargetHealth.State]' \
        --output text 2>&1); then
        EB_UNHEALTHY_DETAIL="describe-target-health failed for ${arn}: ${targets}"
        EB_HEALTH_VERDICT='UNKNOWN'
        return 0
      fi

      targets=$(printf '%s' "${targets}" | grep -v '^None$' | grep -v '^[[:space:]]*$' || true)
      if [ -z "${targets}" ]; then
        EB_UNHEALTHY_DETAIL="target group ${arn##*/} has no registered targets"
        EB_HEALTH_VERDICT='UNKNOWN'
        return 0
      fi

      while IFS=$'\t' read -r tid tstate; do
        [ -z "${tid}" ] && continue
        if [ "${tstate}" != "healthy" ]; then
          unhealthy="${unhealthy}target ${tid}=${tstate} "
        fi
      done <<<"${targets}"
    done
  done <<<"${lb_arns}"

  if [ -n "${unhealthy}" ]; then
    EB_UNHEALTHY_DETAIL="${unhealthy% }"
    EB_HEALTH_VERDICT='UNHEALTHY'
    return 0
  fi

  EB_HEALTH_VERDICT='LAGGING'
}

# Run the lag probe on a deploy that already passed, purely to observe it.
#
# underlying_health_verdict is only reachable when the rollup is still Grey/Red
# past the settle window, and that has not happened on a real deploy since this
# fix merged. So its four extra IAM actions and its output parsing have never
# executed in production, and an inert probe is indistinguishable from a working
# one until the incident it exists for — at which point a denied API call
# silently degrades back to the false failure this whole change removed.
#
# Setting EB_HEALTH_PROBE_DRYRUN=1 makes the probe deliberately reachable on an
# ordinary healthy deploy. It runs the real calls, prints what it saw, and is
# explicitly NOT part of the verdict: the deploy has already been confirmed by
# the time this runs, and nothing here can change the exit status. A dry run
# that could fail a deploy would be a new, untested gate rather than a
# diagnostic — the opposite of the point.
#
# Off by default, so an ordinary deploy still makes zero extra AWS calls.
#
# The probe is four sequential AWS calls with no bound of their own. Running it
# *after* success means a stalled or throttled call would hold the script open
# past the step's timeout-minutes and report a failure for a deploy that had
# already been confirmed — the exact false failure this change exists to remove,
# reintroduced by the diagnostic. So the dry run gets its own wall-clock budget,
# clamped to what is left of the overall run budget, and abandoning it is just
# another INERT observation.
run_health_probe_dryrun() {
  [ "${EB_HEALTH_PROBE_DRYRUN}" = "1" ] || return 0

  local budget="${EB_HEALTH_PROBE_DRYRUN_TIMEOUT_SECONDS}"
  local remaining
  # Leave a margin so the script still exits cleanly on its own terms rather
  # than being killed mid-diagnostic by the workflow.
  remaining=$(( EB_RUN_DEADLINE - $(now_seconds) - EB_HEALTH_PROBE_DRYRUN_MARGIN_SECONDS ))
  [ "${remaining}" -lt "${budget}" ] && budget="${remaining}"

  if [ "${budget}" -le 0 ]; then
    log "probe dry run: SKIPPED — too little of the ${EB_TOTAL_TIMEOUT_SECONDS}s deploy budget is left to run the probe without risking the step timeout. This did not affect this deploy."
    return 0
  fi

  log "Probe dry run requested; exercising the lagging-rollup health probe against ${EB_ENVIRONMENT_NAME} (bounded to ${budget}s)."

  # The verdict is collected through a file rather than by waiting on the child:
  # a finished-but-unreaped child still answers `kill -0`, so polling liveness
  # would burn the whole budget on a probe that already returned.
  local result="${TMPDIR:-/tmp}/eb-probe-dryrun.$$"
  rm -f "${result}" "${result}.partial"
  # Job control puts the child in its own process group, so abandoning the probe
  # can signal the whole tree. Killing only the wrapper subshell would leave the
  # stalled `aws` descendant alive holding this script's stdout/stderr, and the
  # runner can wait on those descriptors — which is the same already-confirmed-
  # deploy-reported-as-failed defect, one level down.
  set -m
  (
    underlying_health_verdict
    printf '%s\n%s\n' "${EB_HEALTH_VERDICT}" "${EB_UNHEALTHY_DETAIL:-}" >"${result}.partial"
    mv "${result}.partial" "${result}"
  ) &
  local pid=$!
  set +m

  local waited=0
  while [ ! -f "${result}" ] && [ "${waited}" -lt "${budget}" ]; do
    sleep 1
    waited=$(( waited + 1 ))
  done

  if [ ! -f "${result}" ]; then
    # Signal the group first (negative PID), so the stalled AWS call dies with
    # its wrapper; fall back to the bare PID if the group is already gone.
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
    rm -f "${result}.partial"
    log "probe dry run: verdict=UNKNOWN detail=the probe did not finish within ${budget}s and was abandoned"
    log "probe dry run: INERT — the probe could not complete, so on a real Grey/Red rollup it would fall back to failing the deploy. Fix this before relying on it. This did not affect this deploy."
    return 0
  fi

  wait "${pid}" 2>/dev/null || true
  EB_HEALTH_VERDICT=$(sed -n 1p "${result}")
  EB_UNHEALTHY_DETAIL=$(sed -n 2p "${result}")
  rm -f "${result}"

  log "probe dry run: verdict=${EB_HEALTH_VERDICT} detail=${EB_UNHEALTHY_DETAIL:-none}"

  case "${EB_HEALTH_VERDICT}" in
    LAGGING)
      log "probe dry run: the probe can read every instance and target, so it would speak for a lagging rollup. Its IAM permissions are proven. This observation did not affect this deploy."
      ;;
    UNHEALTHY)
      log "probe dry run: the probe reached every signal and found something unhealthy. Its IAM permissions are proven; the finding did not affect this deploy, whose own health check already passed."
      ;;
    *)
      log "probe dry run: INERT — the probe could not complete, so on a real Grey/Red rollup it would fall back to failing the deploy. Fix this before relying on it. This did not affect this deploy."
      ;;
  esac
}

# Fails immediately on a status the environment cannot recover from, so a dead
# environment surfaces now instead of burning the whole timeout.
fail_on_terminal_status() {
  local phase="$1"
  case "${EB_STATUS}" in
    Terminated | Terminating)
      fail "environment '${EB_ENVIRONMENT_NAME}' is ${EB_STATUS} during ${phase}. Version '${EB_VERSION_LABEL}' was NOT applied."
      ;;
    *) ;;
  esac
}

# Reads ERROR-severity events raised since update-environment was accepted and
# fails immediately on one that can never resolve (ENG-837 AC3).
#
# The scan is anchored to EB_UPDATE_ACCEPTED_AT so an ERROR from an earlier
# deploy cannot fail this one. Non-terminal errors are logged rather than acted
# on: they are usually the real story behind an eventual timeout, and having
# them in the job output is what stops the next failure being misattributed.
#
# A describe-events failure is NOT fatal. This is a diagnostic overlay on top of
# the existing status polling, and an IAM gap or throttle here must not take
# down a deploy that would otherwise verify correctly.
scan_for_terminal_events() {
  [ "${EB_UPDATE_ACCEPTED_AT}" -eq 0 ] && return 0

  local since out pattern
  EB_LAST_ERROR_EVENTS=''
  # EB wants an ISO-8601 timestamp; both BSD and GNU date are in play (macOS
  # locally, Linux on the runner), so try the BSD form first and fall back.
  since="$(date -u -r "${EB_UPDATE_ACCEPTED_AT}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u -d "@${EB_UPDATE_ACCEPTED_AT}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  [ -z "${since}" ] && return 0

  if ! out=$(aws elasticbeanstalk describe-events \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --severity ERROR \
    --start-time "${since}" \
    --max-items 25 \
    --query 'Events[].Message' \
    --output text 2>&1); then
    log "[events] could not read EB events (non-fatal, status polling continues). AWS reported: ${out}"
    return 0
  fi

  [ -z "${out}" ] && return 0
  [ "${out}" = "None" ] && return 0

  log "[events] EB reported ERROR-severity events since the update was accepted:"
  log "[events] ${out}"

  EB_LAST_ERROR_EVENTS="${out}"

  # ENG-1412: HERE-STRING, not `printf ... | grep -q`. `grep -q` exits on the
  # first match and closes the pipe; under `set -o pipefail` the writer's
  # EPIPE becomes the pipeline's status, so a MATCH is read as NO MATCH.
  #
  # Here that inverts the safety property this function exists for: a terminal
  # EB rejection would go undetected, the deploy would carry on, and the job
  # would report success on an update Elastic Beanstalk had refused — the
  # ENG-734/ENG-837 false green, reintroduced by a pipe race. Confirmed to fire
  # in CI on agentweb#2523 (in eb-config-conflict.sh, same shape).
  for pattern in "${EB_TERMINAL_EVENT_PATTERNS[@]}"; do
    if grep -qF "${pattern}" <<<"${out}"; then
      fail "Elastic Beanstalk REJECTED this update and it cannot succeed. EB reported: '${pattern}'. Version '${EB_VERSION_LABEL}' was NOT applied and '${EB_ENVIRONMENT_NAME}' is still running '${EB_CURRENT_VERSION}'. Full event text: ${out}"
    fi
  done

  return 0
}

# True when the most recent event scan carries EB's wording for a rollout that
# failed on a subset of instances rather than being rejected outright.
#
# Reads only what scan_for_terminal_events already fetched, so this costs no
# extra AWS call and cannot itself fail the deploy.
events_show_recoverable_abort() {
  local pattern
  if [ -z "${EB_LAST_ERROR_EVENTS}" ]; then
    return 1
  fi
  for pattern in "${EB_ABORT_EVENT_PATTERNS[@]}"; do
    if grep -qF "${pattern}" <<<"${EB_LAST_ERROR_EVENTS}"; then
      return 0
    fi
  done
  return 1
}

# Creates the application version. A genuine failure fails the job; the single
# tolerated case is the version already existing (a re-run of the same commit),
# which is logged with the reason AWS gave.
create_application_version() {
  local out
  log "Creating application version '${EB_VERSION_LABEL}' from s3://${EB_SOURCE_BUNDLE_S3_BUCKET}/${EB_SOURCE_BUNDLE_S3_KEY}"

  if out=$(aws elasticbeanstalk create-application-version \
    --application-name "${EB_APPLICATION_NAME}" \
    --version-label "${EB_VERSION_LABEL}" \
    --source-bundle "S3Bucket=${EB_SOURCE_BUNDLE_S3_BUCKET},S3Key=${EB_SOURCE_BUNDLE_S3_KEY}" 2>&1); then
    log "Created application version '${EB_VERSION_LABEL}'."
    return 0
  fi

  if grep -qiF 'already exists' <<<"${out}"; then
    log "Application version '${EB_VERSION_LABEL}' already exists; reusing the existing version. AWS reported: ${out}"
    return 0
  fi

  fail "create-application-version failed for '${EB_VERSION_LABEL}' and the error is not an already-exists collision. AWS reported: ${out}"
}

# Ensure the ASG can hold an old instance long enough for the application to
# drain scheduled work before termination (ENG-764).
#
# This belongs in the deploy path, not .ebextensions: an .ebextensions resource
# delta cannot ride an immutable application deploy, while a one-time manually
# created hook disappears if Elastic Beanstalk ever replaces the ASG. The API is
# idempotent, so every deploy repairs the hook before update-environment is
# allowed to retire an instance.
ensure_termination_lifecycle_hook() {
  local asg out

  if ! asg=$(aws elasticbeanstalk describe-environment-resources \
    --environment-name "${EB_ENVIRONMENT_NAME}" \
    --query 'EnvironmentResources.AutoScalingGroups[0].Name' \
    --output text 2>&1); then
    fail "could not resolve the Auto Scaling group for '${EB_ENVIRONMENT_NAME}' before installing the termination lifecycle hook. AWS reported: ${asg}"
  fi

  if [ -z "${asg}" ] || [ "${asg}" = "None" ]; then
    fail "environment '${EB_ENVIRONMENT_NAME}' returned no Auto Scaling group; refusing to deploy without the ENG-764 termination lifecycle hook."
  fi

  case "${asg}" in
    awseb-*) ;;
    *) fail "environment '${EB_ENVIRONMENT_NAME}' resolved unexpected Auto Scaling group '${asg}'; refusing to attach the lifecycle hook outside an Elastic Beanstalk-owned ASG." ;;
  esac

  log "Ensuring termination lifecycle hook 'agentweb-drain-before-terminate' on '${asg}'."
  if ! out=$(aws autoscaling put-lifecycle-hook \
    --auto-scaling-group-name "${asg}" \
    --lifecycle-hook-name agentweb-drain-before-terminate \
    --lifecycle-transition autoscaling:EC2_INSTANCE_TERMINATING \
    --heartbeat-timeout 900 \
    --default-result CONTINUE 2>&1); then
    fail "could not install termination lifecycle hook on '${asg}'; refusing to start a deploy that could cut off scheduled work. AWS reported: ${out}"
  fi
}

# Waits for the environment to reach Ready so this version can actually be
# applied. Used before update-environment (AC4: a concurrent update is waited
# out, never shrugged off).
wait_for_environment_ready() {
  local phase="$1"
  local deadline
  deadline=$(capped_deadline "$(( $(now_seconds) + EB_SETTLE_TIMEOUT_SECONDS ))")

  while :; do
    read_environment_state
    log "[${phase}] Status=${EB_STATUS} Health=${EB_HEALTH} Version=${EB_CURRENT_VERSION}"
    fail_on_terminal_status "${phase}"

    if [ "${EB_STATUS}" = "Ready" ]; then
      return 0
    fi

    if run_budget_exhausted; then
      fail "the overall deploy budget of ${EB_TOTAL_TIMEOUT_SECONDS}s was exhausted while the environment '${EB_ENVIRONMENT_NAME}' was still ${EB_STATUS} (${phase}). Version '${EB_VERSION_LABEL}' was NOT applied."
    fi

    if [ "$(now_seconds)" -ge "${deadline}" ]; then
      fail "environment '${EB_ENVIRONMENT_NAME}' was still ${EB_STATUS} after waiting ${EB_SETTLE_TIMEOUT_SECONDS}s for an in-progress update to finish (${phase}). Version '${EB_VERSION_LABEL}' was NOT applied."
    fi

    sleep "${EB_POLL_INTERVAL_SECONDS}"
  done
}

# Applies the version. A concurrent-update collision is retried after waiting
# for the environment to settle; any other AWS error fails the job immediately.
update_environment() {
  local attempt=1
  local out

  while [ "${attempt}" -le "${EB_UPDATE_MAX_ATTEMPTS}" ]; do
    wait_for_environment_ready "pre-update settle ${attempt}/${EB_UPDATE_MAX_ATTEMPTS}"
    ensure_termination_lifecycle_hook

    log "Applying version '${EB_VERSION_LABEL}' to '${EB_ENVIRONMENT_NAME}' (attempt ${attempt}/${EB_UPDATE_MAX_ATTEMPTS})"
    if out=$(aws elasticbeanstalk update-environment \
      --environment-name "${EB_ENVIRONMENT_NAME}" \
      --version-label "${EB_VERSION_LABEL}" 2>&1); then
      log "update-environment accepted version '${EB_VERSION_LABEL}'."
      # Anchors the ERROR-event scan. "Accepted" is not "validated" — EB
      # validates asynchronously and can still reject this (ENG-837).
      EB_UPDATE_ACCEPTED_AT=$(now_seconds)
      return 0
    fi

    # EB rejects an update while another is running with "Environment named X is
    # in an invalid state for this operation. Must be Ready." That is the one
    # error worth retrying, because the environment settling makes it go away.
    if grep -qiE 'invalid state|concurrentupdate|concurrent update' <<<"${out}"; then
      log "Environment '${EB_ENVIRONMENT_NAME}' was mid-update on attempt ${attempt}/${EB_UPDATE_MAX_ATTEMPTS}; waiting for it to settle and retrying. AWS reported: ${out}"
      attempt=$(( attempt + 1 ))
      continue
    fi

    fail "update-environment failed for environment '${EB_ENVIRONMENT_NAME}' version '${EB_VERSION_LABEL}'. AWS reported: ${out}"
  done

  fail "update-environment could not be applied to '${EB_ENVIRONMENT_NAME}' after ${EB_UPDATE_MAX_ATTEMPTS} attempts because the environment kept reporting a concurrent update in progress. Version '${EB_VERSION_LABEL}' was NOT applied."
}

# The gate that makes a green check mean something: poll until the environment
# is Ready AND reports this exact version, then assert health is not Red.
verify_deployment() {
  local ready_since stale_ready_since
  ready_since=0
  # When the environment first went Ready on a version that is NOT ours.
  stale_ready_since=0

  while :; do
    read_environment_state
    log "[verify] Status=${EB_STATUS} Health=${EB_HEALTH} Version=${EB_CURRENT_VERSION} (expecting Version=${EB_VERSION_LABEL})"
    fail_on_terminal_status "deployment verification"
    scan_for_terminal_events

    # Ready on the PREVIOUS version is a terminal rejection wearing a healthy
    # face, not a slow success (ENG-837 AC3). EB has finished — it just finished
    # by declining the update and keeping what it had. Without this the script
    # polls a permanently healthy environment until the budget dies.
    #
    # The grace window matters: for a few seconds after update-environment is
    # accepted the environment legitimately still reports Ready on the old
    # version, before it transitions to Updating.
    if [ "${EB_STATUS}" = "Ready" ] && [ "${EB_CURRENT_VERSION}" != "${EB_VERSION_LABEL}" ] \
      && [ "${EB_UPDATE_ACCEPTED_AT}" -ne 0 ]; then
      if [ "${stale_ready_since}" -eq 0 ]; then
        stale_ready_since=$(now_seconds)
        log "Environment is Ready but still running '${EB_CURRENT_VERSION}'; allowing ${EB_REJECTION_GRACE_SECONDS}s for the update to begin."
      elif [ "$(( $(now_seconds) - stale_ready_since ))" -ge "${EB_REJECTION_GRACE_SECONDS}" ]; then
        # A subset-of-instances abort lands in exactly this state but is not a
        # rejection: the bundle is fine and a re-apply converges (ENG-1127).
        # scan_for_terminal_events has already run and would have failed the job
        # outright on a terminal pattern, so a terminal rejection can never be
        # retried here even when EB reports both in the same event batch.
        if events_show_recoverable_abort; then
          if [ "${EB_ABORT_RETRIES_USED}" -lt "${EB_ABORT_MAX_RETRIES}" ]; then
            EB_ABORT_RETRIES_USED=$(( EB_ABORT_RETRIES_USED + 1 ))
            log "[abort-retry] EB aborted the rollout on a subset of instances, so '${EB_VERSION_LABEL}' was not applied and '${EB_ENVIRONMENT_NAME}' is back on '${EB_CURRENT_VERSION}'. The bundle and config are fine, so re-applying (${EB_ABORT_RETRIES_USED}/${EB_ABORT_MAX_RETRIES}) within the remaining budget. EB reported: ${EB_LAST_ERROR_EVENTS}"
            return "${EB_VERIFY_RETRYABLE_ABORT}"
          fi
          fail "environment '${EB_ENVIRONMENT_NAME}' aborted the rollout of version '${EB_VERSION_LABEL}' on a subset of instances and was still Ready on '${EB_CURRENT_VERSION}' after ${EB_ABORT_RETRIES_USED} re-apply attempt(s). Version '${EB_VERSION_LABEL}' was NOT applied. EB reported: ${EB_LAST_ERROR_EVENTS}"
        fi
        fail "environment '${EB_ENVIRONMENT_NAME}' has been Ready on version '${EB_CURRENT_VERSION}' for ${EB_REJECTION_GRACE_SECONDS}s after update-environment accepted '${EB_VERSION_LABEL}'. Elastic Beanstalk took the request and then declined to apply it, so this will never converge. Check the environment's ERROR events for the rejection reason."
      fi
    else
      stale_ready_since=0
    fi

    if [ "${EB_STATUS}" = "Ready" ] && [ "${EB_CURRENT_VERSION}" = "${EB_VERSION_LABEL}" ]; then
      if [ "${ready_since}" -eq 0 ]; then
        ready_since=$(now_seconds)
        log "Environment reached Ready on version '${EB_VERSION_LABEL}'; confirming health."
      fi

      # Grey means EB cannot determine health yet and Red can flap briefly while
      # instances finish their checks, so allow a bounded settle window before
      # calling either one a failure. Green/Yellow are accepted immediately.
      if [ "${EB_HEALTH}" != "Grey" ] && [ "${EB_HEALTH}" != "Red" ]; then
        log "SUCCESS: environment '${EB_ENVIRONMENT_NAME}' is Ready, running version '${EB_VERSION_LABEL}', health=${EB_HEALTH}."
        run_health_probe_dryrun
        return 0
      fi

      if [ "$(( $(now_seconds) - ready_since ))" -ge "${EB_HEALTH_SETTLE_SECONDS}" ]; then
        # The rollup is still Red/Grey. Before failing, ask the signals that do
        # not lag — a stale aggregate must not fail a healthy deploy (ENG-878).
        underlying_health_verdict
        case "${EB_HEALTH_VERDICT}" in
          LAGGING)
            log "SUCCESS: environment '${EB_ENVIRONMENT_NAME}' is Ready on version '${EB_VERSION_LABEL}' and every instance is Ok and every load-balancer target is healthy, but its environment health rollup still reads ${EB_HEALTH} after ${EB_HEALTH_SETTLE_SECONDS}s. EB's environment health is a lagging aggregate and this one is stale; the deploy succeeded."
            return 0
            ;;
          UNHEALTHY)
            fail "environment '${EB_ENVIRONMENT_NAME}' took version '${EB_VERSION_LABEL}' but its health stayed ${EB_HEALTH} for ${EB_HEALTH_SETTLE_SECONDS}s after becoming Ready, and the underlying signals agree something is wrong: ${EB_UNHEALTHY_DETAIL}."
            ;;
          *)
            fail "environment '${EB_ENVIRONMENT_NAME}' took version '${EB_VERSION_LABEL}' but its health stayed ${EB_HEALTH} for ${EB_HEALTH_SETTLE_SECONDS}s after becoming Ready, and the underlying instance/target health could not be established, so the deploy is NOT confirmed: ${EB_UNHEALTHY_DETAIL:-no detail available}."
            ;;
        esac
      fi
    else
      # The environment left Ready (or is reporting another version) again, so
      # the health grace restarts when it next settles. Without this reset a
      # later Ready state would be judged against the first one's timestamp and
      # fail immediately instead of getting its own settle window.
      if [ "${ready_since}" -ne 0 ]; then
        log "Environment left the Ready/${EB_VERSION_LABEL} state; restarting the health settle window."
        ready_since=0
      fi
    fi

    if run_budget_exhausted; then
      fail "environment '${EB_ENVIRONMENT_NAME}' did not come up Ready on version '${EB_VERSION_LABEL}' within the overall deploy budget of ${EB_TOTAL_TIMEOUT_SECONDS}s. Last observed Status=${EB_STATUS} Health=${EB_HEALTH} Version=${EB_CURRENT_VERSION}."
    fi

    sleep "${EB_POLL_INTERVAL_SECONDS}"
  done
}

main() {
  require_env EB_APPLICATION_NAME
  require_env EB_ENVIRONMENT_NAME
  require_env EB_VERSION_LABEL
  require_env EB_SOURCE_BUNDLE_S3_BUCKET
  require_env EB_SOURCE_BUNDLE_S3_KEY

  EB_RUN_DEADLINE=$(( $(now_seconds) + EB_TOTAL_TIMEOUT_SECONDS ))

  log "Deploying '${EB_VERSION_LABEL}' to application '${EB_APPLICATION_NAME}' environment '${EB_ENVIRONMENT_NAME}'."
  log "Overall budget: ${EB_TOTAL_TIMEOUT_SECONDS}s (settle cap ${EB_SETTLE_TIMEOUT_SECONDS}s per attempt, up to ${EB_UPDATE_MAX_ATTEMPTS} attempts)."
  create_application_version

  # One apply/verify cycle, plus a bounded re-apply when EB aborts the rollout
  # on a subset of instances (ENG-1127). Every other outcome still exits from
  # inside verify_deployment via fail(), and EB_RUN_DEADLINE bounds the loop
  # regardless of how many cycles it takes.
  local verify_rc
  while :; do
    update_environment
    verify_rc=0
    verify_deployment || verify_rc=$?
    if [ "${verify_rc}" -eq 0 ]; then
      break
    fi
    if [ "${verify_rc}" -ne "${EB_VERIFY_RETRYABLE_ABORT}" ]; then
      exit "${verify_rc}"
    fi
  done

  log "Deployment of '${EB_VERSION_LABEL}' to '${EB_ENVIRONMENT_NAME}' is complete and verified."
}

main "$@"
