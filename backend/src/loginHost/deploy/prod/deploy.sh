#!/bin/bash
# ENG-2110: the whole worker deploy, run as root by the SSM document from the extracted, signature-verified build tarball. Nothing here needs a person.
#
#   deploy.sh [--max-wait SEC] [--force] [--allow-older]
#
# A deploy must NEVER cut off a customer, and the host refuses customers' work only for as short a time as possible. Order:
#   1. prepare     install.sh --prepare: the slow part (bridge URL check, data disk, packages, node, the pinned claude download). Nothing here touches the
#                  running host, so it happens BEFORE any waiting and before any drain.
#   2. idle gate   deployctl acquire: wait until no turn is running and nobody is mid sign-in, then make the host refuse NEW work (the backend retries it; see
#                  runHostTurn). Waits up to --max-wait (default 1800 s). Nothing on disk has changed yet, so giving up is a clean no-op.
#   3. install     install.sh: stage, validate and switch the active release. Everything slow is done already, so this is seconds.
#   4. restart     seconds. Turns that start meanwhile wait and run once the host is back (connection refused is retried, nothing was admitted).
#   5. health      the new build answers with its protocol version and an undrained state within 60 s.
#   6. otherwise   roll back to the previous release (code, config, unit and slice), restart it, check it. A bad build is out within about a minute.
# Whatever ends the script lifts the drain again (an EXIT trap; the drain also expires by itself).
#
# Exit codes (the pipeline maps each one):
#   0  deployed (or already running: nothing to do)        75 host not idle within --max-wait (or the drain lapsed before the restart): NOTHING changed
#   1  the new build was bad; the previous one is serving again (rolled back)
#   2  the new build was bad AND the rollback failed: the host is DOWN (page someone)
#   3  not installed: /etc/aw-login-host/bridge-url missing (install.sh)
#   4  REFUSED: this build's number is LOWER than the one already deployed (a validly signed old build is still a downgrade)
#   5  REFUSED: this build carries no pipeline number at all, so it cannot be shown to be newer
#   22 aborted BEFORE the restart (hold file, lock, prepare/install failed, gate error, any unexpected failure): the running host was not restarted
#   24 an unexpected failure AFTER the restart began: look at the host
#   76 the running host predates the drain protocol and cannot be gated: a person must do the one-time bootstrap with --force
# --force skips the idle gate (an emergency fix, or the one-time bootstrap): running turns ARE cut off. It is logged loudly, never the default, and the
# SSM document never passes it. --allow-older lets a person on a Session Manager shell install an older or hand-made build on purpose.
# A hold file (/etc/aw-login-host/hold) makes every deploy stop with 22 before it does anything: the kill-switch for "do not touch the worker now".
#
# WHAT IS ACTUALLY RUNNING. `current` says which release is ACTIVE ON DISK; after a deploy that was killed half-way it can name a release the running host
# never started. So after every healthy start deploy.sh records the release the host is running (STATE_DIR/running-release), and "this exact build is already
# running: nothing to restart" is only believed when that record equals `current`; otherwise the host is restarted onto it, behind the same gate and health check.
#
# NO DOWNGRADES. The signature proves a build came from our pipeline, not that it is the latest: whoever can write to the build bucket could re-offer an
# old, correctly signed build with a known hole. So the build's sequence number (MANIFEST build_seq = the pipeline's run id, supplied by GitHub and checked
# by the signing job; a committer date would be attacker-chosen) must not be lower than that of the last build this worker finished deploying.
set -euo pipefail
umask 022

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_NAME=prod
SERVICE="aw-login-host@$ENV_NAME"
SOCK=/run/aw-login-host-prod/host.sock
LOCK=/run/aw-deploy/deploy.lock # in a root-only directory: any local user can open a file in /run for reading and hold a flock on it
HOLD=/etc/aw-login-host/hold
SYSTEMCTL=systemctl
NODE=/usr/bin/node
OPT=/opt/aw-login-host
MAX_WAIT=1800
HEALTH_TIMEOUT=60
STRICT_TTL=300 # how long the host keeps refusing new work if this script dies between the gate and the restart (only the switch, restart and health check run inside it)
FORCE=0
ALLOW_OLDER=0
STATE_DIR=/var/lib/aw-login-host

