#!/bin/bash
# ENG-2110: the whole worker deploy, run as root by the SSM document from the extracted, signature-verified build tarball. Nothing here needs a person.
#
#   deploy.sh [--max-wait SEC] [--force] [--allow-older]
#
# A deploy must NEVER cut off a customer, and must not change anything on disk that a running turn could notice while it waits. Order:
#   1. idle gate   deployctl acquire: wait until no turn is running and nobody is mid sign-in, then make the host refuse NEW work (the backend retries
#                  it; see runHostTurn). Waits up to --max-wait (default 1800 s). NOTHING on disk has changed yet, so giving up is a clean no-op.
#   2. install     install.sh stages, validates and switches the active release (dnf, node, the unit, the slice, `current`, the config). The host is
#                  drained meanwhile, so no customer work runs while these change. An identical build changes nothing and ends the deploy here.
#   3. restart     seconds. Turns that start meanwhile wait and run once the host is back (connection refused is retried, nothing was admitted).
#   4. health      the new build answers with its protocol version and an undrained state within 60 s.
#   5. otherwise   roll back to the previous release, restart it, check it. A bad build is out within about a minute and nobody had to notice.
# Whatever ends the script early lifts the drain again (an EXIT trap; the drain also expires by itself).
#
# Exit codes (the pipeline maps each one):
#   0  deployed (or already running: nothing to do)        75 host not idle within --max-wait: NOTHING changed, run again later
#   1  the new build was bad; the previous one is serving again (rolled back)
#   2  the new build was bad AND the rollback failed: the host is DOWN (page someone)
#   3  not installed: /etc/aw-login-host/bridge-url missing (install.sh)
#   4  REFUSED: this build is not newer than the one already deployed (a validly signed old build is still a downgrade)
#   22 not started or aborted BEFORE the restart (lock held, install failed, gate error): the running host was not restarted
#   76 the running host predates the drain protocol and cannot be gated: a person must do the one-time bootstrap with --force
# --force skips the idle gate (an emergency fix, or the one-time bootstrap): running turns ARE cut off. It is logged loudly, never the default, and the
# SSM document never passes it. --allow-older lets a person on a Session Manager shell install an older build on purpose.
#
# NO DOWNGRADES. The signature proves a build came from our pipeline, not that it is the latest: whoever can write to the build bucket could re-offer an
# old, correctly signed build with a known hole. So the build's sequence number (MANIFEST build_seq = the pipeline's run number, signed with the tarball;
# a committer date would be attacker-chosen) must not be lower than that of the last build this worker finished deploying. A build with no number
# (built by hand) is refused too. Going back deliberately is a revert merge (a new, higher run), or --allow-older from a shell.
set -euo pipefail
umask 022

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_NAME=prod
SERVICE="aw-login-host@$ENV_NAME"
SOCK=/run/aw-login-host-prod/host.sock
LOCK=/run/aw-deploy/deploy.lock # in a root-only directory: any local user can open a file in /run for reading and hold a flock on it
SYSTEMCTL=systemctl
NODE=/usr/bin/node
OPT=/opt/aw-login-host
MAX_WAIT=1800
HEALTH_TIMEOUT=60
STRICT_TTL=900 # how long the host keeps refusing new work while install.sh runs, if this script dies
FORCE=0
ALLOW_OLDER=0
STATE_DIR=/var/lib/aw-login-host

# Test seam (same convention as install.sh): never present in a build tarball, so on the worker none of these has any effect.
if [ -e "$HERE/.aw-test-mode" ]; then
  SYSTEMCTL=${AW_SYSTEMCTL:?AW_SYSTEMCTL}; SOCK=${AW_SOCK:?AW_SOCK}; LOCK=${AW_DEPLOY_LOCK:?AW_DEPLOY_LOCK}; NODE=${AW_NODE:?AW_NODE}; OPT=${AW_OPT:?AW_OPT}
  HEALTH_TIMEOUT=${AW_HEALTH_TIMEOUT:-60}; STATE_DIR=${AW_STATE_DIR:?AW_STATE_DIR}
fi

say() { printf '%s\n' "deploy: $*"; }
die() { say "FATAL $*" >&2; exit "${2:-22}"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --max-wait) shift; MAX_WAIT=${1:?--max-wait needs seconds} ;;
    --force) FORCE=1 ;;
    --allow-older) ALLOW_OLDER=1 ;;
    *) echo "deploy: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
case "$MAX_WAIT" in '' | *[!0-9]*) die "--max-wait must be a whole number of seconds" ;; esac

LOCK_DIR=$(dirname "$LOCK")
mkdir -p "$LOCK_DIR"
chmod 0700 "$LOCK_DIR"
exec 8>"$LOCK"
flock -n 8 || die "another deploy is running (lock $LOCK)"

ctl() { "$NODE" "$HERE/deployctl.js" "$SOCK" "$@"; }

# ───────────────────────────── no downgrades ─────────────────────────────

