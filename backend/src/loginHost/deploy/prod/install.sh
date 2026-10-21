#!/bin/bash
# ENG-2110: PRODUCTION install of the login host on the worker (Amazon Linux 2023, x86_64). Run as root by the SSM document
# AW-LoginHost-Deploy-Prod from the extracted build tarball (this script's own directory holds everything it installs).
#
#   install.sh                          install / update everything (idempotent; safe to re-run)
#   install.sh --dry-run                run every CHECK, print what would change, change nothing
#   install.sh --self-test-disk <file>  exercise ONLY the data-disk logic against a loop device made from <file> (for machines with no spare disk)
#
# Steps: data disk -> packages -> node -> pinned claude -> files -> TLS material -> config -> systemd.
# The service itself is restarted by the SSM document afterwards. Nothing here prints a secret.
#
# TODO (egress): the template allows console.anthropic.com:443 and claude.ai:443 besides api.anthropic.com:443 and platform.claude.com:443.
# Prune the two extra hosts once the proxy's logs show they are never used by a real sign-in and turn.
#
# Exit codes: 0 ok; 1 a step failed; 3 installed but NOT started because /etc/aw-login-host/bridge-url is missing or invalid.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=versions.env
. "$HERE/versions.env"

DRY=0
SELF_TEST_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
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
FAILED=0

log() { printf '%s\n' "install: $*"; }
ok() { log "OK   $*"; }
skip() { log "SKIP $*"; }
doing() { if [ "$DRY" = 1 ]; then log "WOULD $*"; else log "DO   $*"; fi; }
fail() { log "FAIL $*" >&2; FAILED=$((FAILED + 1)); }
die() { log "FATAL $*" >&2; exit 1; }
# Run a mutating command (printed instead of run in --dry-run).
mut() { if [ "$DRY" = 1 ]; then log "  + $*"; else "$@"; fi; }

[ "$(id -u)" = 0 ] || die "must run as root"

# ───────────────────────────── a. the data disk ─────────────────────────────

# Prints the one non-root disk (the data disk). Refuses if there is not exactly one.
find_data_disk() {
  local root_src root_disk d
  root_src=$(findmnt -n -o SOURCE /)
  root_disk=$(lsblk -no PKNAME "$root_src" 2>/dev/null | head -n1 || true)
  [ -n "$root_disk" ] || root_disk=$(basename "$root_src")
  local found=()
  while read -r d; do
    [ "$d" = "$root_disk" ] && continue
    found+=("/dev/$d")
  done < <(lsblk -dno NAME,TYPE | awk '$2 == "disk" { print $1 }')
  [ "${#found[@]}" -eq 1 ] || { log "disks other than the root disk: ${#found[@]} (${found[*]:-none}); expected exactly 1" >&2; return 1; }
  printf '%s\n' "${found[0]}"
}

# classify <device>: prints blank | ours | other. "blank" = no signature of any kind, no partitions, not mounted.
classify_disk() {
  local dev=$1 sigs fstype label parts
  if findmnt -rn -S "$dev" >/dev/null 2>&1; then echo other; return; fi
  parts=$(lsblk -no TYPE "$dev" | awk '$1 == "part"' | wc -l)
  sigs=$(wipefs --no-act --parsable "$dev" 2>/dev/null | grep -v '^#' | wc -l || true)
  if [ "$parts" -eq 0 ] && [ "$sigs" -eq 0 ]; then echo blank; return; fi
  fstype=$(blkid -p -s TYPE -o value "$dev" 2>/dev/null || true)
  label=$(blkid -p -s LABEL -o value "$dev" 2>/dev/null || true)
  if [ "$parts" -eq 0 ] && [ "$fstype" = ext4 ] && [ "$label" = "$2" ]; then echo ours; return; fi
  echo other
}