# Test seam (same convention as install.sh): never present in a build tarball, so on the worker none of these has any effect.
if [ -e "$HERE/.aw-test-mode" ]; then
  SYSTEMCTL=${AW_SYSTEMCTL:?AW_SYSTEMCTL}; SOCK=${AW_SOCK:?AW_SOCK}; LOCK=${AW_DEPLOY_LOCK:?AW_DEPLOY_LOCK}; NODE=${AW_NODE:?AW_NODE}; OPT=${AW_OPT:?AW_OPT}
  HEALTH_TIMEOUT=${AW_HEALTH_TIMEOUT:-60}; STATE_DIR=${AW_STATE_DIR:?AW_STATE_DIR}; HOLD=${AW_HOLD:?AW_HOLD}
fi

say() { printf '%s\n' "deploy: $*"; }

ctl() { "$NODE" "$HERE/deployctl.js" "$SOCK" "$@"; }

# ───────────────────────────── every way out goes through here ─────────────────────────────

PHASE=pre      # pre = the running host has not been restarted; post = a restart began
FINISHED=0     # set by finish(); an exit without it is an unexpected failure (set -e, a failed command) and must not be mistaken for a build outcome
DRAINED=0
finish() { FINISHED=1; exit "$1"; }
lift_drain() { [ "$DRAINED" != 1 ] || ctl release >/dev/null 2>&1 || true; }
on_exit() {
  local rc=$?
  lift_drain
  if [ "$FINISHED" != 1 ] && [ "$rc" != 0 ]; then
    if [ "$PHASE" = pre ]; then
      say "UNEXPECTED FAILURE (exit $rc) before the restart: the running host was not restarted"
      exit 22
    fi
    say "UNEXPECTED FAILURE (exit $rc) after the restart began: look at the host"
    exit 24
  fi
}
trap on_exit EXIT
# SIGTERM/SIGINT (an SSM cancel, a person's Ctrl-C): bash would otherwise leave on_exit seeing a clean status. Leave with a status that on_exit maps to 22 or 24.
trap 'exit 143' TERM INT
die() { say "FATAL $*"; finish "${2:-22}"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --max-wait) shift; MAX_WAIT=${1:?--max-wait needs seconds} ;;
    --force) FORCE=1 ;;
    --allow-older) ALLOW_OLDER=1 ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done
[[ "$MAX_WAIT" =~ ^(0|[1-9][0-9]{0,3})$ ]] && [ "$MAX_WAIT" -le 3000 ] || die "--max-wait must be a whole number of seconds, at most 3000"

LOCK_DIR=$(dirname "$LOCK")
mkdir -p "$LOCK_DIR"
chmod 0700 "$LOCK_DIR"
exec 8>"$LOCK"
flock -n 8 || die "another deploy is running (lock $LOCK)"

[ ! -e "$HOLD" ] || die "HELD: $HOLD exists, so nothing is deployed until a person removes it"

# ───────────────────────────── no downgrades ─────────────────────────────

build_seq=$(sed -n 's/^build_seq=//p' "$HERE/MANIFEST" 2>/dev/null | head -n1 || true)
last_seq=$(cat "$STATE_DIR/deployed-build-seq" 2>/dev/null || echo 0)
[[ "$last_seq" =~ ^[0-9]{1,18}$ ]] || last_seq=0
if ! [[ "$build_seq" =~ ^[0-9]{1,18}$ ]]; then
  if [ "$ALLOW_OLDER" != 1 ]; then
    say "REFUSED: this build has no valid pipeline number (build_seq) in its MANIFEST, so it cannot be shown to be newer than what is deployed. (A hand-made build needs --allow-older from a shell.)"
    finish 5
  fi
  build_seq=0
elif [ "$build_seq" -lt "$last_seq" ] && [ "$ALLOW_OLDER" != 1 ]; then
  say "REFUSED: this build (#$build_seq) is older than the one already deployed (#$last_seq). Nothing was changed. (A deliberate step back is a revert merge, or --allow-older from a shell.)"
  finish 4
