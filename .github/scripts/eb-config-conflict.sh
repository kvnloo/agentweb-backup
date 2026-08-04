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

set -euo pipefail

REPO_ROOT="${EB_CONFLICT_REPO_ROOT:-.}"

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

# Does $1 (a file's content) contain any needle from the named array?
contains_any() {
  local file="$1" needle
  shift
  for needle in "$@"; do
    if grep -qF "${needle}" "${file}" 2>/dev/null; then
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

  local resource_hits='' instance_hits='' unclassified='' f path

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

    path="${REPO_ROOT%/}/${f}"
    # A deleted or renamed config has no content left to classify, but its
    # REMOVAL is still a delta — deleting a file that declared
    # `aws:elbv2:loadbalancer` is a resource change just as surely as editing
    # it. Treating that as "nothing to see" let an incompatible combined delta
    # through (Greptile P1 on #2267).
    #
    # It is counted as unclassified, and unclassified is treated as
    # possibly-resource below. Same rule the rest of this pipeline follows: a
    # check that cannot see what changed must never be read as proof that
    # nothing did.
    if [ ! -f "${path}" ]; then
      unclassified="${unclassified}  ${f} (deleted or renamed — content unavailable to classify)"$'\n'
      continue
    fi

    if contains_any "${path}" "${RESOURCE_NAMESPACES[@]}"; then
      resource_hits="${resource_hits}  ${f} (resource namespace)"$'\n'
    fi

    if contains_any "${path}" "${INSTANCE_NAMESPACES[@]}" || \
       contains_any "${path}" "${INSTANCE_KEYS[@]}"; then
      instance_hits="${instance_hits}  ${f} (instance config)"$'\n'
    fi
  done

  # An unclassifiable config counts as possibly-resource. On its own it is
  # harmless; only paired with an instance change does it become a risk.
  if [ -z "${resource_hits}" ] && [ -z "${unclassified}" ]; then
    log "No Elastic Beanstalk resource-config change in this diff; safe to deploy in one operation."
    return 0
  fi

  if [ -z "${instance_hits}" ]; then
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
    log 'Possibly-resource changes (could not be classified, treated as resource):'
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