# ensure_data_disk <device> <mountpoint> <label> <fstab>
ensure_data_disk() {
  local dev=$1 mp=$2 label=$3 fstab=$4 kind opts
  kind=$(classify_disk "$dev" "$label")
  case "$kind" in
    blank)
      doing "data disk $dev is blank: mkfs.ext4 -L $label"
      mut mkfs.ext4 -q -L "$label" "$dev"
      ;;
    ours) skip "data disk $dev already ext4 with label $label" ;;
    *)
      # Never format a disk that holds anything else (or is in use).
      die "data disk $dev is NOT blank and is not ours (a filesystem/partition/signature is present or it is mounted): refusing to touch it"
      ;;
  esac

  # fstab: one line for this mount point, replaced (never duplicated) and written atomically.
  local line="LABEL=$label $mp ext4 defaults,nofail,nosuid,nodev,usrquota 0 2"
  if [ -f "$fstab" ] && grep -qxF "$line" "$fstab" && [ "$(grep -c -E "^LABEL=$label[[:space:]]" "$fstab")" = 1 ]; then
    skip "fstab already has the $label line"
  else
    doing "fstab: set the $label line"
    if [ "$DRY" != 1 ]; then
      local tmp
      tmp=$(mktemp "$fstab.XXXXXX")
      { grep -v -E "^LABEL=$label[[:space:]]" "$fstab" 2>/dev/null || true; printf '%s\n' "$line"; } >"$tmp"
      chmod 0644 "$tmp"
      mv -f "$tmp" "$fstab"
    fi
  fi

  mut mkdir -p "$mp"
  if findmnt -rn "$mp" >/dev/null 2>&1; then
    skip "$mp already mounted"
  else
    doing "mount $dev on $mp"
    # By device, not by LABEL: the label is not unique while two disks (e.g. a self-test copy) carry it.
    mut mount -o defaults,nosuid,nodev,usrquota "$dev" "$mp"
  fi
  if [ "$DRY" != 1 ]; then
    # quotacheck remounts the filesystem read-only and back, which on AL2023 DROPS nosuid/nodev (found live on the test instance, 2026-10-21):
    # do the quota work first and set the full flag set LAST. The host refuses to start without nosuid,nodev,usrquota.
    if [ ! -e "$mp/aquota.user" ]; then
      quotacheck -cu "$mp" >/dev/null 2>&1 || true
    fi
    quotaon "$mp" >/dev/null 2>&1 || true
    mount -o remount,nosuid,nodev,usrquota "$mp"
    opts=$(findmnt -rn -o OPTIONS "$mp")
    for need in nosuid nodev usrquota; do
      case ",$opts," in *",$need,"*) ;; *) die "mount options of $mp lack $need (have: $opts)" ;; esac
    done
    ok "data disk mounted at $mp with nosuid,nodev,usrquota"
  fi
}

if [ -n "$SELF_TEST_FILE" ]; then
  # Disk logic only, on a loop device, with its own mount point, label and fstab: nothing of the real system is touched.
  [ -f "$SELF_TEST_FILE" ] || die "self-test file $SELF_TEST_FILE does not exist"
  ST_DIR=$(mktemp -d /run/aw-selftest.XXXXXX)
  ST_MP="$ST_DIR/mnt"
  ST_FSTAB="$ST_DIR/fstab"
  : >"$ST_FSTAB"
  ST_DEV=$(losetup --find --show "$SELF_TEST_FILE")
  cleanup_selftest() {
    umount "$ST_MP" 2>/dev/null || true
    losetup -d "$ST_DEV" 2>/dev/null || true
    rm -rf "$ST_DIR"
  }
  trap cleanup_selftest EXIT
  ensure_data_disk "$ST_DEV" "$ST_MP" "awtest" "$ST_FSTAB"
  grep -c '^LABEL=awtest ' "$ST_FSTAB" | sed 's/^/install: self-test fstab lines for the label: /'
  exit 0
fi

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
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tmpd/node.tar.xz" "$NODE_TARBALL_URL"
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
if [ "$(readlink /usr/bin/node 2>/dev/null || true)" = "$NODE_DIR/bin/node" ]; then
  skip "/usr/bin/node already points at node $NODE_VERSION"
else
  doing "ln -sfn $NODE_DIR/bin/node /usr/bin/node"
  mut ln -sfn "$NODE_DIR/bin/node" /usr/bin/node
fi

# ───────────────────────────── c. the pinned claude binary ─────────────────────────────

CLAUDE_BIN=/opt/aw-claude/$CLAUDE_VERSION/claude
if [ -f "$CLAUDE_BIN" ] && [ ! -L "$CLAUDE_BIN" ] && [ "$(sha256sum "$CLAUDE_BIN" | cut -d' ' -f1)" = "$CLAUDE_BIN_SHA256" ]; then
  skip "claude $CLAUDE_VERSION already installed and verified"
else
  doing "download claude $CLAUDE_VERSION from the npm registry (integrity + sha256 pinned)"
  if [ "$DRY" != 1 ]; then
    tmpd=$(mktemp -d /var/tmp/aw-claude.XXXXXX)
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tmpd/claude.tgz" "$CLAUDE_TARBALL_URL"
    got="sha512-$(openssl dgst -sha512 -binary "$tmpd/claude.tgz" | openssl base64 -A)"
    [ "$got" = "$CLAUDE_TARBALL_INTEGRITY" ] || { rm -rf "$tmpd"; die "claude tarball integrity mismatch"; }
    tar -xzf "$tmpd/claude.tgz" -C "$tmpd" package/claude
    [ "$(sha256sum "$tmpd/package/claude" | cut -d' ' -f1)" = "$CLAUDE_BIN_SHA256" ] || { rm -rf "$tmpd"; die "claude binary sha256 mismatch"; }
    install -d -m 0755 -o root -g root "/opt/aw-claude" "/opt/aw-claude/$CLAUDE_VERSION"
    install -m 0755 -o root -g root "$tmpd/package/claude" "$CLAUDE_BIN.new"
    mv -f "$CLAUDE_BIN.new" "$CLAUDE_BIN"
    rm -rf "$tmpd"
    ok "claude $CLAUDE_VERSION installed at $CLAUDE_BIN"
  fi
