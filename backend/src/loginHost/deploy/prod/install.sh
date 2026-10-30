#!/bin/bash
# ENG-2110: PRODUCTION install of the login host on the worker (Amazon Linux 2023, x86_64). Run as root by the SSM document
# AW-LoginHost-Deploy-Signed from the extracted build tarball (this script's own directory holds everything it installs).
#
#   install.sh                          install / update everything (idempotent; safe to re-run; a failure NEVER stops a healthy running host)
#   install.sh --dry-run                run every CHECK, print what would change, change nothing
#   install.sh --prepare                do ONLY the slow, harmless-to-a-running-host part (bridge URL check, data disk, packages, node, pinned claude) and stop.
#                                       deploy.sh runs this BEFORE it waits for an idle host, so downloads never happen while the host refuses customers' work.
#   install.sh --rollback               make the previous release the active one again, with its unit and slice (the caller restarts the service)
#   install.sh --self-test-disk <file>  exercise ONLY the data-disk logic against a loop device made from <file> (blank, then mounted, then remounted)
#
# Steps: data disk -> packages -> node -> pinned claude -> STAGE a release (files, TLS set, config; everything validated) -> SWITCH to it (a few
# atomic renames) -> prune old releases. The service itself is restarted by the SSM document afterwards. Nothing here prints a secret.
#
# Layout on the worker:
#   /opt/aw-login-host/releases/<build>-<stamp>/   files of one release (host bundle, wrapper scripts, prod.json snapshot, MANIFEST, FINGERPRINT)
#   /opt/aw-login-host/current  -> releases/<...>  the active release          /opt/aw-login-host/previous -> the one before (for --rollback)
#   /opt/aw-login-host/dist     -> current/dist    (the systemd unit's ExecStart path)
#   /etc/aw-login-host/tls/<build>-<stamp>/        the TLS set that release uses (server.crt, server.key 0600, ca.crt)
#   /etc/aw-login-host/prod.json                   the active config: a REGULAR file whose paths point into the active release and TLS set
# (The host refuses symlinks anywhere on the path of the files it trusts, so the config, not a symlink, selects the files it reads.)
#
# Exit codes: 0 ok; 1 a step failed (the running host, if any, is untouched); 3 NOT installed because /etc/aw-login-host/bridge-url is missing or invalid.
#
# TODO (egress): the template allows console.anthropic.com:443 and claude.ai:443 besides api.anthropic.com:443 and platform.claude.com:443.
# Prune the two extra hosts once the proxy's logs show they are never used by a real sign-in and turn.
set -euo pipefail
umask 022

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=versions.env
. "$HERE/versions.env"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

DRY=0
SELF_TEST_FILE=""
ROLLBACK=0
PREPARE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --rollback) ROLLBACK=1 ;;
    --prepare) PREPARE=1 ;;
    --self-test-disk)
      shift
      [ "$#" -gt 0 ] || { echo "install: --self-test-disk needs a file" >&2; exit 2; }
      SELF_TEST_FILE=$1
      ;;
    *) echo "install: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

ENV_NAME=prod
DATA_MOUNT=/var/lib/aw-login-host/prod/u
DATA_LABEL=awdata
OPT=/opt/aw-login-host
CONF=/etc/aw-login-host
UNIT_DIR=/etc/systemd/system
SYSTEMCTL=systemctl
LOCK=/run/aw-deploy/install.lock # in a root-only directory (see deploy.sh): a file directly in /run could be opened, and flock-ed, by any local user
SKIP_PREREQS=0
DRY_BASE=/run
OWN=(-o root -g root)
NODE_ROOT=/opt/aw-node # where install.sh puts the pinned node (the config names the real path under it: /usr/bin/node is a symlink)
TRUST_UID=0 TRUST_BOUNDARY=
# Test seam: a copy of these scripts in a scratch directory with a `.aw-test-mode` file next to them may redirect every path and fake the tools.
# The marker is never part of a build tarball, so on the worker none of the AW_* variables below has any effect.
TEST=0
if [ -e "$HERE/.aw-test-mode" ]; then
  TEST=1
  OPT=${AW_OPT:?AW_OPT}; CONF=${AW_CONF:?AW_CONF}; UNIT_DIR=${AW_UNIT_DIR:?AW_UNIT_DIR}; LOCK=${AW_LOCK:?AW_LOCK}
  SYSTEMCTL=${AW_SYSTEMCTL:-systemctl}; SKIP_PREREQS=${AW_SKIP_PREREQS:-0}
  NODE_ROOT=${AW_NODE_ROOT:-/opt/aw-node}; TRUST_UID=$(id -u); TRUST_BOUNDARY=${AW_TRUST_BOUNDARY:-}
  DRY_BASE=${AW_TMP:-${TMPDIR:-/tmp}}
  [ "$(id -u)" = 0 ] || OWN=()
