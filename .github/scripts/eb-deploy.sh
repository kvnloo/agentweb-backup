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
#
# EB_TOTAL_TIMEOUT_SECONDS is an absolute deadline covering settling, retries and
# verification together, so the worst case cannot exceed it no matter how many
# concurrent-update retries happen. The calling step's `timeout-minutes` must sit
# above it, so this script always reports the reason rather than being killed
# mid-poll by the runner.
#
# Exit status: 0 only when the environment is Ready, reports EB_VERSION_LABEL as
# its running version, and its health is neither Grey nor Red. Anything else
# exits non-zero.

set -euo pipefail

EB_TOTAL_TIMEOUT_SECONDS="${EB_TOTAL_TIMEOUT_SECONDS:-2700}"
EB_SETTLE_TIMEOUT_SECONDS="${EB_SETTLE_TIMEOUT_SECONDS:-600}"
EB_HEALTH_SETTLE_SECONDS="${EB_HEALTH_SETTLE_SECONDS:-180}"
EB_POLL_INTERVAL_SECONDS="${EB_POLL_INTERVAL_SECONDS:-15}"
EB_UPDATE_MAX_ATTEMPTS="${EB_UPDATE_MAX_ATTEMPTS:-3}"

# Absolute epoch deadline for the whole run; set in main().
EB_RUN_DEADLINE=0

# Populated by read_environment_state.
EB_STATUS=''
EB_HEALTH=''
EB_CURRENT_VERSION=''

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

  if printf '%s' "${out}" | grep -qiF 'already exists'; then
    log "Application version '${EB_VERSION_LABEL}' already exists; reusing the existing version. AWS reported: ${out}"
    return 0
  fi

  fail "create-application-version failed for '${EB_VERSION_LABEL}' and the error is not an already-exists collision. AWS reported: ${out}"
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

    log "Applying version '${EB_VERSION_LABEL}' to '${EB_ENVIRONMENT_NAME}' (attempt ${attempt}/${EB_UPDATE_MAX_ATTEMPTS})"
    if out=$(aws elasticbeanstalk update-environment \
      --environment-name "${EB_ENVIRONMENT_NAME}" \
      --version-label "${EB_VERSION_LABEL}" 2>&1); then
      log "update-environment accepted version '${EB_VERSION_LABEL}'."
      return 0
    fi

    # EB rejects an update while another is running with "Environment named X is
    # in an invalid state for this operation. Must be Ready." That is the one
    # error worth retrying, because the environment settling makes it go away.
    if printf '%s' "${out}" | grep -qiE 'invalid state|concurrentupdate|concurrent update'; then
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
  local ready_since
  ready_since=0

  while :; do
    read_environment_state
    log "[verify] Status=${EB_STATUS} Health=${EB_HEALTH} Version=${EB_CURRENT_VERSION} (expecting Version=${EB_VERSION_LABEL})"
    fail_on_terminal_status "deployment verification"

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
        return 0
      fi

      if [ "$(( $(now_seconds) - ready_since ))" -ge "${EB_HEALTH_SETTLE_SECONDS}" ]; then
        fail "environment '${EB_ENVIRONMENT_NAME}' took version '${EB_VERSION_LABEL}' but its health stayed ${EB_HEALTH} for ${EB_HEALTH_SETTLE_SECONDS}s after becoming Ready."
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
  update_environment
  verify_deployment
  log "Deployment of '${EB_VERSION_LABEL}' to '${EB_ENVIRONMENT_NAME}' is complete and verified."
}

main "$@"
