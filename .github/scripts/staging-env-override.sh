#!/usr/bin/env bash
#
# ENG-2359: set or restore per-run env overrides on the BACKEND STAGING
# Elastic Beanstalk environment, so post-merge verifiers can exercise
# kill-switch / ceiling paths (e.g. ENG-2353) without touching production.
#
# Usage:
#   EB_ENVIRONMENT_NAME=<staging env> bash .github/scripts/staging-env-override.sh set KEY=VALUE [KEY=VALUE ...]
#   EB_ENVIRONMENT_NAME=<staging env> bash .github/scripts/staging-env-override.sh restore KEY [KEY ...]
#   EB_ENVIRONMENT_NAME=<staging env> bash .github/scripts/staging-env-override.sh show
#
# Safety:
#   - Refuses any environment whose name does not contain "staging".
#   - Only keys in ALLOWED_KEYS may be set or removed (no secrets, no infra).
#   - `restore` REMOVES the override so the code default applies again.
#   - Each set/restore waits for the env to return to Ready (EB restarts the
#     app server when env properties change).
#
# AWS_CMD may be overridden (tests inject a fake).

set -euo pipefail

AWS_CMD="${AWS_CMD:-aws}"
AWS_REGION="${AWS_REGION:-us-east-1}"
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-900}"
WAIT_INTERVAL_SECONDS="${WAIT_INTERVAL_SECONDS:-15}"
NAMESPACE="aws:elasticbeanstalk:application:environment"

ALLOWED_KEYS=(
  LEAD_MAGNET_EXECUTE_DISABLED
  LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY
)

die() { echo "staging-env-override: $*" >&2; exit 2; }

is_allowed() {
  local k="$1" a
  for a in "${ALLOWED_KEYS[@]}"; do [[ "$k" == "$a" ]] && return 0; done
  return 1
}

ENV_NAME="${EB_ENVIRONMENT_NAME:-}"
[[ -n "$ENV_NAME" ]] || die "EB_ENVIRONMENT_NAME is required"
shopt -s nocasematch
[[ "$ENV_NAME" == *staging* ]] || die "refusing non-staging environment '$ENV_NAME'"
shopt -u nocasematch

wait_ready() {
  local deadline=$(( SECONDS + WAIT_TIMEOUT_SECONDS )) status
  while :; do
    status="$("$AWS_CMD" elasticbeanstalk describe-environments --region "$AWS_REGION" \
      --environment-names "$ENV_NAME" --query 'Environments[0].Status' --output text)"
    [[ "$status" == "Ready" ]] && return 0
    (( SECONDS >= deadline )) && die "timed out waiting for Ready (last: $status)"
    sleep "$WAIT_INTERVAL_SECONDS"
  done
}

cmd="${1:-}"; shift || true
case "$cmd" in
  set)
    [[ $# -gt 0 ]] || die "set needs KEY=VALUE"
    opts=()
    for kv in "$@"; do
      [[ "$kv" == *=* ]] || die "bad assignment '$kv'"
      key="${kv%%=*}"; val="${kv#*=}"
      is_allowed "$key" || die "key '$key' is not in the override allowlist"
      [[ "$val" != *,* ]] || die "value for '$key' must not contain commas"
      opts+=("Namespace=${NAMESPACE},OptionName=${key},Value=${val}")
    done
    wait_ready
    "$AWS_CMD" elasticbeanstalk update-environment --region "$AWS_REGION" \
      --environment-name "$ENV_NAME" --option-settings "${opts[@]}" >/dev/null
    wait_ready
    echo "set on $ENV_NAME: $*"
    ;;
  restore)
    [[ $# -gt 0 ]] || die "restore needs KEY"
    opts=()
    for key in "$@"; do
      is_allowed "$key" || die "key '$key' is not in the override allowlist"
      opts+=("Namespace=${NAMESPACE},OptionName=${key}")
    done
    wait_ready
    "$AWS_CMD" elasticbeanstalk update-environment --region "$AWS_REGION" \
      --environment-name "$ENV_NAME" --options-to-remove "${opts[@]}" >/dev/null
    wait_ready
    echo "restored on $ENV_NAME: $*"
    ;;
  show)
    "$AWS_CMD" elasticbeanstalk describe-configuration-settings --region "$AWS_REGION" \
      --application-name "${EB_APPLICATION_NAME:?EB_APPLICATION_NAME is required for show}" \
      --environment-name "$ENV_NAME" \
      --query "ConfigurationSettings[0].OptionSettings[?Namespace=='${NAMESPACE}' && starts_with(OptionName, 'LEAD_MAGNET_')].[OptionName,Value]" \
      --output text
    ;;
  *) die "usage: set KEY=VALUE... | restore KEY... | show" ;;
esac
