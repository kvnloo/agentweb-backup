# Production login worker: build, install, operate (ENG-2114 / B5)

Target: `aw-login-worker-prod` (`i-033394e5467b48e94`, AL2023 x86_64, t3.medium, fixed private IP 172.31.30.50 in `subnet-0c555ef29795582ec`, no SSH: SSM only).
Everything here is DARK: nothing in production talks to the worker until the backend's `eng1816_login_host` setting row exists.

## Build
`backend/scripts/build-login-host.sh [--out DIR]` (default `backend/dist/login-host-builds/`) produces `login-host-<gitsha>.tar.gz` and its `.sha256`.
**The build is the gate.** It refuses to package when
- the gate tests fail (`src/loginHost/__tests__/deploy`, `.../host`, `loginHostMutualTls`): override `--skip-tests` (printed loudly, recorded in the MANIFEST);
- anything under `backend/` is uncommitted: override `--allow-dirty` (recorded, the name gets `-dirty`);
- a package that ends up in the bundle is not the version `package-lock.json` pins (run `npm ci`): same override.
The tarball holds `install.sh`, `lib.sh`, `versions.env`, `MANIFEST` (git sha, test/dirty/lockfile status, esbuild version, sha256 of `package-lock.json`, the
pins, sha256 of every file), `check-config.js` (the host's own config parser), the host bundle and `files/`. It contains nothing machine-specific:
the worker's own private address is read at install time.

## Deploy
**Automatic.** A merge to `main` that changes host CODE (not tests or docs) runs `.github/workflows/login-host-deploy.yml`, once someone has set the repository variable
`LOGIN_HOST_DEPLOY_ENABLED=true` after the one-time setup. Build (the gate; no cloud credentials) -> a separate job checks the build against the commit, signs it with KMS,
uploads it and runs the SSM document `AW-LoginHost-Deploy-Signed` (body: `ssm-run.sh` in this folder). The document verifies the signature before it unpacks anything, then
runs the build's `deploy.sh`:
**prepare** (`install.sh --prepare`: bridge-URL check, data disk, packages, node, the pinned claude download; harmless to a running host, so it happens before any waiting) ->
**wait for an idle moment** (no turn running, nobody mid sign-in; never forced; nothing on disk has changed yet) -> **install** (switch the active release while the host
refuses new work: seconds) -> restart -> health check -> **roll back by itself** (code, config, unit and slice) if unhealthy. A build whose pipeline number (the GitHub run id) is
lower than the last deployed one is refused (no downgrades). No person approves a deploy and nobody else takes part. One-time setup and the residual risk: `../aws/README.md`.

`deploy.sh` exit codes: 0 deployed (or already running: nothing to do) | 75 host stayed busy, or the drain lapsed before the restart: nothing changed (the workflow retries, then asks you
to re-run) | 1 bad build, rolled back | 2 bad build and the rollback failed: the host is DOWN | 3 bridge URL missing | 4 a LOWER build number than the deployed one, refused (the workflow
shows a warning) | 5 no valid build number, refused | 22 aborted before the restart (hold file, lock, prepare/install failed, gate error, any unexpected failure) | 24 unexpected failure
after the restart began | 76 the running host predates the drain protocol (one-time `--force` bootstrap by a person). The document adds 20 (refused: bad signature, name or layout:
a security event) and 21 (could not prepare; nothing ran). `--force` (a person, on a shell, never the pipeline) skips the idle wait for an emergency fix and cuts running turns off.
**Hold switch:** `touch /etc/aw-login-host/hold` makes every deploy stop with 22 before it does anything; remove the file to resume.

**By hand** (break glass, on a Session Manager shell as root): extract a build tarball into a fresh `mktemp -d` and run `./deploy.sh` from it.

**What a customer sees during a deploy:** nothing, normally. Running turns and sign-ins in progress are never interrupted. The host refuses NEW work only for the switch, the restart
and the health check (seconds; the slow downloads happened before). A chat message that starts in that window waits and then runs once (the backend retries "draining" and
"worker not reachable" for up to 40 s); a sign-in started in that window asks the customer to try again. A deploy that finds the host busy for 30 minutes gives up and changes nothing.

## Worker layout (what `install.sh` creates)
```
/opt/aw-login-host/releases/<build>-<stamp>/   one release: dist/, claude-turn.sh, aw-net.sh, aw-write-file.sh, system-prompt.txt, prod.json (snapshot), MANIFEST, FINGERPRINT
/opt/aw-login-host/current  -> releases/...    the active release         /opt/aw-login-host/previous -> the release before (for --rollback)
/opt/aw-login-host/dist     -> current/dist    (the unit's ExecStart path)
/etc/aw-login-host/tls/<build>-<stamp>/        the TLS set that release uses (server.crt 0644, server.key 0600, ca.crt 0644)
/etc/aw-login-host/prod.json                   the active config: a REGULAR file (the host refuses symlinks on trusted paths) whose paths point into the active release and TLS set
/etc/aw-login-host/bridge-url                  the https URL of the backend's tool bridge (decided with the B4 turn path)
/etc/aw-login-host/worker.env                  optional: WORKER_PRIVATE_IP=<address> (otherwise read from the instance metadata)
/etc/systemd/system/aw-login-host@.service, aw-login-host-failed@.service, aw-prod.slice
```
The newest `RELEASES_KEEP` (3) releases and their TLS sets are kept; the active and the previous one are never pruned.

## What `install.sh` does (idempotent; `--dry-run` shows every check; `--rollback`; `--self-test-disk <file>` tests only the disk logic on a loop device)
1. **Data disk**: formats the one non-root disk as ext4 label `awdata` ONLY if it is completely blank (no signature, no partition, not mounted); a disk that is ours
   (ext4, label `awdata`, and if mounted then at exactly `/var/lib/aw-login-host/prod/u` and nowhere else) is left alone, which is what makes the second run
   (redeploy, rollback, certificate rotation) work; anything else is refused (exit 1) and never touched. fstab: exactly one line for the mount point (any other
   line mounting it is replaced after saving `fstab.aw-backup`). Mounted `nosuid,nodev,usrquota`; quotas must be ON (verified with `quotaon -pu`) or the step fails.
2. Packages (`socat quota xz openssl python3 ...`), Node 22.23.3 (official tarball, sha256-pinned) at `/opt/aw-node`, symlinked to `/usr/bin/node`.
3. Claude 2.1.294: the native binary from the npm package `@anthropic-ai/claude-code-linux-x64` (tarball integrity AND binary sha256 verified, fail closed).
4. **Stage a release**: files into `releases/.stage-...`, the TLS set from Secrets Manager into a private 0700 staging dir, validated AS A SET (certificate names this
   worker's address, key matches, chains to the CA, not expired), the config rendered and accepted by the host's own parser, the slice rendered. Nothing live is touched.
5. **Switch**: rename the staging dirs into place, then `current`, then `prod.json` (two atomic renames; the host reads its files only when it starts and the caller
   restarts it afterwards), unit files, `daemon-reload`, `enable`. Then prune.
6. **A failure never stops a healthy host.** Anything that fails before the switch exits non-zero and leaves the running service, the active release and the config
   exactly as they were. Only when NOTHING valid is installed yet (a failed FIRST install) does the script `disable --now` the unit, so nothing crash-loops.
7. Re-running the same build with the same TLS set, address and bridge is a no-op ("nothing to do"), but the active TLS set's file modes are re-applied.

Exit codes: `0` ok; `1` failed (the running host is untouched); `3` NOT installed/updated because `/etc/aw-login-host/bridge-url` is missing or not an https URL.

## Memory ceiling
`aw-prod.slice` caps ALL customer units: `MemoryMax=3G`, `MemoryHigh=2800M` (`versions.env` `SLICE_*`). t3.medium has 4 GiB and no swap.

- **Measured:** the node shim of a relay turn is about 45-50 MiB resident (manifests of 88 KiB to 1 MiB; the size hardly matters).
- **Not measured:** the ~300 MB resident size of one Claude CLI per turn and the ~200 MB per sign-in process are estimates.
- **What the arithmetic gives:** `maxTurnsPerHost` (8) x (300 + 50) MiB = 2800 MiB, which is exactly `MemoryHigh` (2800M) and leaves 272 MiB to `MemoryMax` (3G) (672 MiB without the shim). Two sign-ins at once (~200 MB each) would then exceed `MemoryMax` on a box with no swap. With the shim, 8 turns do NOT fit with headroom on these estimates.
- **To do (live test):** measure the real resident size of a CLI turn; if 8 do not fit, lower `maxTurnsPerHost` (7?) or raise the instance. Neither is changed in this PR.

If you raise `maxTurnsPerHost`, resize the instance AND the slice together.

## Rolling back across the tool relay (protocol 4)
Roll the BACKEND back (or switch its relay off) BEFORE rolling the worker back to a build that speaks protocol 3: a backend that still sends `tools` to a protocol-3 worker gets
`EINVALID` on every relay turn until its protocol re-check (10 minutes) notices the downgrade. Deploy order is the other way round: the worker first, then the backend.

## RUNBOOK
**Where to look first**: `journalctl -u aw-login-host@prod -u 'aw-login-host-failed@*' --since -1h` (shipped to CloudWatch log group `/agentweb/login-host/prod`).

- **Worker down / unreachable.** Customers see: sign-in and reconnect fail with `host_unavailable` (503); running chats get `unknown_outcome` for the turn in flight and
  the next turn fails the same way; disconnect shows `revoking` (the logins are fenced but the wipe waits) until the sweeper completes it after recovery. Check, in
  order: EC2 status checks (auto-recovery is on), `systemctl status aw-login-host@prod`, `findmnt /var/lib/aw-login-host/prod/u` (the host refuses to start without the
  data mount), `df -h`, the security group (8443 from the backend group only), the client/server certificates (below).
- **Host restart loop / gave up.** The unit stops retrying after 5 failed starts in 2 minutes and writes `host_start_failed env=prod` once (CloudWatch metric filter on
  that line). Find the cause in `journalctl -u aw-login-host@prod` (bad config, key mode, missing mount, EADDRNOTAVAIL), fix it, then
  `systemctl reset-failed aw-login-host@prod && systemctl start aw-login-host@prod` (or run the deploy again).
- **Disk full.** Data disk (customer homes, per-customer quota 200 MB): `du -xsh /var/lib/aw-login-host/prod/u/*` to find the offender; a customer's home is wiped by
  disconnecting them. Grow the volume online (`aws ec2 modify-volume`, then `resize2fs`). Root disk: journal and old releases (`RELEASES_KEEP`).
- **Rollback.** `install.sh --rollback` (from any extracted build, or `/opt/aw-login-host/releases/<current>/` does not carry `install.sh`: use the one in the tarball you
  have) re-points `current`, the config and `previous` at the previous release and exits; **restart the service afterwards** (the deploy document does this). It refuses if
  the previous release's TLS set is no longer valid (then deploy that build again instead). The disk, pins and certificates are idempotent, so deploying an older
  tarball also works.
- **Certificate rotation** (server certificate names `172.31.30.50`; both certificates are valid until about **2027-11-22**; `install.sh` warns under 30 days, and nothing
  else watches them yet: put a calendar reminder and a CloudWatch alarm on it). The host reads certificate files ONLY at start, so a rotation needs a restart, which ENDS
  running turns: schedule it. Zero-downtime overlap for a new CA: (1) put old CA + new CA (concatenated PEM) in the `ca` secret and as the backend's CA; deploy the worker
  (it trusts both); (2) refresh the backend's client secret with a certificate from the new CA (the backend picks it up within ~11 minutes); (3) once calls succeed with the
  new client certificate, replace the server certificate/key secret and deploy the worker again; (4) drop the old CA from both. Renaming the client identity
  (`clientCommonNames`): change the worker config/template FIRST to accept both names, then the backend certificate, then remove the old name. Reissue from the
  `ca-signing-key` secret (Yugo).
- **Replacing the instance.** The fixed private IP 172.31.30.50 is tied to the server certificate's SAN: give the replacement the same IP (or issue a new certificate
  naming the new IP and update the `eng1816_login_host` setting row), attach/restore the data volume or accept **"everyone re-signs in"** (below), then run the deploy.
- **Recovery policy: everyone re-signs in.** A refresh token rotates and can only be used once, so a snapshot of the data disk is dead for any customer whose login refreshed
  after it was taken, and the state file (`/var/lib/aw-login-host/prod/state`) lives on the ROOT disk. If the data or root disk is lost, accepted recovery is: every
  affected customer reconnects (their records become `needs reconnect` when the sweeper finds the home lost). Tell customers this up front.
- **Deploy order across a protocol change.** The backend and the worker both deploy automatically on a merge to main, in parallel. Request-shape changes (new/changed request fields or
  routes): deploy the WORKER first, then the backend. Reply-shape changes (new reply fields the backend reads): deploy the BACKEND first. Until there is a version handshake,
  an unknown route answers `EINVALID/route` (never `ENOTFOUND`, which the revoke path reads as "nothing to wipe"), but never ship a backend that needs a route to a worker
  that does not have it yet.
- **A redeploy waits for the host to be idle** (`host.drain`, unix socket only) and then restarts it, so it does not end in-flight turns or sign-ins. Anything that restarts the host
  by other means (`systemctl restart`, a reboot, a crash) still does: start-up stops every customer unit.

## Before the first real start
Create `/etc/aw-login-host/bridge-url` (one line): the **https** URL of the backend's tool bridge as reachable from the worker. It is decided with the B4 turn path.
Without it `install.sh` exits 3 and installs nothing (on a first install) or changes nothing (on a redeploy).

## Maintenance notes
- **Egress allowlist** in `host-config.template.json` still has `console.anthropic.com:443` and `claude.ai:443` besides `api.anthropic.com:443` and `platform.claude.com:443`.
  Prune them once the host journal (`egress_denied` events) shows a real sign-in and turn never use them.
- The CloudWatch agent must ship the units `aw-login-host@*` AND `aw-login-host-failed@*` (the `host_start_failed` line comes from the latter).