fi
record_deployed() { # only ever moves forward; failing to write it must not turn a good deploy into a failed one
  if [ "$build_seq" -gt "$last_seq" ]; then
    { mkdir -p "$STATE_DIR" && printf '%s\n' "$build_seq" >"$STATE_DIR/deployed-build-seq.new" && mv -f "$STATE_DIR/deployed-build-seq.new" "$STATE_DIR/deployed-build-seq"; } \
      || say "WARNING: could not record build #$build_seq as deployed (the no-downgrade mark is behind)"
  fi
}

record_running() { # the release the host was just seen healthy on
  { mkdir -p "$STATE_DIR" && readlink "$OPT/current" >"$STATE_DIR/running-release.new" && mv -f "$STATE_DIR/running-release.new" "$STATE_DIR/running-release"; } \
    || say "WARNING: could not record which release is running (the next deploy will restart rather than skip)"
}

# Restart the service and wait for this build to answer. Returns the health result.
restart_and_check() { # restart_and_check [--any-protocol]
  PHASE=post
  "$SYSTEMCTL" reset-failed "$SERVICE" >/dev/null 2>&1 || true # a crash loop that hit its start limit must not block this restart
  "$SYSTEMCTL" restart "$SERVICE" || return 1
  DRAINED=0 # a restart clears the drain
  ctl health --timeout "$HEALTH_TIMEOUT" "$@" && record_running
}

# Put the previous release back (only if there is one) and bring it up.
roll_back() {
  [ -L "$OPT/previous" ] || { say "there is no previous release to roll back to"; return 1; }
  "$HERE/install.sh" --rollback || return 1
  # The restart that puts the old build back also ends whatever the failing new build accepted meanwhile. Try to wait for a quiet moment first, but only briefly:
  # a build that is unhealthy must not stay up longer than it has to. (If the host does not answer, there is nobody to wait for.)
  if ctl info >/dev/null 2>&1; then ctl acquire --total 20 --strict-ttl "$STRICT_TTL" >/dev/null 2>&1 && DRAINED=1 || true; fi
  restart_and_check --any-protocol # the old build speaks its own protocol version, not this tarball's
}

# ───────────────────────────── 1. prepare (slow, harmless to a running host) ─────────────────────────────

set +e
"$HERE/install.sh" --prepare
rc=$?
set -e
if [ "$rc" = 3 ]; then
  say "NOT installed: /etc/aw-login-host/bridge-url is missing or invalid"
  finish 3
fi
[ "$rc" = 0 ] || die "preparing the machine failed (exit $rc); the running host, if any, was not touched"

# Is there a host that has customers on it? Decided AFTER the slow preparation (it can take half an hour, and a host may have been started, or be in the middle of
# restarting itself, meanwhile), and by systemd's own state: only a unit that is stopped or failed has nobody to protect. `activating` (a start or an auto-restart in
# progress) counts as running: the gate then waits until it listens and is idle.
state=$("$SYSTEMCTL" show -p ActiveState --value "$SERVICE" 2>/dev/null || echo unknown)
case "$state" in inactive | failed) was_active=0 ;; *) was_active=1 ;; esac
[ "$state" != unknown ] || { [ "$("$SYSTEMCTL" cat "$SERVICE" >/dev/null 2>&1; echo $?)" = 0 ] || was_active=0; } # a unit systemd has never heard of (first install) is not running

# ───────────────────────────── 2. idle gate (nothing on disk has changed yet) ─────────────────────────────

