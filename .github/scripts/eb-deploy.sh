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
#   EB_SETTLE_TIMEOUT_SECONDS    Max wait for a pre-existing update to finish (default 600)
#   EB_DEPLOY_TIMEOUT_SECONDS    Max wait for this version to go live (default 2400)
#   EB_HEALTH_SETTLE_SECONDS     Grace for health to leave Grey/Red once Ready (default 180)
#   EB_POLL_INTERVAL_SECONDS     Seconds between describe-environments polls (default 15)
#   EB_UPDATE_MAX_ATTEMPTS       Retries for a concurrent-update collision (default 3)
#
# Exit status: 0 only when the environment is Ready, reports EB_VERSION_LABEL as
# its running version, and its health is neither Grey nor Red. Anything else
# exits non-zero.

set -euo pipefail

EB_SETTLE_TIMEOUT_SECONDS="${EB_SETTLE_TIMEOUT_SECONDS:-600}"
EB_DEPLOY_TIMEOUT_SECONDS="${EB_DEPLOY_TIMEOUT_SECONDS:-2400}"
EB_HEALTH_SETTLE_SECONDS="${EB_HEALTH_SETTLE_SECONDS:-180}"
EB_POLL_INTERVAL_SECONDS="${EB_POLL_INTERVAL_SECONDS:-15}"
EB_UPDATE_MAX_ATTEMPTS="${EB_UPDATE_MAX_ATTEMPTS:-3}"

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
  deadline=$(( $(now_seconds) + EB_SETTLE_TIMEOUT_SECONDS ))

  while :; do
    read_environment_state
    log "[${phase}] Status=${EB_STATUS} Health=${EB_HEALTH} Version=${EB_CURRENT_VERSION}"
    fail_on_terminal_status "${phase}"

    if [ "${EB_STATUS}" = "Ready" ]; then
      return 0
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
  local deadline ready_since
  deadline=$(( $(now_seconds) + EB_DEPLOY_TIMEOUT_SECONDS ))
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
    fi

    if [ "$(now_seconds)" -ge "${deadline}" ]; then
      fail "environment '${EB_ENVIRONMENT_NAME}' did not come up Ready on version '${EB_VERSION_LABEL}' within ${EB_DEPLOY_TIMEOUT_SECONDS}s. Last observed Status=${EB_STATUS} Health=${EB_HEALTH} Version=${EB_CURRENT_VERSION}."
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

  log "Deploying '${EB_VERSION_LABEL}' to application '${EB_APPLICATION_NAME}' environment '${EB_ENVIRONMENT_NAME}'."
  create_application_version
  update_environment
  verify_deployment
  log "Deployment of '${EB_VERSION_LABEL}' to '${EB_ENVIRONMENT_NAME}' is complete and verified."
}

main "$@"