build_seq=$(sed -n 's/^build_seq=//p' "$HERE/MANIFEST" 2>/dev/null | head -n1 || true)
last_seq=$(cat "$STATE_DIR/deployed-build-seq" 2>/dev/null || echo 0)
case "$last_seq" in '' | *[!0-9]*) last_seq=0 ;; esac
case "$build_seq" in
  '' | *[!0-9]*)
    if [ "$ALLOW_OLDER" != 1 ]; then
      say "REFUSED: this build has no pipeline sequence number (build_seq) in its MANIFEST, so it cannot be shown to be newer than what is deployed. (A hand-made build needs --allow-older from a shell.)"
      exit 4
    fi
    build_seq=0
    ;;
  *)
    if [ "$build_seq" -lt "$last_seq" ] && [ "$ALLOW_OLDER" != 1 ]; then
      say "REFUSED: this build (#$build_seq) is older than the one already deployed (#$last_seq). Nothing was changed. (A deliberate step back is a revert merge, or --allow-older from a shell.)"
      exit 4
    fi
    ;;
esac
record_deployed() { # only ever moves forward; failing to write it must not turn a good deploy into a failed one
  if [ "$build_seq" -gt "$last_seq" ]; then
    { mkdir -p "$STATE_DIR" && printf '%s\n' "$build_seq" >"$STATE_DIR/deployed-build-seq.new" && mv -f "$STATE_DIR/deployed-build-seq.new" "$STATE_DIR/deployed-build-seq"; } \
      || say "WARNING: could not record build #$build_seq as deployed (the no-downgrade mark is behind)"
  fi
}

# ───────────────────────────── the drain is always lifted again ─────────────────────────────

DRAINED=0
lift_drain() { [ "$DRAINED" != 1 ] || ctl release >/dev/null 2>&1 || true; }
trap lift_drain EXIT

# Restart the service and wait for this build to answer. Returns the health result.
restart_and_check() { # restart_and_check [--any-protocol]
  "$SYSTEMCTL" reset-failed "$SERVICE" >/dev/null 2>&1 || true # a crash loop that hit its start limit must not block this restart
  "$SYSTEMCTL" restart "$SERVICE" || return 1
  DRAINED=0 # a restart clears the drain
  ctl health --timeout "$HEALTH_TIMEOUT" "$@"
}

# Put the previous release back (only if there is one) and bring it up.
roll_back() {
  [ -L "$OPT/previous" ] || { say "there is no previous release to roll back to"; return 1; }
  "$HERE/install.sh" --rollback || return 1
  restart_and_check --any-protocol # the old build speaks its own protocol version, not this tarball's
}

was_active=0
"$SYSTEMCTL" is-active --quiet "$SERVICE" && was_active=1

# ───────────────────────────── 1. idle gate (nothing on disk has changed yet) ─────────────────────────────

if [ "$was_active" = 1 ]; then
  if [ "$FORCE" = 1 ]; then
    say "FORCE: skipping the idle gate. Running turns and sign-ins WILL be cut off by the restart."
  else
    set +e
    ctl acquire --total "$MAX_WAIT" --strict-ttl "$STRICT_TTL"
    rc=$?
    set -e
    case "$rc" in
      0) DRAINED=1 ;;
      75)
        say "NOT DEPLOYED: the host was not idle within ${MAX_WAIT}s. Nothing was changed or restarted; run the deploy again later."
        exit 75
        ;;
      76)
        say "NOT DEPLOYED: the running host predates the drain protocol, so it cannot be told to wait for idle. Nothing was changed. A person must do the one-time bootstrap: run this deploy with --force from a Session Manager shell, when nobody is using the worker."
        exit 76
        ;;
      *) die "the idle gate failed (exit $rc); nothing was changed or restarted" 22 ;;
    esac
  fi
fi

# ───────────────────────────── 2. install (the host is drained, or was not running) ─────────────────────────────

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
  if [ "$rc" = 3 ]; then
    say "NOT installed: /etc/aw-login-host/bridge-url is missing or invalid"
    exit 3
  fi
  die "install failed (exit $rc); the running host, if any, was not restarted" 22
fi

# Nothing changed (same build, certificates and settings): nothing a restart would change, so the least disruptive deploy is none.
if [ "$was_active" = 1 ] && [ "$FORCE" != 1 ] && [ -n "$active_before" ] && [ "$(readlink "$OPT/current" 2>/dev/null || true)" = "$active_before" ]; then
  record_deployed
  say "OK   this exact build and configuration is already running: nothing to restart"
  exit 0
fi

# ───────────────────────────── a host that is not running has nobody to protect ─────────────────────────────

if [ "$was_active" = 0 ]; then
  say "the service was not running: starting it"
  if restart_and_check; then
    record_deployed
    say "OK   deployed (first start)"
    exit 0
  fi
  say "the new build did not come up healthy"
  if roll_back; then say "rolled back; the previous build is serving"; exit 1; fi
  say "DOWN: the service is not healthy and there was nothing healthy to go back to"
  exit 2
fi

# ───────────────────────────── 3 + 4. restart and check ─────────────────────────────

if restart_and_check; then
  record_deployed
  say "OK   deployed; $(ctl info 2>/dev/null || echo 'host.info unavailable')"
  exit 0
fi

# ───────────────────────────── 5. bad build: back to the previous one ─────────────────────────────

say "the new build is NOT healthy: rolling back"
if roll_back; then
  say "ROLLED BACK: the previous build is serving again. This deploy FAILED; look at the host's journal for the cause."
  exit 1
fi
say "DOWN: the new build is unhealthy and the rollback did not come up either. Page someone."
exit 2
