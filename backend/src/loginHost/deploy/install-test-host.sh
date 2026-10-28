#!/bin/bash
# TEST INSTANCE ONLY (not production): installs the login host for env test1 from /tmp/aw-install (idempotent). Run as root.
# Expects: start.js, hostLiveAuth.js, claude-turn.sh, aw-net.sh, aw-write-file.sh, aw-relay-shim.js, aw-login-host@.service (esbuild bundles of src/loginHost/host/start.ts and __tests__/live/hostLiveAuth.ts), node 22 at /opt/aw-live, pinned claude at /opt/aw-claude/2.1.294/claude.
set -euo pipefail
D=/opt/aw-login-host
NODE_TARGET=/opt/aw-live/node-v22.23.3-linux-x64/bin/node

# The host refuses to start if a path it hands to a customer unit has a symlink on it, a non-root owner or a group/other-writable component, so the config
# must name the REAL node (/usr/bin/node is a link here). And the customer uid must be able to reach and run it: others-execute on the file and on every
# directory above it. Checked FIRST, before anything is installed: a failure must leave the previous release (start.js and test1.json) untouched.
#   install-test-host.sh --check-node-only <path> [owner uid] [stop dir]   runs only this check (tests: owner defaults to root, the walk to /)
check_node_path() { # check_node_path <path> <owner uid> [stop dir]; prints the real path
  local want=$2 stop=${3:-/} real p m
  [ -e "$1" ] || { echo "install-test-host: $1 does not exist (install node 22 there first)" >&2; return 1; }
  real=$(readlink -f "$1") # every link resolved: the config names this path, which therefore has no symlink on it
  p=$real
  while :; do
    [ "$(stat -c %u "$p")" = "$want" ] || { echo "install-test-host: $p is not owned by uid $want (the node tarball may carry another owner: chown -R root:root its directory): the host would refuse to start" >&2; return 1; }
    m=$(stat -c %a "$p")
    [ $(( 0$m & 022 )) = 0 ] || { echo "install-test-host: $p is writable by group or others: the host would refuse to start" >&2; return 1; }
    [ $(( 0$m & 001 )) = 1 ] || { echo "install-test-host: $p is not executable/traversable by others: a customer unit could not run node" >&2; return 1; }
    [ "$p" = / ] || [ "$p" = "$stop" ] && break
    p=$(dirname "$p")
  done
  printf %s "$real"
}
if [ "${1:-}" = --check-node-only ]; then check_node_path "$2" "${3:-0}" "${4:-/}"; exit; fi
NODE_REAL=$(check_node_path "$NODE_TARGET" 0)

mkdir -p $D/dist/loginHost/host /etc/aw-login-host /run/aw-login-host-test1
install -m 0755 -o root -g root /tmp/aw-install/start.js $D/dist/loginHost/host/start.js
install -m 0755 -o root -g root /tmp/aw-install/claude-turn.sh $D/claude-turn.sh
install -m 0755 -o root -g root /tmp/aw-install/aw-write-file.sh $D/aw-write-file.sh
install -m 0755 -o root -g root /tmp/aw-install/aw-net.sh $D/aw-net.sh
install -m 0755 -o root -g root /tmp/aw-install/aw-relay-shim.js $D/aw-relay-shim.js
command -v socat >/dev/null || dnf -y install socat >/dev/null   # the in-sandbox loopback->proxy forwarder (PR 2)
install -m 0644 -o root -g root /tmp/aw-install/hostLiveAuth.js $D/hostLiveAuth.js
install -m 0644 -o root -g root /tmp/aw-install/aw-login-host@.service /etc/systemd/system/aw-login-host@.service
printf 'You are a helpful assistant. Keep answers short.\n' > $D/system-prompt.txt; chmod 0644 $D/system-prompt.txt
chmod 0755 $D /opt/aw-login-host/dist /opt/aw-login-host/dist/loginHost /opt/aw-login-host/dist/loginHost/host
ln -sf "$NODE_TARGET" /usr/bin/node
# retire the throwaway "live" env from the earlier matrix
systemctl stop aw-login-host@live 2>/dev/null || true
umount /var/lib/aw-login-host/live/u 2>/dev/null || true
rm -rf /var/lib/aw-login-host/live /var/lib/aw-login-host/live.img /var/lib/aw-login-host/ranges/live.json
# homes filesystem for test1: fixed-size loop image with user quota, nosuid,nodev
mkdir -p /var/lib/aw-login-host/test1/u
if ! mountpoint -q /var/lib/aw-login-host/test1/u; then
  [ -f /var/lib/aw-login-host/test1.img ] || { truncate -s 500M /var/lib/aw-login-host/test1.img; mkfs.ext4 -q -F /var/lib/aw-login-host/test1.img; }
  mount -o loop,nosuid,nodev,usrquota /var/lib/aw-login-host/test1.img /var/lib/aw-login-host/test1/u
  mount -o remount,nosuid,nodev /var/lib/aw-login-host/test1/u   # the first loop mount drops these flags on AL2023
  quotacheck -cu /var/lib/aw-login-host/test1/u 2>/dev/null || true
  quotaon /var/lib/aw-login-host/test1/u 2>/dev/null || true
  # quotacheck remounts and drops nosuid/nodev on AL2023; the unit's ExecStartPre re-asserts them, do it here too so a manual start matches
  mount -o remount,nosuid,nodev,usrquota /var/lib/aw-login-host/test1/u
fi
SHA=$(sha256sum /opt/aw-claude/2.1.294/claude | cut -d' ' -f1)
cat > /etc/aw-login-host/test1.json <<CFG
{
  "env": "test1", "uidMin": 420000, "uidMax": 430000,
  "socket": { "dir": "/run/aw-login-host-test1", "gid": 1000 },
  "limits": { "memoryMax": "1G", "tasksMax": 256, "tmpSize": "128M", "shmSize": "64M", "runtimeMaxSec": 1800 },
  "quota": { "blocksKb": 102400, "inodes": 10000 },
  "egress": { "allow": ["api.anthropic.com:443", "platform.claude.com:443", "console.anthropic.com:443", "claude.ai:443"] },
  "claude": { "binaryPath": "/opt/aw-claude/2.1.294/claude", "expectedSha256": "$SHA", "version": "2.1.294",
              "systemPromptFile": "/opt/aw-login-host/system-prompt.txt", "bridgeUrl": "http://127.0.0.1:3991/mcp",
              "relayShimPath": "/opt/aw-login-host/aw-relay-shim.js", "nodePath": "$NODE_REAL" }
}
CFG
chmod 0600 /etc/aw-login-host/test1.json; chown root:root /etc/aw-login-host /etc/aw-login-host/test1.json; chmod 0755 /etc/aw-login-host
systemctl daemon-reload
systemctl enable aw-login-host@test1 >/dev/null 2>&1 || true
systemctl restart aw-login-host@test1
sleep 3
systemctl is-active aw-login-host@test1
journalctl -u aw-login-host@test1 -n 8 --no-pager | cut -c1-200
ls -la /run/aw-login-host-test1