fi

if [ "$TEST" != 1 ] && [ "$(id -u)" != 0 ]; then die "must run as root"; fi
if [ "$TEST" != 1 ]; then mkdir -p "$(dirname "$LOCK")"; chmod 0700 "$(dirname "$LOCK")"; fi
exec 9>"$LOCK"
flock -n 9 || die "another install is running (lock $LOCK)"

# Atomic replace of a file/symlink: ln/cp into a sibling temp name, then rename over the target.
swap_symlink() { # swap_symlink <target-text> <link>
  ln -sfn "$1" "$2.new"
  mv -T "$2.new" "$2"
}

# Put the unit files and the slice that a release carries back as the installed ones (they travel with the release so that code and units always match).
# Releases made by an older installer carry none: then what is installed stays. Returns 0 when something was (re)installed.
restore_units_from() { # restore_units_from <release-dir>
  local rel=$1 u changed=1
  for u in aw-login-host@.service aw-login-host-failed@.service "aw-$ENV_NAME.slice"; do
    [ -f "$rel/$u" ] || continue
    if ! cmp -s "$rel/$u" "$UNIT_DIR/$u" 2>/dev/null; then
      install -m 0644 "${OWN[@]}" "$rel/$u" "$UNIT_DIR/$u.new"
      mv -f "$UNIT_DIR/$u.new" "$UNIT_DIR/$u"
      changed=0
    fi
  done
  return $changed
}

# ───────────────────────────── --self-test-disk ─────────────────────────────

if [ -n "$SELF_TEST_FILE" ]; then
  # Disk logic only, on a loop device, with its own mount point, label and fstab: nothing of the real system is touched.
  # Three passes, because the real world runs it three ways: first install (blank), redeploy (mounted, ours), after a reboot (ours, not mounted).
  [ -f "$SELF_TEST_FILE" ] || die "self-test file $SELF_TEST_FILE does not exist"
  ST_DIR=$(mktemp -d /run/aw-selftest.XXXXXX)
  ST_MP="$ST_DIR/mnt"
  ST_FSTAB="$ST_DIR/fstab"
  printf '# a comment that must survive\nUUID=0000-0000 /boot ext4 defaults 0 2\nUUID=1111-1111 %s ext4 defaults 0 2\n' "$ST_MP" >"$ST_FSTAB"
  ST_DEV=$(losetup --find --show "$SELF_TEST_FILE")
  cleanup_selftest() {
    umount "$ST_MP" 2>/dev/null || true
    losetup -d "$ST_DEV" 2>/dev/null || true
    rm -rf "$ST_DIR"
  }
  trap cleanup_selftest EXIT
  log "self-test pass 1: first install"
  ensure_data_disk "$ST_DEV" "$ST_MP" "awtest" "$ST_FSTAB"
  log "self-test pass 2: redeploy (disk mounted at the mount point)"
  ensure_data_disk "$ST_DEV" "$ST_MP" "awtest" "$ST_FSTAB"
  umount "$ST_MP"
  log "self-test pass 3: after a reboot (ours, not mounted)"
  ensure_data_disk "$ST_DEV" "$ST_MP" "awtest" "$ST_FSTAB"
  grep -c '^LABEL=awtest ' "$ST_FSTAB" | sed 's/^/install: self-test fstab lines for the label: /'
  grep -c "$ST_MP" "$ST_FSTAB" | sed 's/^/install: self-test fstab lines for the mount point: /'
  grep -c '^# a comment that must survive$' "$ST_FSTAB" | sed 's/^/install: self-test unrelated comment kept: /'
  grep -c '^UUID=0000-0000 /boot ' "$ST_FSTAB" | sed 's/^/install: self-test unrelated line kept: /'
  exit 0
fi

# ───────────────────────────── helpers for the release machinery ─────────────────────────────

NODE_BIN=/usr/bin/node
[ "$TEST" != 1 ] || NODE_BIN=${AW_NODE_BIN:-$(command -v node || echo /usr/bin/node)}
# Runs the host's own config parser/trust check. The node is the one the worker already has; on a FIRST install (or a rebuilt worker) there is none yet and /usr/bin/node
# is only linked at the switch, AFTER this check, so the pinned node this script has just installed under /opt/aw-node is used: it is root-owned, sha256-verified, and
# itself checked as a trusted path by the very call that uses it.
check_config() { # check_config <config.json> <check-config.js> [extra check-config.js arguments]
  local nb=$NODE_BIN cfg=$1 js=$2
  shift 2
  [ -x "$nb" ] || nb=${NODE_ROOT:-/opt/aw-node}/v$NODE_VERSION/bin/node
  [ -x "$nb" ] || nb=$(command -v node || true)
  [ -n "$nb" ] && "$nb" "$js" "$cfg" "$@"
}

