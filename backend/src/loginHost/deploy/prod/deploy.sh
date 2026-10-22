#!/bin/bash
# ENG-2110: the whole worker deploy, run as root by the SSM document from the extracted, signature-verified build tarball. Nothing here needs a person.
#
#   deploy.sh [--max-wait SEC] [--force] [--allow-older]
#
# A deploy must NEVER cut off a customer. Order:
#   1. install.sh      stage + validate + switch the active release (renames only). The RUNNING host is untouched: it holds its bundle and its
#                      config in memory and spawns turns from the release it started with (old releases are kept), so nothing changes for anyone yet.
#   2. idle gate       deployctl acquire: wait until no turn is running and nobody is mid sign-in, then make the host refuse NEW work (the backend
#                      retries it; see runHostTurn). Waits up to --max-wait (default 1800 s). Never forces.
#   3. restart         seconds. Turns that start meanwhile wait and run once the host is back (connection refused is retried, nothing was admitted).
#   4. health          the new build answers with its protocol version and an undrained state within 60 s.
#   5. otherwise       roll back to the previous release, restart it, check it. A bad build is out within about a minute and nobody had to notice.
#
# Exit: 0 deployed | 75 not idle within --max-wait: NOTHING changed, run again later (not a failure) | 1 the build was bad and the previous one is
# serving again | 2 the build was bad AND the rollback failed: the host is DOWN (page someone) | 3 not installed: bridge-url missing (install.sh) |
# 4 REFUSED: this build is older than the one already deployed (a validly signed old build is still a downgrade: see below).
# --force skips the idle gate (an emergency security fix): running turns ARE cut off. It is logged loudly and never the default.
# --allow-older lets a person on a Session Manager shell install an older build on purpose. The SSM document never passes it.
#
# NO DOWNGRADES. The signature proves a build came from our pipeline, not that it is the latest: whoever can write to the build bucket could re-offer an
# old, correctly signed build with a known hole. So the build's commit time (MANIFEST, signed with the tarball) must not be older than the last
# build this worker finished deploying. Going back deliberately is a revert commit (newer time), or --allow-older from a shell.
set -euo pipefail
umask 022

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_NAME=prod
SERVICE="aw-login-host@$ENV_NAME"
SOCK=/run/aw-login-host-prod/host.sock
LOCK=/run/aw-login-host-deploy.lock
SYSTEMCTL=systemctl
NODE=/usr/bin/node
OPT=/opt/aw-login-host
MAX_WAIT=1800
HEALTH_TIMEOUT=60
FORCE=0
ALLOW_OLDER=0
STATE_DIR=/var/lib/aw-login-host

# Test seam (same convention as install.sh): never present in a build tarball, so on the worker none of these has any effect.
if [ -e "$HERE/.aw-test-mode" ]; then
  SYSTEMCTL=${AW_SYSTEMCTL:?AW_SYSTEMCTL}; SOCK=${AW_SOCK:?AW_SOCK}; LOCK=${AW_DEPLOY_LOCK:?AW_DEPLOY_LOCK}; NODE=${AW_NODE:?AW_NODE}; OPT=${AW_OPT:?AW_OPT}
  HEALTH_TIMEOUT=${AW_HEALTH_TIMEOUT:-60}; STATE_DIR=${AW_STATE_DIR:?AW_STATE_DIR}
fi

say() { printf '%s\n' "deploy: $*"; }
die() { say "FATAL $*" >&2; exit 1; }

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

exec 8>"$LOCK"
flock -n 8 || die "another deploy is running (lock $LOCK)"

# ───────────────────────────── no downgrades ─────────────────────────────

build_time=$(sed -n 's/^commit_time=//p' "$HERE/MANIFEST" 2>/dev/null | head -n1 || true)
build_epoch=""
# (GNU date reads an empty string as "today 00:00", so an absent time must be refused before it gets there)
[ -z "$build_time" ] || build_epoch=$(date -u -d "$build_time" +%s 2>/dev/null || true)
case "$build_epoch" in '' | *[!0-9]*) say "REFUSED: this build has no readable commit_time in its MANIFEST"; exit 4 ;; esac
last_epoch=$(cat "$STATE_DIR/deployed-commit-time" 2>/dev/null || echo 0)
case "$last_epoch" in '' | *[!0-9]*) last_epoch=0 ;; esac
if [ "$build_epoch" -lt "$last_epoch" ] && [ "$ALLOW_OLDER" != 1 ]; then
  say "REFUSED: this build ($build_time) is older than the one already deployed. Nothing was changed. (A deliberate step back is a revert commit, or --allow-older from a shell.)"
  exit 4
fi
record_deployed() { # only ever moves forward
  if [ "$build_epoch" -ge "$last_epoch" ]; then
    mkdir -p "$STATE_DIR"
    printf '%s\n' "$build_epoch" >"$STATE_DIR/deployed-commit-time.new"
    mv -f "$STATE_DIR/deployed-commit-time.new" "$STATE_DIR/deployed-commit-time"
  fi
}

ctl() { "$NODE" "$HERE/deployctl.js" "$SOCK" "$@"; }

# Restart the service and wait for this build to answer. Returns the health result.
restart_and_check() { # restart_and_check [--any-protocol]
  "$SYSTEMCTL" reset-failed "$SERVICE" >/dev/null 2>&1 || true # a crash loop that hit its start limit must not block this restart
  "$SYSTEMCTL" restart "$SERVICE" || return 1
  ctl health --timeout "$HEALTH_TIMEOUT" "$@"
}

# Put the previous release back (only if there is one) and bring it up.
roll_back() {
  [ -L "$OPT/previous" ] || { say "there is no previous release to roll back to"; return 1; }
  "$HERE/install.sh" --rollback || return 1
  restart_and_check --any-protocol # the old build speaks its own protocol version, not this tarball's
}

# ───────────────────────────── 1. install (switch the active release; the running host is untouched) ─────────────────────────────

was_active=0
"$SYSTEMCTL" is-active --quiet "$SERVICE" && was_active=1
active_before=$(readlink "$OPT/current" 2>/dev/null || true)

set +e
"$HERE/install.sh"
rc=$?
set -e
if [ "$rc" = 3 ]; then
  say "NOT installed: /etc/aw-login-host/bridge-url is missing or invalid (the service is left as it was)"
  exit 3
fi
[ "$rc" = 0 ] || die "install failed (exit $rc); the running host, if any, was not touched"

# ───────────────────────────── nothing changed: nothing to restart ─────────────────────────────

# install.sh keeps the active release when the build, the certificates and the settings are all identical to it (same fingerprint). Then there is
# nothing a restart would change, and the least disruptive deploy is none.
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

# ───────────────────────────── 2. idle gate ─────────────────────────────

if [ "$FORCE" = 1 ]; then
  say "FORCE: skipping the idle gate. Running turns and sign-ins WILL be cut off by the restart."
else
  set +e
  ctl acquire --total "$MAX_WAIT"
  rc=$?
  set -e
  if [ "$rc" != 0 ]; then
    # Put the old release back as the active one so the files on disk match the host that is still running; nothing else changed.
    if "$HERE/install.sh" --rollback >/dev/null; then say "reverted to the release that is still running"; else say "WARNING: could not revert the active release; the running host is unaffected"; fi
    if [ "$rc" = 75 ]; then
      say "NOT DEPLOYED: the host was not idle within ${MAX_WAIT}s. Nothing was restarted; run the deploy again later."
      exit 75
    fi
    die "the idle gate failed (exit $rc) and nothing was restarted"
  fi
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