fi

# ───────────────────────────── d. the files of this build ─────────────────────────────

place() { # place <mode> <src> <dst>
  local mode=$1 src=$2 dst=$3
  if [ -f "$dst" ] && cmp -s "$src" "$dst" && [ "$(stat -c %a "$dst")" = "${mode#0}" ] && [ "$(stat -c %U:%G "$dst")" = root:root ]; then
    skip "$dst unchanged"
  else
    doing "install $dst"
    if [ "$DRY" != 1 ]; then
      install -D -m "$mode" -o root -g root "$src" "$dst.new"
      mv -f "$dst.new" "$dst"
    fi
  fi
}

[ -f "$HERE/dist/loginHost/host/start.js" ] || die "build is missing dist/loginHost/host/start.js"
for d in "$OPT" "$OPT/dist" "$OPT/dist/loginHost" "$OPT/dist/loginHost/host" "$CONF" "$CONF/tls"; do
  mut install -d -m 0755 -o root -g root "$d"
done
place 0644 "$HERE/dist/loginHost/host/start.js" "$OPT/dist/loginHost/host/start.js"
place 0755 "$HERE/files/claude-turn.sh" "$OPT/claude-turn.sh"
place 0755 "$HERE/files/aw-net.sh" "$OPT/aw-net.sh"
place 0755 "$HERE/files/aw-write-file.sh" "$OPT/aw-write-file.sh"
place 0644 "$HERE/files/system-prompt.txt" "$OPT/system-prompt.txt"
place 0644 "$HERE/files/aw-login-host@.service" "/etc/systemd/system/aw-login-host@.service"
place 0644 "$HERE/check-config.js" "$OPT/check-config.js"
place 0644 "$HERE/MANIFEST" "$OPT/MANIFEST"

# ───────────────────────────── e. TLS material (from Secrets Manager, via the instance role) ─────────────────────────────

fetch_tls() {
  local work rc=0 old_umask
  old_umask=$(umask)
  work=$(mktemp -d /run/aw-tls.XXXXXX)
  chmod 0700 "$work"
  fetch_tls_in "$work" || rc=$?
  rm -rf "$work"
  umask "$old_umask"
  return "$rc"
}