# A valid install = an active release whose files, config and TLS set are all there.
have_valid_install() {
  [ -L "$OPT/current" ] && [ -f "$OPT/current/dist/loginHost/host/start.js" ] && [ -f "$OPT/current/prod.json" ] \
    && [ -f "$OPT/current/FINGERPRINT" ] && [ -f "$CONF/$ENV_NAME.json" ] && [ -d "$(cat "$OPT/current/TLS_DIR" 2>/dev/null || echo /nonexistent)" ]
}

# ───────────────────────────── --rollback ─────────────────────────────

if [ "$ROLLBACK" = 1 ]; then
  [ -L "$OPT/previous" ] || die "there is no previous release to roll back to"
  prev_target=$(readlink "$OPT/previous")
  prev="$OPT/$prev_target"
  [ -d "$prev" ] && [ -f "$prev/prod.json" ] && [ -f "$prev/dist/loginHost/host/start.js" ] && [ -f "$prev/TLS_DIR" ] && [ -f "$prev/WORKER_IP" ] \
    || die "the previous release $prev_target is incomplete: deploy a known-good build instead"
  prev_tls=$(cat "$prev/TLS_DIR")
  validate_tls_dir "$prev_tls" "$(cat "$prev/WORKER_IP")" || die "the previous release's TLS set is no longer valid (expired or removed): deploy that build again instead of rolling back"
  check_config "$prev/prod.json" "$prev/check-config.js" >/dev/null || die "the previous release's config is no longer accepted"
  cur_target=""
  [ ! -L "$OPT/current" ] || cur_target=$(readlink "$OPT/current")
  doing "roll back: current -> $prev_target"
  if [ "$DRY" != 1 ]; then
    swap_symlink "$prev_target" "$OPT/current"
    install -m 0600 "${OWN[@]}" "$prev/prod.json" "$CONF/$ENV_NAME.json.new"
    mv -f "$CONF/$ENV_NAME.json.new" "$CONF/$ENV_NAME.json"
    [ -z "$cur_target" ] || swap_symlink "$cur_target" "$OPT/previous"
    # the unit files and the slice of THAT release (older releases that did not carry them keep what is installed)
    restore_units_from "$prev" || true
    "$SYSTEMCTL" daemon-reload
    ok "rolled back to $prev_target. Restart the service now: systemctl restart aw-login-host@$ENV_NAME (the deploy document does this)."
  fi
  exit 0
fi

# ───────────────────────────── on any failure: never touch a healthy running host ─────────────────────────────

