# Production login worker: build and install (ENG-2114 / B5)

Target: `aw-login-worker-prod` (`i-033394e5467b48e94`, AL2023 x86_64, t3.medium, private IP 172.31.30.50). Everything here is DARK: nothing in
production talks to the worker until the backend's `eng1816_login_host` setting row exists.

## Build
`backend/scripts/build-login-host.sh [--out DIR]` (default `backend/dist/login-host-builds/`) produces `login-host-<gitsha>.tar.gz` and its
`.sha256`. Build from a CLEAN, merged commit: a `-dirty` name means uncommitted changes (the build warns). The tarball holds `install.sh`,
`versions.env`, `MANIFEST` (git sha, pins, sha256 of every file), `check-config.js` (the host's own config parser), the host bundle and `files/`.

## Deploy
Upload the tarball to `s3://agentweb-login-host-992382574572/prod/builds/` and run the SSM document `AW-LoginHost-Deploy-Prod` with
`BuildKey` and `Sha256` (it verifies the hash, extracts, runs `install.sh`, restarts `aw-login-host@prod` and checks it is active).
Who may upload and run it is deliberately NOT decided here (Harsha/Yugo: a deploy path is root on the machine that holds customer logins).

## What `install.sh` does (idempotent; `--dry-run` shows every check; `--self-test-disk <file>` tests only the disk logic on a loop device)
1. **Data disk**: formats the one non-root disk as ext4 label `awdata` ONLY if it is completely blank (no signature, no partition, not
   mounted); an already-ours disk is left alone; anything else is refused (exit 1) and never touched. Mounts it at
   `/var/lib/aw-login-host/prod/u` with `nosuid,nodev,usrquota` (quota work first, flags set last: `quotacheck` drops them on AL2023).
2. Packages (`socat quota xz openssl python3 ...`), Node 22.23.3 (official tarball, sha256-pinned) at `/opt/aw-node`, symlinked to `/usr/bin/node`.
3. Claude 2.1.294: the native binary from the npm package `@anthropic-ai/claude-code-linux-x64` (the same package `package-lock.json` pins;
   tarball integrity AND binary sha256 verified, fail closed) at `/opt/aw-claude/2.1.294/claude`.
4. The host files under `/opt/aw-login-host`, the systemd unit.
5. TLS material from Secrets Manager (`prod/AgentWeb/LoginHost/server`, `.../ca`, read through the instance role) into
   `/etc/aw-login-host/tls/`; validated first (names 172.31.30.50, key matches, chains to the CA, not expired).
6. `/etc/aw-login-host/prod.json` from the template, accepted by the host's own parser before use.

## Before the first real start
Create `/etc/aw-login-host/bridge-url` (one line): the **https** URL of the backend's tool bridge as reachable from the worker. It is decided with
the B4 turn path. Without it `install.sh` installs everything, leaves the service **stopped** and exits 3 with a clear message.

## Maintenance
- **Certificates** (issued 2026-10-21, valid 397 days) expire about **2027-11-22**. `install.sh` warns when the server cert has under 30 days left.
  Reissue from the `ca-signing-key` secret (Yugo), redeploy; the backend's client cert in Secrets Manager must be refreshed at the same time.
- **Egress allowlist** in `host-config.template.json` still has `console.anthropic.com:443` and `claude.ai:443` besides `api.anthropic.com:443`
  and `platform.claude.com:443`. Prune them once the host journal (`egress_denied` events; add allow-logging if needed) shows a real sign-in
  and turn never use them.
- **Redeploys restart the host**, which ends in-flight turns (start-up stops every customer unit). Deploy in a quiet moment until a drain mode exists.
- **Rollback**: run an earlier tarball through the same document. Disk, certificates and pins are idempotent.