fetch_tls_in() {
  local work=$1
  # Each step on its own with an explicit check (set -e does not apply inside a subshell used with ||). The secret text goes only into
  # mode-0600 files under the private work directory: never into a variable, an argument or the log.
  umask 077
  aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$TLS_SECRET_SERVER" --query SecretString --output text >"$work/server.json" 2>/dev/null \
    || { fail "could not read secret $TLS_SECRET_SERVER (does this instance's role allow it?)"; return 1; }
  aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$TLS_SECRET_CA" --query SecretString --output text >"$work/ca.json" 2>/dev/null \
    || { fail "could not read secret $TLS_SECRET_CA (does this instance's role allow it?)"; return 1; }
  python3 - "$work" <<'PY' || { fail "the TLS secrets do not have the expected JSON shape ({cert,key,ca} / {cert})"; return 1; }
import json, sys
w = sys.argv[1]
s = json.load(open(f"{w}/server.json"))
c = json.load(open(f"{w}/ca.json"))
for name, val in (("server.crt", s["cert"]), ("server.key", s["key"]), ("ca.crt", c["cert"])):
    with open(f"{w}/{name}", "w") as f:
        f.write(val if val.endswith("\n") else val + "\n")
PY
  rm -f "$work/server.json" "$work/ca.json"
  # Validate BEFORE replacing anything that is in use.
  openssl x509 -in "$work/server.crt" -noout >/dev/null 2>&1 || { fail "server.crt is not a certificate"; return 1; }
  openssl x509 -in "$work/server.crt" -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$WORKER_PRIVATE_IP\b" || { fail "server certificate does not name IP $WORKER_PRIVATE_IP"; return 1; }
  [ "$(openssl x509 -in "$work/server.crt" -noout -pubkey | openssl sha256)" = "$(openssl pkey -in "$work/server.key" -pubout 2>/dev/null | openssl sha256)" ] || { fail "server key does not match the server certificate"; return 1; }
  openssl verify -CAfile "$work/ca.crt" "$work/server.crt" >/dev/null 2>&1 || { fail "server certificate does not chain to the CA secret"; return 1; }
  openssl x509 -in "$work/server.crt" -noout -checkend 0 >/dev/null 2>&1 || { fail "server certificate is expired"; return 1; }
  openssl x509 -in "$work/server.crt" -noout -checkend 2592000 >/dev/null 2>&1 || log "WARN server certificate expires within 30 days: reissue it"
  ok "TLS material read and validated (SAN names $WORKER_PRIVATE_IP, key matches, chains to CA)"
  if [ "$DRY" = 1 ]; then
    return 0
  fi
  local f name mode
  for f in server.crt:0644 server.key:0600 ca.crt:0644; do
    name=${f%%:*}
    mode=${f##*:}
    if [ -f "$CONF/tls/$name" ] && cmp -s "$work/$name" "$CONF/tls/$name"; then
      skip "$CONF/tls/$name unchanged"
    else
      install -m "$mode" -o root -g root "$work/$name" "$CONF/tls/$name.new"
      mv -f "$CONF/tls/$name.new" "$CONF/tls/$name"
      ok "wrote $CONF/tls/$name ($mode)"
    fi
  done
}
fetch_tls || true

# ───────────────────────────── f. config ─────────────────────────────

BRIDGE_FILE=${AW_BRIDGE_FILE:-$CONF/bridge-url}
BRIDGE_URL=""
if [ -f "$BRIDGE_FILE" ]; then
  BRIDGE_URL=$(head -n1 "$BRIDGE_FILE" | tr -d '\r\n')
fi
BRIDGE_OK=0
# https only: the worker reaches the backend's tool bridge across the network, through the egress proxy (CONNECT); no $ % or whitespace.
if [[ "$BRIDGE_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]]; then BRIDGE_OK=1; fi

if [ "$BRIDGE_OK" = 1 ]; then
  doing "write $CONF/prod.json (root 0600)"
  tmpc=$(mktemp /run/aw-config.XXXXXX)
  chmod 0600 "$tmpc"
  python3 - "$HERE/files/host-config.template.json" "$tmpc" "$CLAUDE_BIN_SHA256" "$BRIDGE_URL" <<'PY'
import json, sys
tpl, out, sha, bridge = sys.argv[1:5]
text = open(tpl).read().replace("@@CLAUDE_BIN_SHA256@@", sha).replace("@@BRIDGE_URL@@", bridge)
json.loads(text)  # must stay valid JSON
open(out, "w").write(text)
PY
  # Validate with the host's OWN config parser (bundled as check-config.js) before the file is used. (The dry run uses whatever node is on PATH.)
  NODE_BIN=/usr/bin/node
  [ -x "$NODE_BIN" ] || NODE_BIN=$(command -v node || true)
  if [ -n "$NODE_BIN" ] && "$NODE_BIN" "$HERE/check-config.js" "$tmpc"; then
    ok "generated config accepted by the host's parser"
  else
    rm -f "$tmpc"
    fail "the generated config is rejected by the host's schema (or no node to check it with)"
    tmpc=""
  fi
  if [ -n "$tmpc" ]; then
    if [ "$DRY" = 1 ]; then
      rm -f "$tmpc"
    else
      install -m 0600 -o root -g root "$tmpc" "$CONF/prod.json.new"
      mv -f "$CONF/prod.json.new" "$CONF/prod.json"
      rm -f "$tmpc"
    fi
  fi
else
  fail "no valid https bridge URL in $BRIDGE_FILE (decided with the B4 turn path)"
fi

# ───────────────────────────── g. systemd ─────────────────────────────

if [ "$DRY" != 1 ]; then
  systemctl daemon-reload
  if [ "$FAILED" = 0 ]; then
    systemctl enable "aw-login-host@$ENV_NAME" >/dev/null 2>&1
    ok "aw-login-host@$ENV_NAME enabled (the deploy document restarts it)"
  else
    # Never leave a half-configured host crash-looping: stop it and say exactly why.
    systemctl disable --now "aw-login-host@$ENV_NAME" >/dev/null 2>&1 || true
    if [ "$BRIDGE_OK" != 1 ]; then
      log "NOT STARTED: the host is installed but not configured. Create $BRIDGE_FILE with the backend tool bridge's https URL (one line), then run the deploy again." >&2
      exit 3
    fi
    log "NOT STARTED: $FAILED step(s) failed (see FAIL lines above)" >&2
    exit 1
  fi
fi

if [ "$DRY" = 1 ]; then
  if [ "$FAILED" -gt 0 ]; then
    log "dry run finished: $FAILED check(s) would FAIL on this machine"
    exit 1
  fi
  log "dry run finished: all checks pass"
fi
exit 0