STAGE_REL=""
STAGE_TLS=""
DRY_TMP=""
cleanup() {
  local rc=$?
  [ -z "$STAGE_REL" ] || rm -rf "$STAGE_REL"
  [ -z "$STAGE_TLS" ] || rm -rf "$STAGE_TLS"
  [ -z "$DRY_TMP" ] || rm -rf "$DRY_TMP"
  if [ "$rc" -ne 0 ] && [ "$DRY" != 1 ]; then
    if have_valid_install; then
      log "the install failed (exit $rc) but a valid previous install exists: it was NOT touched and keeps running" >&2
    elif [ "$PREPARE" = 1 ] || "$SYSTEMCTL" is-active --quiet "aw-login-host@$ENV_NAME"; then
      # --prepare only gets the machine ready, and a host that is RUNNING is never stopped by a failed install (it may be on a layout this check does not know).
      log "the preparation failed (exit $rc, see the lines above); nothing was started or stopped" >&2
    else
      # Nothing valid is installed (a first install that failed): make sure no half-configured host crash-loops.
      "$SYSTEMCTL" disable --now "aw-login-host@$ENV_NAME" >/dev/null 2>&1 || true
      log "NOT STARTED: nothing valid is installed (exit $rc, see the lines above)" >&2
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT

# The bridge URL (decided with the B4 turn path). https only: the worker reaches the backend's tool bridge across the network, through the egress proxy.
BRIDGE_FILE=$CONF/bridge-url
[ "$TEST" != 1 ] || BRIDGE_FILE=${AW_BRIDGE_FILE:-$BRIDGE_FILE}
BRIDGE_URL=""
if [ -f "$BRIDGE_FILE" ]; then BRIDGE_URL=$(head -n1 "$BRIDGE_FILE" | tr -d '\r\n'); fi
if ! [[ "$BRIDGE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]]; then
  if have_valid_install; then
    log "no valid https bridge URL in $BRIDGE_FILE: nothing was changed and the running host keeps running" >&2
  else
    log "NOT INSTALLED: create $BRIDGE_FILE with the backend tool bridge's https URL (one line), then run the deploy again." >&2
  fi
  exit 3
fi

# ───────────────────────────── a. the data disk ─────────────────────────────

if [ "$SKIP_PREREQS" = 1 ]; then
  skip "prerequisites (disk, packages, node, claude): skipped in test mode"
else
  DATA_DEV=""
  if DATA_DEV=$(find_data_disk); then
    ok "data disk candidate: $DATA_DEV"
    ensure_data_disk "$DATA_DEV" "$DATA_MOUNT" "$DATA_LABEL" /etc/fstab
  else
    if [ "$DRY" = 1 ]; then
      fail "no single data disk found here (expected on the worker; a dry run elsewhere will show this)"
    else
      die "cannot identify the data disk"
    fi
  fi

  # ───────────────────────────── b. packages and node ─────────────────────────────

  NEEDED_PKGS=()
  for p in socat quota xz openssl python3 e2fsprogs util-linux; do rpm -q "$p" >/dev/null 2>&1 || NEEDED_PKGS+=("$p"); done
  if [ "${#NEEDED_PKGS[@]}" -eq 0 ]; then
    skip "packages present (socat quota xz openssl python3 e2fsprogs util-linux)"
  else
    doing "dnf install ${NEEDED_PKGS[*]}"
    mut dnf -y install "${NEEDED_PKGS[@]}"
  fi

  NODE_DIR=/opt/aw-node/v$NODE_VERSION
  if [ -x "$NODE_DIR/bin/node" ] && [ "$(sha256sum "$NODE_DIR/bin/node" | cut -d' ' -f1)" = "$NODE_BIN_SHA256" ]; then
    skip "node $NODE_VERSION already installed and verified"
  else
    doing "download node $NODE_VERSION (sha256-pinned) to $NODE_DIR"
    if [ "$DRY" != 1 ]; then
      tmpd=$(mktemp -d /var/tmp/aw-node.XXXXXX)
      curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 900 -o "$tmpd/node.tar.xz" "$NODE_TARBALL_URL"
      [ "$(sha256sum "$tmpd/node.tar.xz" | cut -d' ' -f1)" = "$NODE_TARBALL_SHA256" ] || { rm -rf "$tmpd"; die "node tarball sha256 mismatch"; }
      tar -xJf "$tmpd/node.tar.xz" -C "$tmpd"
      [ "$(sha256sum "$tmpd/node-v$NODE_VERSION-linux-x64/bin/node" | cut -d' ' -f1)" = "$NODE_BIN_SHA256" ] || { rm -rf "$tmpd"; die "node binary sha256 mismatch"; }
      mkdir -p /opt/aw-node
      rm -rf "${NODE_DIR}.new"
      mv "$tmpd/node-v$NODE_VERSION-linux-x64" "${NODE_DIR}.new"
      chown -R root:root "${NODE_DIR}.new"
      rm -rf "$NODE_DIR"
      mv "${NODE_DIR}.new" "$NODE_DIR"
      rm -rf "$tmpd"
      ok "node $NODE_VERSION installed to $NODE_DIR"
    fi
  fi
  # The /usr/bin/node link is what the unit starts and what deploy tooling runs: flipping it is part of the SWITCH, never of --prepare, so a host
  # that keeps running (a deploy that finds it busy gives up) is not left with a different node under its next restart. It happens AFTER the trusted-path check of
  # the rendered config (below): a release the host would refuse to start with must leave the machine exactly as it was ("nothing was changed" is then true).
  NODE_LINK_TARGET="$NODE_DIR/bin/node"
  if [ "$PREPARE" = 1 ]; then skip "/usr/bin/node link: left for the switch phase"; fi

  # ───────────────────────────── c. the pinned claude binary ─────────────────────────────

  CLAUDE_BIN=/opt/aw-claude/$CLAUDE_VERSION/claude
  if [ -f "$CLAUDE_BIN" ] && [ ! -L "$CLAUDE_BIN" ] && [ "$(sha256sum "$CLAUDE_BIN" | cut -d' ' -f1)" = "$CLAUDE_BIN_SHA256" ]; then
    skip "claude $CLAUDE_VERSION already installed and verified"
  else
    doing "download claude $CLAUDE_VERSION from the npm registry (integrity + sha256 pinned)"
    if [ "$DRY" != 1 ]; then
      tmpd=$(mktemp -d /var/tmp/aw-claude.XXXXXX)
      curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 900 -o "$tmpd/claude.tgz" "$CLAUDE_TARBALL_URL"
      got="sha512-$(openssl dgst -sha512 -binary "$tmpd/claude.tgz" | openssl base64 -A)"
      [ "$got" = "$CLAUDE_TARBALL_INTEGRITY" ] || { rm -rf "$tmpd"; die "claude tarball integrity mismatch"; }
      tar -xzf "$tmpd/claude.tgz" -C "$tmpd" package/claude
      [ "$(sha256sum "$tmpd/package/claude" | cut -d' ' -f1)" = "$CLAUDE_BIN_SHA256" ] || { rm -rf "$tmpd"; die "claude binary sha256 mismatch"; }
      install -d -m 0755 "${OWN[@]}" "/opt/aw-claude" "/opt/aw-claude/$CLAUDE_VERSION"
      install -m 0755 "${OWN[@]}" "$tmpd/package/claude" "$CLAUDE_BIN.new"
      mv -f "$CLAUDE_BIN.new" "$CLAUDE_BIN"
      rm -rf "$tmpd"
      ok "claude $CLAUDE_VERSION installed at $CLAUDE_BIN"
    fi
  fi
fi

if [ "$PREPARE" = 1 ]; then
  ok "prepared: the bridge URL, data disk, packages, node and the pinned claude are in place (nothing else was touched)"
  exit 0
fi

# ───────────────────────────── d. stage a release (nothing is switched yet) ─────────────────────────────

[ -f "$HERE/dist/loginHost/host/start.js" ] || die "build is missing dist/loginHost/host/start.js"
[ -f "$HERE/MANIFEST" ] || die "build is missing MANIFEST"

# The worker's own address: from /etc/aw-login-host/worker.env, else the instance metadata (IMDSv2). The TLS server certificate must name it.
resolve_worker_ip() {
  local v=""
  if [ -f "$CONF/worker.env" ]; then v=$(sed -n 's/^WORKER_PRIVATE_IP=//p' "$CONF/worker.env" | head -n1 | tr -d '\r\n'); fi
  if [ -z "$v" ] && [ "$TEST" = 1 ]; then v=${AW_WORKER_IP:-}; fi
  if [ -z "$v" ] && [ "$TEST" != 1 ]; then
    local tok
    tok=$(curl -fsS -m 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null || true)
    [ -z "$tok" ] || v=$(curl -fsS -m 3 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/local-ipv4 2>/dev/null || true)
  fi
  is_private_ipv4 "$v" || die "cannot determine this worker's private IPv4 (got '$v'): set WORKER_PRIVATE_IP=<address> in $CONF/worker.env"
  printf '%s\n' "$v"
}
WORKER_IP=$(resolve_worker_ip)
ok "this worker's address: $WORKER_IP"

STAMP=$(date -u +%Y%m%d%H%M%S)
BUILD_NAME=$(sed -n 's/^name=//p' "$HERE/MANIFEST" | head -n1)
[[ "$BUILD_NAME" =~ ^login-host-[A-Za-z0-9-]+$ ]] || die "the MANIFEST has no valid build name"
REL_ID="$BUILD_NAME-$STAMP"
REL_DIR="$OPT/releases/$REL_ID"
TLS_DIR="$CONF/tls/$REL_ID"

if [ "$DRY" = 1 ]; then
  DRY_TMP=$(mktemp -d "$DRY_BASE/aw-dry.XXXXXX")
  chmod 755 "$DRY_TMP" # the pre-switch check asks whether a customer uid could traverse the path: a private 0700 stage would fail it
  STAGE_TLS_DIR="$DRY_TMP/tls"
  STAGE_REL_DIR="$DRY_TMP/release"
else
  mkdir -p "$OPT/releases" "$CONF/tls"
  chmod 0755 "$OPT" "$OPT/releases" "$CONF" "$CONF/tls" 2>/dev/null || true
  STAGE_TLS="$CONF/tls/.stage-$REL_ID"
  STAGE_REL="$OPT/releases/.stage-$REL_ID"
  STAGE_TLS_DIR=$STAGE_TLS
  STAGE_REL_DIR=$STAGE_REL
fi
mkdir -m 0700 "$STAGE_TLS_DIR"
mkdir -m 0755 "$STAGE_REL_DIR"

# TLS set from Secrets Manager (via the instance role), written ONLY into the private staging directory, then validated as a set.
fetch_tls_set() { # fetch_tls_set <dir>   (every command is checked: no `set -e` inside functions called from `||`)
  local d=$1
  (
    umask 077
    aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$TLS_SECRET_SERVER" --query SecretString --output text >"$d/.server.json" 2>/dev/null
  ) || { log "FAIL could not read secret $TLS_SECRET_SERVER (does this instance's role allow it?)" >&2; return 1; }
  (
    umask 077
    aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$TLS_SECRET_CA" --query SecretString --output text >"$d/.ca.json" 2>/dev/null
  ) || { log "FAIL could not read secret $TLS_SECRET_CA (does this instance's role allow it?)" >&2; return 1; }
  (
    umask 077
    python3 - "$d" <<'PY'
import json, sys
w = sys.argv[1]
s = json.load(open(f"{w}/.server.json"))
c = json.load(open(f"{w}/.ca.json"))
for name, val in (("server.crt", s["cert"]), ("server.key", s["key"]), ("ca.crt", c["cert"])):
    with open(f"{w}/{name}", "w") as f:
        f.write(val if val.endswith("\n") else val + "\n")
PY
  ) || { log "FAIL the TLS secrets do not have the expected JSON shape ({cert,key,ca} / {cert})" >&2; return 1; }
  rm -f "$d/.server.json" "$d/.ca.json" || return 1
  validate_tls_dir "$d" "$WORKER_IP" || return 1
  return 0
}
fetch_tls_set "$STAGE_TLS_DIR" || die "the TLS set could not be staged: nothing was changed"
ok "TLS set read and validated (SAN names $WORKER_IP, key matches, chains to the CA, not expired)"

# Fingerprint of everything that decides what runs: if it equals the active release's, there is nothing to do.
FP=$( {
  # (the MANIFEST minus what differs on every build without changing what runs: name, commit, run number, times, test/lockfile status. Its per-file sha256 list stays.)
  grep -v -E '^(name|git_sha|dirty|allow_dirty|tests|lockfile_check|build_node|commit_time|build_seq)=' "$HERE/MANIFEST"
  cat "$HERE/files/aw-login-host@.service" "$HERE/files/aw-env.slice.template"
  sha256sum "$STAGE_TLS_DIR/server.crt" "$STAGE_TLS_DIR/ca.crt" | cut -d' ' -f1
  printf '%s\n%s\n%s\n' "$BRIDGE_URL" "$WORKER_IP" "$(nproc)"
} | sha256sum | cut -d' ' -f1)
if have_valid_install && [ "$(cat "$OPT/current/FINGERPRINT")" = "$FP" ]; then
  # Re-assert the modes of the active TLS set even though nothing changed (a key that drifted to 0644 would make the host refuse to start).
  if [ "$DRY" != 1 ]; then
    act_tls=$(cat "$OPT/current/TLS_DIR")
    chmod 0644 "$act_tls/server.crt" "$act_tls/ca.crt"
    chmod 0600 "$act_tls/server.key"
    chmod 0755 "$act_tls"
  fi
  # A previous deploy that was killed half-way can leave unit files that do not match the active release: put them right (a no-op when they match).
  if [ "$DRY" != 1 ] && restore_units_from "$OPT/current"; then
    "$SYSTEMCTL" daemon-reload
    log "the installed unit files did not match the active release: restored them"
  fi
  ok "this exact build, TLS set, address and bridge are already active ($(readlink "$OPT/current")): nothing to do"
  exit 0
fi

# The release directory.
ins() { install "${OWN[@]}" "$@"; }
ins -d -m 0755 "$STAGE_REL_DIR/dist" "$STAGE_REL_DIR/dist/loginHost" "$STAGE_REL_DIR/dist/loginHost/host"
ins -m 0644 "$HERE/dist/loginHost/host/start.js" "$STAGE_REL_DIR/dist/loginHost/host/start.js"
ins -m 0755 "$HERE/files/claude-turn.sh" "$STAGE_REL_DIR/claude-turn.sh"
ins -m 0755 "$HERE/files/aw-net.sh" "$STAGE_REL_DIR/aw-net.sh"
ins -m 0755 "$HERE/files/aw-write-file.sh" "$STAGE_REL_DIR/aw-write-file.sh"
ins -m 0755 "$HERE/files/aw-relay-shim.js" "$STAGE_REL_DIR/aw-relay-shim.js"
ins -m 0644 "$HERE/files/system-prompt.txt" "$STAGE_REL_DIR/system-prompt.txt"
ins -m 0644 "$HERE/check-config.js" "$STAGE_REL_DIR/check-config.js"
ins -m 0644 "$HERE/MANIFEST" "$STAGE_REL_DIR/MANIFEST"
printf '%s\n' "$FP" >"$STAGE_REL_DIR/FINGERPRINT"
printf '%s\n' "$TLS_DIR" >"$STAGE_REL_DIR/TLS_DIR"
printf '%s\n' "$WORKER_IP" >"$STAGE_REL_DIR/WORKER_IP"
chmod 0644 "$STAGE_REL_DIR/FINGERPRINT" "$STAGE_REL_DIR/TLS_DIR" "$STAGE_REL_DIR/WORKER_IP"

# The config, with every path pointing into THIS release and ITS TLS set; accepted by the host's own parser before it is used.
cfg_tmp="$STAGE_REL_DIR/prod.json"
python3 - "$HERE/files/host-config.template.json" "$cfg_tmp" "$CLAUDE_BIN_SHA256" "$BRIDGE_URL" "$WORKER_IP" "$REL_DIR" "$TLS_DIR" "$CLAUDE_VERSION" "$NODE_VERSION" <<'PY' || die "could not render the config"
import json, sys
tpl, out, sha, bridge, ip, rel, tls, ver, nodever = sys.argv[1:10]
text = open(tpl).read()
for k, v in (("@@CLAUDE_BIN_SHA256@@", sha), ("@@BRIDGE_URL@@", bridge), ("@@WORKER_IP@@", ip), ("@@RELEASE_DIR@@", rel), ("@@TLS_DIR@@", tls), ("@@CLAUDE_VERSION@@", ver), ("@@NODE_VERSION@@", nodever)):
    text = text.replace(k, v)
if "@@" in text:
    raise SystemExit("an unfilled placeholder is left in the config")
json.loads(text)  # must stay valid JSON
open(out, "w").write(text)
PY
chmod 0600 "$cfg_tmp"
check_config "$cfg_tmp" "$HERE/check-config.js" >/dev/null || die "the generated config is rejected by the host's own schema (or there is no node to check it with): nothing was changed"
ok "generated config accepted by the host's parser"
# The host refuses to start when a path it hands to a customer unit has a symlink on it, a non-root owner or a group/other-writable component. Run that same check
# NOW, on the staged files (the release and TLS set are not at their final paths yet) and the pinned node, so a config the host would refuse at start-up never gets
# switched to: this is the step that catches a symlinked node path or a shim that is not root-owned.
if trust_out=$(check_config "$cfg_tmp" "$HERE/check-config.js" --owner "$TRUST_UID" ${TRUST_BOUNDARY:+--boundary "$TRUST_BOUNDARY"} --map "$REL_DIR=$STAGE_REL_DIR" --map "$TLS_DIR=$STAGE_TLS_DIR" --map "/opt/aw-node=$NODE_ROOT" 2>&1); then
  ok "every release path the host will check is root-controlled (no symlink, owner, write bits)"
elif [ "$DRY" = 1 ] && [ ! -e "$NODE_ROOT/v$NODE_VERSION/bin/node" ]; then
  # A dry run on a worker that does not have the pinned node yet (a real install downloads it first): that is not a problem with this release.
  skip "dry run: the pinned node $NODE_VERSION is not installed on this worker yet (a real install puts it in /opt/aw-node first), so the trusted-path check is not run. ${trust_out:-}"
else
  die "the host would refuse to start with this release (trusted-path check): ${trust_out:-no output}. Nothing was changed."
fi

# The slice that caps ALL customer units (values pinned in versions.env; CPU quota leaves ~20% of one vCPU for the host).
CPU_QUOTA="$(( $(nproc) * 100 - 20 ))%"
sed -e "s|@@MEMORY_MAX@@|$SLICE_MEMORY_MAX|" -e "s|@@MEMORY_HIGH@@|$SLICE_MEMORY_HIGH|" -e "s|@@TASKS_MAX@@|$SLICE_TASKS_MAX|" -e "s|@@CPU_QUOTA@@|$CPU_QUOTA|" \
  "$HERE/files/aw-env.slice.template" >"$STAGE_REL_DIR/aw-$ENV_NAME.slice"
grep -q '@@' "$STAGE_REL_DIR/aw-$ENV_NAME.slice" && die "an unfilled placeholder is left in the slice"
chmod 0644 "$STAGE_REL_DIR/aw-$ENV_NAME.slice"
# The unit files travel with the release, so a rollback puts back the unit the previous build was tested with, not only its code.
ins -m 0644 "$HERE/files/aw-login-host@.service" "$STAGE_REL_DIR/aw-login-host@.service"
ins -m 0644 "$HERE/files/aw-login-host-failed@.service" "$STAGE_REL_DIR/aw-login-host-failed@.service"

# Last pre-switch checks on the staged files.
for f in claude-turn.sh aw-net.sh aw-write-file.sh aw-relay-shim.js; do [ -x "$STAGE_REL_DIR/$f" ] || die "staged $f is not executable"; done
[ "$SKIP_PREREQS" = 1 ] || [ -x "/opt/aw-claude/$CLAUDE_VERSION/claude" ] || [ "$DRY" = 1 ] || die "the pinned claude binary is missing"

# The node link (see the packages-and-node step): only now that every check on this release has passed.
if [ -n "${NODE_LINK_TARGET:-}" ] && [ "$PREPARE" != 1 ]; then
  if [ "$(readlink /usr/bin/node 2>/dev/null || true)" = "$NODE_LINK_TARGET" ]; then
    skip "/usr/bin/node already points at node $NODE_VERSION"
  else
    doing "ln -sfn $NODE_LINK_TARGET /usr/bin/node"
    mut ln -sfn "$NODE_LINK_TARGET" /usr/bin/node
  fi
fi

if [ "$DRY" = 1 ]; then
  if [ "$FAILED" -gt 0 ]; then
    log "dry run finished: $FAILED check(s) would FAIL on this machine"
    exit 1
  fi
  log "dry run finished: every check passes; a real run would install release $REL_ID"
  exit 0
fi

# ───────────────────────────── e. SWITCH (everything above is validated; a few atomic renames) ─────────────────────────────

# Make the staged directories final. Renames are atomic and nothing refers to the new names yet.
chmod 0755 "$STAGE_TLS_DIR"
chmod 0644 "$STAGE_TLS_DIR/server.crt" "$STAGE_TLS_DIR/ca.crt"
chmod 0600 "$STAGE_TLS_DIR/server.key"
[ "${#OWN[@]}" -eq 0 ] || chown -R root:root "$STAGE_TLS_DIR" "$STAGE_REL_DIR"
mv -T "$STAGE_TLS_DIR" "$TLS_DIR"
STAGE_TLS=""
mv -T "$STAGE_REL_DIR" "$REL_DIR"
STAGE_REL=""

PREV_TARGET=""
[ ! -L "$OPT/current" ] || PREV_TARGET=$(readlink "$OPT/current")

# The unit and the slice (global, tiny, written atomically), then the active release, the dist path the unit uses, and the config.
ins -m 0644 "$HERE/files/aw-login-host@.service" "$UNIT_DIR/aw-login-host@.service.new"
mv -f "$UNIT_DIR/aw-login-host@.service.new" "$UNIT_DIR/aw-login-host@.service"
ins -m 0644 "$HERE/files/aw-login-host-failed@.service" "$UNIT_DIR/aw-login-host-failed@.service.new"
mv -f "$UNIT_DIR/aw-login-host-failed@.service.new" "$UNIT_DIR/aw-login-host-failed@.service"
ins -m 0644 "$REL_DIR/aw-$ENV_NAME.slice" "$UNIT_DIR/aw-$ENV_NAME.slice.new"
mv -f "$UNIT_DIR/aw-$ENV_NAME.slice.new" "$UNIT_DIR/aw-$ENV_NAME.slice"

swap_symlink "releases/$REL_ID" "$OPT/current"
ins -m 0600 "$REL_DIR/prod.json" "$CONF/$ENV_NAME.json.new"
mv -f "$CONF/$ENV_NAME.json.new" "$CONF/$ENV_NAME.json"
# (the two renames above are the whole switch: the host reads its files only when it starts, and the caller restarts it afterwards)
if [ -d "$OPT/dist" ] && [ ! -L "$OPT/dist" ]; then mv "$OPT/dist" "$OPT/dist.legacy-$STAMP"; fi # an earlier layout kept the files here directly
if [ "$(readlink "$OPT/dist" 2>/dev/null || true)" != "current/dist" ]; then swap_symlink "current/dist" "$OPT/dist"; fi
[ -z "$PREV_TARGET" ] || [ "$PREV_TARGET" = "releases/$REL_ID" ] || swap_symlink "$PREV_TARGET" "$OPT/previous"

"$SYSTEMCTL" daemon-reload
"$SYSTEMCTL" enable "aw-login-host@$ENV_NAME" >/dev/null 2>&1 || true
ok "release $REL_ID is active (previous: ${PREV_TARGET:-none}); aw-login-host@$ENV_NAME enabled (the deploy document restarts it)"

# ───────────────────────────── f. prune old releases (never the active or the previous one) ─────────────────────────────

keep_a=$(readlink "$OPT/current" 2>/dev/null | sed 's|^releases/||' || true)
keep_b=$(readlink "$OPT/previous" 2>/dev/null | sed 's|^releases/||' || true)
n=0
while read -r _t name; do
  n=$((n + 1))
  [ "$n" -gt "$RELEASES_KEEP" ] || continue
  [ "$name" != "$keep_a" ] && [ "$name" != "$keep_b" ] || continue
  rm -rf "${OPT:?}/releases/$name" "${CONF:?}/tls/$name"
  log "pruned old release $name"
done < <(find "$OPT/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.stage-*' -printf '%T@ %f\n' | sort -rn)
# Leftovers of an install that was killed half-way (they can hold a TLS key): staging directories older than a day.
for d in "$OPT/releases" "$CONF/tls"; do
  [ -d "$d" ] || continue
  while IFS= read -r stale; do
    rm -rf "${stale:?}"
  done < <(find "$d" -mindepth 1 -maxdepth 1 -type d -name '.stage-*' -mtime +0 2>/dev/null)
done

exit 0
