#!/usr/bin/env bash
#
# Fail a PR that changes Elastic Beanstalk RESOURCE config and INSTANCE config
# in the same deploy (ENG-836 AC3).
#
# Production deploys immutable. AWS refuses:
#
#   ERROR  Cannot update resource configuration and instance configuration
#          simultaneously with immutable deployments.
#
# On 2026-08-01 PR #2237 changed `aws:elbv2:loadbalancer IdleTimeout` (resource)
# together with `.platform/nginx/*.conf` (instance). EB accepted the request and
# then refused it, prod stayed Ready/Green on the PREVIOUS version, and the
# deploy burned its full 2700s budget before failing. Because the change then
# sat on `main`, every subsequent merge inherited it and failed identically —
# production was undeployable for roughly 29 hours and an innocent PR (#2234)
# failed for a fault that was never its own.
#
# Staging cannot catch this: staging is `AllAtOnce`, which has no
# resource/instance restriction, so it accepts the identical change and reports
# green. That green is evidence of nothing about prod. This script is the
# substitute for a check staging structurally cannot perform.
#
# Usage:
#   git diff --name-only "$BASE...$HEAD" | bash .github/scripts/eb-config-conflict.sh
#   bash .github/scripts/eb-config-conflict.sh file1 file2 ...
#
# Exit status: 0 when the change is safe to deploy in one operation, 1 when it
# must be split into two sequential deploys.
#
# Optional environment:
#   EB_CONFLICT_REPO_ROOT   Root to resolve changed paths against (default: cwd)
#   EB_CONFLICT_BASE_REF    Git ref to read DELETED files from, so a removal can
#                           be classified by what it removed instead of guessed
#                           at. CI passes the PR's base SHA.

set -euo pipefail

REPO_ROOT="${EB_CONFLICT_REPO_ROOT:-.}"
BASE_REF="${EB_CONFLICT_BASE_REF:-}"

# Namespaces that modify SHARED AWS RESOURCES (the load balancer, the ASG, the
# environment's process/target-group settings). Changing one of these is a
# "resource configuration" update.
#
# Deliberately narrow: only namespaces we have evidence for. An unrecognised
# namespace is left unclassified rather than guessed at, because a gate that
# fires on innocent PRs gets switched off within a week and then protects
# nothing. `aws:elbv2:loadbalancer` is the one that actually caused ENG-836.
RESOURCE_NAMESPACES=(
  'aws:elbv2:'
  'aws:elb:'
  'aws:autoscaling:asg'
  'aws:autoscaling:trigger'
  'aws:elasticbeanstalk:environment:process:'
  'aws:rds:'
)

# Surfaces that modify the EC2 INSTANCES themselves.
INSTANCE_NAMESPACES=(
  'aws:autoscaling:launchconfiguration'
)

# Top-level .ebextensions keys that run on the instance.
INSTANCE_KEYS=(
  'files:'
  'commands:'
  'container_commands:'
  'packages:'
  'services:'
)

log() { printf '[eb-config-conflict] %s\n' "$1"; }

# Content of a changed file, for classification.
#
# A DELETED or renamed config still carries a delta: removing a file that
# declared `aws:elbv2:loadbalancer` is a resource change, and removing one that
# declared `commands:` is an instance change. Guessing which is unnecessary —
# the content is still in git. Read it from the base ref and classify the
# removal by exactly what it removed.
#
# Echoes the content, or nothing if it cannot be recovered.
content_of() {
  local f="$1" path="${REPO_ROOT%/}/$1"
  if [ -f "${path}" ]; then
    cat "${path}"
    return 0
  fi
  if [ -n "${BASE_REF}" ]; then
    git -C "${REPO_ROOT}" show "${BASE_REF}:${f}" 2>/dev/null || true
  fi
}

# Does $1 (a blob of content) contain any needle from the named array?
contains_any() {
  local content="$1" needle
  shift
  for needle in "$@"; do
    if printf '%s' "${content}" | grep -qF "${needle}"; then
      return 0
    fi
  done
  return 1
}

main() {
  local changed=() line
  if [ "$#" -gt 0 ]; then
    changed=("$@")
  else
    while IFS= read -r line || [ -n "${line}" ]; do
      [ -n "${line}" ] && changed+=("${line}")
    done
  fi

  if [ "${#changed[@]}" -eq 0 ]; then
    log "No changed files supplied; nothing to check."
    return 0
  fi

  local resource_hits='' instance_hits='' unclassified='' f content

  for f in "${changed[@]}"; do
    case "${f}" in
      # Instance config: platform hooks and nginx conf ship with the instance.
      *.platform/*)
        instance_hits="${instance_hits}  ${f} (.platform — instance config)"$'\n'
        continue
        ;;
      *.ebextensions/*.config) ;;
      *) continue ;;
    esac

    content="$(content_of "${f}")"

    # Content unavailable: deleted AND no base ref to recover it from. We
    # cannot tell which side it belonged to, so it counts as BOTH — an
    # unreadable delta must never be read as proof that nothing changed on
    # either side.
    if [ -z "${content}" ]; then
      unclassified="${unclassified}  ${f} (content unavailable — counted as both resource and instance)"$'\n'
      continue
    fi

    local origin=''
    [ -f "${REPO_ROOT%/}/${f}" ] || origin=' (deleted — classified from its removed content)'

    if contains_any "${content}" "${RESOURCE_NAMESPACES[@]}"; then
      resource_hits="${resource_hits}  ${f} (resource namespace)${origin}"$'\n'
    fi

    if contains_any "${content}" "${INSTANCE_NAMESPACES[@]}" || \
       contains_any "${content}" "${INSTANCE_KEYS[@]}"; then
      instance_hits="${instance_hits}  ${f} (instance config)${origin}"$'\n'
    fi
  done

  # An unrecoverable config counts as BOTH sides, so it conflicts with any
  # other config change — including another unrecoverable one.
  if [ -z "${resource_hits}" ] && [ -z "${unclassified}" ]; then
    log "No Elastic Beanstalk resource-config change in this diff; safe to deploy in one operation."
    return 0
  fi

  if [ -z "${instance_hits}" ] && [ -z "${unclassified}" ]; then
    log "Resource-config change detected, with no instance-config change alongside it:"
    printf '%s' "${resource_hits}${unclassified}"
    log "Safe: an immutable deploy accepts a resource-only update."
    return 0
  fi

  printf '::error::EB_CONFIG_CONFLICT: this PR changes Elastic Beanstalk resource config AND instance config in the same deploy. Production deploys immutable, which forbids that combination, so the deploy will be accepted and then refused — burning its full timeout while production silently stays on the previous version (ENG-836). Split it into two sequential PRs: resource-only first, then instance-only.\n'
  log 'EB_CONFIG_CONFLICT — resource config and instance config changed together.'
  if [ -n "${resource_hits}" ]; then
    log 'Resource-config changes:'
    printf '%s' "${resource_hits}"
  fi
  if [ -n "${unclassified}" ]; then
    log 'Unrecoverable changes (counted as BOTH resource and instance):'
    printf '%s' "${unclassified}"
  fi
  log 'Instance-config changes:'
  printf '%s' "${instance_hits}"
  log 'Fix: split into two sequential deploys. Resource-only lands first and'
  log 'settles, then instance-only. Neither trips the immutable constraint.'
  log 'Staging will NOT reproduce this: staging is AllAtOnce and accepts it.'
  return 1
}

main "$@"