if [ "$was_active" = 1 ]; then
  if [ "$FORCE" = 1 ]; then
    say "FORCE: skipping the idle gate. Running turns and sign-ins WILL be cut off by the restart."
  else
    DRAINED=1 # from here on, whatever ends this script lifts the drain (a harmless no-op if the host never granted it)
    set +e
    ctl acquire --total "$MAX_WAIT" --strict-ttl "$STRICT_TTL"
    rc=$?
    set -e
    case "$rc" in
      0) ;;
      75)
        say "NOT DEPLOYED: the host was not idle within ${MAX_WAIT}s. Nothing was changed or restarted; run the deploy again later."
        finish 75
        ;;
      76)
        DRAINED=0
        say "NOT DEPLOYED: the running host predates the drain protocol, so it cannot be told to wait for idle. Nothing was changed. A person must do the one-time bootstrap: run this deploy with --force from a Session Manager shell, when nobody is using the worker."
        finish 76
        ;;
      *) die "the idle gate failed (exit $rc); nothing was changed or restarted" ;;
    esac
  fi
fi

# ───────────────────────────── 3. install (seconds: everything slow was done in step 1) ─────────────────────────────

active_before=$(readlink "$OPT/current" 2>/dev/null || true)
set +e
"$HERE/install.sh"
rc=$?
set -e
if [ "$rc" != 0 ]; then
  # An install that failed AFTER the switch (rare: daemon-reload, prune) must not leave the new release active under a host still running the old one.
  if [ -n "$active_before" ] && [ "$(readlink "$OPT/current" 2>/dev/null || true)" != "$active_before" ]; then
    "$HERE/install.sh" --rollback >/dev/null 2>&1 && say "reverted the active release after the failed install" || say "WARNING: install failed after switching and the revert failed too"
  fi
  [ "$rc" != 3 ] || finish 3
  die "install failed (exit $rc); the running host, if any, was not restarted"
fi

# Nothing changed (same build, certificates and settings): nothing a restart would change, so the least disruptive deploy is none.
if [ "$was_active" = 1 ] && [ "$FORCE" != 1 ] && [ -n "$active_before" ] && [ "$(readlink "$OPT/current" 2>/dev/null || true)" = "$active_before" ] \
  && [ "$(cat "$STATE_DIR/running-release" 2>/dev/null || true)" = "$active_before" ]; then
  record_deployed
  say "OK   this exact build and configuration is already running: nothing to restart"
  finish 0
fi

# ───────────────────────────── a host that is not running has nobody to protect ─────────────────────────────

if [ "$was_active" = 0 ]; then
  say "the service was not running: starting it"
  if restart_and_check; then
    record_deployed
    say "OK   deployed (first start)"
    finish 0
  fi
  say "the new build did not come up healthy"
  if roll_back; then say "rolled back; the previous build is serving"; finish 1; fi
  say "DOWN: the service is not healthy and there was nothing healthy to go back to"
  finish 2
fi

# ───────────────────────────── 4 + 5. restart and check ─────────────────────────────

# The drain must still be on right before the restart, with a fresh lifetime. Asking again is cheap and idempotent (it renews the drain while the host is idle); if the
# host has become busy since, undo the switch and give up cleanly: a restart must never reach a host that has customers on it.
if [ "$FORCE" != 1 ]; then
  set +e
  ctl acquire --total 300 --strict-ttl "$STRICT_TTL" >/dev/null
  rc=$?
  set -e
  if [ "$rc" != 0 ]; then
    "$HERE/install.sh" --rollback >/dev/null 2>&1 && say "reverted the active release" || say "WARNING: could not revert the active release; the running host is unaffected"
    say "NOT DEPLOYED: the host became busy again before the restart. Nothing was restarted; run the deploy again later."
    finish 75
  fi
  DRAINED=1
fi
drain_started=$SECONDS

if restart_and_check; then
  record_deployed
  window=$((SECONDS - drain_started))
  [ "$window" -le 30 ] || say "WARNING: the host refused new work for ${window}s around the restart (the backend retries for 40 s): look at what was slow"
  say "OK   deployed; $(ctl info 2>/dev/null || echo 'host.info unavailable')"
  finish 0
fi

# ───────────────────────────── 6. bad build: back to the previous one ─────────────────────────────

say "the new build is NOT healthy: rolling back"
if roll_back; then
  say "ROLLED BACK: the previous build is serving again. This deploy FAILED; look at the host's journal for the cause."
  finish 1
fi
say "DOWN: the new build is unhealthy and the rollback did not come up either. Page someone."
finish 2
