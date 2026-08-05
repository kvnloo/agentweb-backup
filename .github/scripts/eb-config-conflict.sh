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
# Exit status: 1 when this file combination is CERTAIN to be rejected. 0 means
# only "not that known-bad combination" — it does NOT mean the deploy will
# succeed. Read the limitation below before trusting a pass.
#
# ============================ WHAT THIS CANNOT SEE ===========================
# EB rejects an update carrying a resource-config DELTA against the
# environment's LIVE option settings at the same time as a bundle change. Every
# application deploy uploads a bundle. So an `.ebextensions` resource change
# cannot ride a normal deploy AT ALL — not even alone in its own PR.
#
# This script classifies FILE PATHS. It cannot observe a delta-against-live-
# state, so it cannot decide deployability, and adding namespaces will not fix
# that.
#
# Proven on 2026-08-04 at the cost of ~50 minutes of undeployable `main`
# (ENG-818 #2277): a resource-only PR passed this gate, and its production
# deploy was rejected with the exact error this gate exists to prevent. The
# author merged partly BECAUSE this gate passed. Then the revert (#2279)
# touched the same file with the same bundle shape and was accepted, because it
# set the value back to what the ALB already had — no delta.
#
#   .ebextensions resource edit alone   -> this gate PASSES, prod REJECTS
#   .ebextensions touched, value live   -> this gate PASSES, prod accepts
#   .ebextensions + .platform           -> this gate BLOCKS, prod rejects
#
# It is right about the third case and blind to the first two. Treat a pass as
# "no known-bad file pair", never as "safe to deploy".
#
# The real check belongs in eb-deploy.sh, which already reads the live
# environment and can compare declared option_settings against actual values
# before calling update-environment. Tracked on ENG-836.
# =============================================================================
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

# Content of a changed file for classification: the UNION of what it said
# before and what it says now.
#
# A change carries a delta in BOTH directions, so either revision alone is
# blind to half of them:
#
#   added declaration      only in head   (edit adds aws:elbv2:loadbalancer)
#   REMOVED declaration    only in base   (edit deletes that block in place)
#   deleted file           only in base   (whole file removed)
#   new file               only in head
#
# Reading head alone missed whole-file deletions. Reading head, plus base only
# for absent paths, still missed an in-place removal — a file that keeps
# existing while dropping its `aws:elbv2:loadbalancer` block contributed no
# resource hit, so pairing that with an instance change sailed through. Both
# were Greptile findings on #2267.
#
# The union is the honest answer: removing a declaration is as much a delta as
# adding one, and classification should not care which direction it went.
#
# Echoes the combined content, or nothing if neither revision is readable.
content_of() {
  local f="$1" path="${REPO_ROOT%/}/$1"
  if [ -n "${BASE_REF}" ]; then
    git -C "${REPO_ROOT}" show "${BASE_REF}:${f}" 2>/dev/null || true
  fi
  if [ -f "${path}" ]; then
    cat "${path}"
  fi
}

# Echoes every needle from the named array that appears in $1, one per line.
# The warning below names the namespaces a PR actually touches, rather than
# assuming the load-balancer one: a PR changing `aws:autoscaling:asg` that was
# told to inspect `aws:elbv2:loadbalancer` would find nothing and conclude it
# was safe — the exact misleading-guidance failure this file exists to remove.
matched_needles() {
  local content="$1" needle
  shift
  for needle in "$@"; do
    if printf '%s' "${content}" | grep -qF "${needle}"; then
      printf '%s\n' "${needle}"
    fi
  done
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
  local touched_namespaces=''

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
    if [ -n "${origin}" ]; then
      :
    elif [ -n "${BASE_REF}" ]; then
      origin=' (classified from base+head, so removed declarations count too)'
    fi

    if contains_any "${content}" "${RESOURCE_NAMESPACES[@]}"; then
      resource_hits="${resource_hits}  ${f} (resource namespace)${origin}"$'\n'
      touched_namespaces="${touched_namespaces}$(matched_needles "${content}" "${RESOURCE_NAMESPACES[@]}")"$'\n'
    fi

    if contains_any "${content}" "${INSTANCE_NAMESPACES[@]}" || \
       contains_any "${content}" "${INSTANCE_KEYS[@]}"; then
      instance_hits="${instance_hits}  ${f} (instance config)${origin}"$'\n'
    fi
  done

  # An unrecoverable config counts as BOTH sides, so it conflicts with any
  # other config change — including another unrecoverable one.
  if [ -z "${resource_hits}" ] && [ -z "${unclassified}" ]; then
    log "No Elastic Beanstalk resource-config file changed in this diff."
    log "PASS means: not the known-bad file combination. It does NOT verify deployability."
    return 0
  fi

  if [ -z "${instance_hits}" ] && [ -z "${unclassified}" ]; then
    log "Resource-config change detected, with no instance-config change alongside it:"
    printf '%s' "${resource_hits}${unclassified}"
    log ""
    log "NOT PASSING THIS AS SAFE. A resource-config change cannot ride a normal"
    log "application deploy even on its own: every deploy uploads a bundle, and"
    log "immutable rejects a live-value delta plus a bundle together. A PR shaped"
    log "exactly like this one (#2277) was rejected in production and left main"
    log "undeployable for ~50 minutes."
    log ""
    # Filter to the namespaces THIS diff touches. A generic example naming only
    # the load-balancer namespace would send an autoscaling or RDS change
    # looking in the wrong place and finding nothing.
    local ns filter=''
    while IFS= read -r ns; do
      [ -z "${ns}" ] && continue
      case "${filter}" in
        *"'${ns}'"*) continue ;;
      esac
      [ -n "${filter}" ] && filter="${filter} || "
      filter="${filter}starts_with(Namespace, '${ns}')"
    done <<<"${touched_namespaces}"
    [ -z "${filter}" ] && filter="starts_with(Namespace, 'aws:')"

    log "This gate cannot tell whether your value differs from the environment's"
    log "LIVE setting, which is what actually decides. Before merging, check the"
    log "namespaces this diff touches:"
    log "  aws elasticbeanstalk describe-configuration-settings \\"
    log "    --application-name agentweb-backend \\"
    log "    --environment-name Agentweb-backend-env-prod-3 \\"
    log "    --query \"ConfigurationSettings[0].OptionSettings[?${filter}]\""
    log ""
    log "If the live value already matches, there is no delta and the deploy is"
    log "fine. If it differs, apply it with 'update-environment --option-settings'"
    log "and NO version change first. See ENG-818 / ENG-836."
    log ""
    log "Exiting 0 because this is not the known-bad file pair, but this is a"
    log "warning, not a clearance."
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
