#!/bin/bash
# TEST INSTANCE ONLY (not production): installs the login host for env test1 from /tmp/aw-install (idempotent). Run as root.
# Expects: start.js, hostLiveAuth.js, claude-turn.sh, aw-net.sh, aw-write-file.sh, aw-login-host@.service (esbuild bundles of src/loginHost/host/start.ts and __tests__/live/hostLiveAuth.ts), node 22 at /opt/aw-live, pinned claude at /opt/aw-claude/2.1.294/claude.
set -euo pipefail
D=/opt/aw-login-host
mkdir -p $D/dist/loginHost/host /etc/aw-login-host /run/aw-login-host-test1
install -m 0755 -o root -g root /tmp/aw-install/start.js $D/dist/loginHost/host/start.js
install -m 0755 -o root -g root /tmp/aw-install/claude-turn.sh $D/claude-turn.sh
install -m 0755 -o root -g root /tmp/aw-install/aw-write-file.sh $D/aw-write-file.sh
install -m 0755 -o root -g root /tmp/aw-install/aw-net.sh $D/aw-net.sh
command -v socat >/dev/null || dnf -y install socat >/dev/null   # the in-sandbox loopback->proxy forwarder (PR 2)
install -m 0644 -o root -g root /tmp/aw-install/hostLiveAuth.js $D/hostLiveAuth.js
install -m 0644 -o root -g root /tmp/aw-install/aw-login-host@.service /etc/systemd/system/aw-login-host@.service
printf 'You are a helpful assistant. Keep answers short.\n' > $D/system-prompt.txt; chmod 0644 $D/system-prompt.txt
chmod 0755 $D /opt/aw-login-host/dist /opt/aw-login-host/dist/loginHost /opt/aw-login-host/dist/loginHost/host
ln -sf /opt/aw-live/node-v22.23.3-linux-x64/bin/node /usr/bin/node
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
              "systemPromptFile": "/opt/aw-login-host/system-prompt.txt", "bridgeUrl": "http://127.0.0.1:3991/mcp" }
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
