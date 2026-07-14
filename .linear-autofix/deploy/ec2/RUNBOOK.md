# EC2 deployment runbook — Linear → Claude auto-fix poller

Stands up a dedicated EC2 box that polls Linear for `Bug` issues and, per bug, runs
Claude Code to fix it, opens draft PR(s), verifies the fix in a real browser, and
comments back. **Scope: full (poller + browser-verify). Auth: your Claude subscription.
Schedule: cron every 5 min.**

> **ToS reminder.** This drives your Claude subscription quota from a cloud server,
> unattended. Anthropic's subscription terms are meant for use on your own local
> machine — running it on EC2 is a gray area and risks account action. You chose to
> accept that. If it ever becomes a problem, the compliant alternative is an
> `ANTHROPIC_API_KEY` on the box (per-token cost); the tool picks it up automatically
> from the environment with no code change.

Artifacts in this folder:
- `provision.sh` — run on your **laptop**; launches the instance.
- `bootstrap.sh` — run on the **instance**; installs everything + clones repos.

---

## 0. Prerequisites (on your laptop)

1. **Push the tooling branch** so the instance can clone it:
   ```bash
   git push -u origin harshit/linear-autofix
   ```
   (Or merge it to `main` and set `AUTOFIX_BRANCH=main` when bootstrapping.)
2. **AWS CLI configured** with a profile that can create EC2/SG/key pairs **and**
   `iam:PassRole` for `agentweb-test-env-ec2-role` (you already have this if you use
   `test-env.sh launch`).
3. **Backend creds/secrets are handled for you** by reusing the cloud test-env instance
   profile. `provision.sh` attaches `agentweb-test-env-profile` by default, which grants
   the box `Dev-AW-*` DynamoDB read/write and Secrets Manager read on `agentweb/test-env/*`.
   Bootstrap then pulls `backend/.env` from `agentweb/test-env/backend-env` via that role —
   exactly how the test-env provisions itself. Nothing to copy by hand. (Override with
   `IAM_PROFILE=<name>`, or `IAM_PROFILE=` to attach none and manage creds yourself.)

## 1. Provision the instance (laptop)

```bash
# defaults: us-west-2, t3.xlarge, 100 GB gp3, SSH-only, key pair "linear-autofix",
# IAM profile "agentweb-test-env-profile" (dev DynamoDB + Secrets Manager access)
REGION=us-west-2 bash .linear-autofix/deploy/ec2/provision.sh
```
Note the printed **Public IP** and SSH command. (Only SSH is opened. The automated
browser-verify runs Playwright on the box over loopback, so no app port is exposed.
Re-run with `OPEN_PREVIEW_PORT=true` only if you want to manually browse previews.)

## 2. Bootstrap the instance

```bash
scp -i ~/.ssh/linear-autofix.pem .linear-autofix/deploy/ec2/bootstrap.sh ec2-user@<IP>:~
ssh -i ~/.ssh/linear-autofix.pem ec2-user@<IP>
# on the instance:
bash ~/bootstrap.sh
```
On the **first** run it installs tools, then stops and asks you to authenticate GitHub:
```bash
gh auth login          # GitHub.com > HTTPS > browser/device; grant repo (write) on BOTH repos
gh auth setup-git
bash ~/bootstrap.sh    # second run: clones both repos, installs Chromium + src deps, scaffolds .env
```

## 3. Subscription login for the `claude` CLI

`claude`'s OAuth callback goes to `http://localhost:<port>`, which a headless box can't
open. Tunnel that port back to your laptop:

```bash
# from your LAPTOP — forward the login callback port through SSH, then log in on the box
ssh -i ~/.ssh/linear-autofix.pem -L 45455:localhost:45455 ec2-user@<IP>
# now, on the instance:
claude
#   > /login
#   open the printed URL in your LAPTOP browser, approve; the callback tunnels back.
#   confirm you're on your subscription (not API) with: /status
```
Alternative: authenticate `claude` on your laptop, then copy `~/.claude/.credentials.json`
up to the same path on the instance (may need periodic re-auth).

## 4. Linear API key

```bash
# on the instance
$EDITOR ~/agentweb/.linear-autofix/.env      # set LINEAR_API_KEY=lin_api_...
```
Review `~/agentweb/.linear-autofix/config.mjs` — `bugLabel`, optional `teamKey`, and the
`inProgressState` / `reviewState` names must match your Linear workspace.

## 5. App creds for browser-verify (mostly automatic)

The verify step boots backend + both portals from each bug's worktree; `preview.mjs`
copies `.env` / `.env.local` / `.env.development` from the **source repos** into the
worktree and forces `NODE_ENV=development`. Thanks to §0/§2:
- **`backend/.env`** was already pulled from Secrets Manager (`agentweb/test-env/backend-env`)
  by `bootstrap.sh` — confirm it exists: `test -s ~/agentweb/backend/.env`.
- **Dev DynamoDB + Secrets Manager** access comes from the **instance role**, so the
  backend `.env` needs no AWS keys (and shouldn't have them — env keys would override the
  role). This is the same mechanism the cloud test-env uses.

Verify test creds live in `config.mjs > verify` (`test@example.com` / `Test123!` by default).

> **Parity caveat.** The test-env role grants Secrets Manager read on `agentweb/test-env/*`
> only — **not** on the `dev/AgentWeb/*` secrets the backend fetches at runtime for some
> features (image gen, LinkedIn, BaseHub/Webflow, Vertex models). Those features behave in
> the preview exactly as they do in the test-env (they may be unavailable). Core flows
> (auth, tasks, chat, most UI) work fine. If a specific bug's verify needs one of those
> secrets, add it to the role's policy or set the key directly in `backend/.env`.
>
> **Frontend `.env.local`:** the customer/partner portals aren't stored as secrets. If a
> verify needs a specific `VITE_*` value, drop a `~/agentweb/customer-portal/.env.local`
> (and/or `partner-portal/.env.local`) on the box; `preview.mjs` copies it into the worktree.

## 6. Test ONE bug by hand (do this before enabling cron)

```bash
cd ~/agentweb
set -a; . .linear-autofix/.env; set +a
node .linear-autofix/autofix.mjs <ISSUE-ID> --dry-run   # preview: workspace, repos, model, branch
xvfb-run -a node .linear-autofix/autofix.mjs <ISSUE-ID> # real run; xvfb-run gives the verify browser a display
```
Watch it assemble the workspace → fix → open draft PR(s) → run browser-verify → comment
back. If verify errors with "browser not found", run `npx -y playwright install chromium`.

## 7. Enable the poller (cron, every 5 min)

`@playwright/mcp` launches a **headed** Chromium, so the cron command runs under
`xvfb-run` to supply a virtual display. Install into **ec2-user's** crontab:

```bash
crontab -e
```
```cron
PATH=/usr/local/bin:/usr/bin:/bin
*/5 * * * * xvfb-run -a /usr/bin/env bash /home/ec2-user/agentweb/.linear-autofix/run.sh
```
`run.sh` loads `.env`, holds a `flock` so cycles never overlap, runs the poll, then
`gc.mjs` (reclaims worktrees whose Linear issue reached Done/Canceled).

## 7b. Live previews (`config.keepPreviewUp`)

`keepPreviewUp: true` (default) leaves each fixed bug's full preview **running** after
verify instead of tearing it down, so its URLs stay live and the PR/Linear comment links
them. The **port picks the portal, the bug-id host picks the bug**:

```
partner  portal : http://<id>.<ip>.nip.io:5173/
customer portal : http://<id>.<ip>.nip.io:5174/
backend  API    : http://<id>.<ip>.nip.io:3001/
```
Many bugs coexist because the host differentiates them (`config.previewPorts`). `gc.mjs`
stops a preview when its issue reaches Done/Canceled.

Two things to know on EC2:
- **Reachability:** the URLs use `PREVIEW_IP` (loopback by default → only works on the box).
  To open them from your **laptop**, run the poller with `PREVIEW_IP=<instance-public-ip>`
  and open the three ports (`OPEN_PREVIEW_PORT=true` at provision, or
  `allow-ip.sh <your-ip> OPEN_PREVIEW_PORT=true`). Add `PREVIEW_IP=...` to `.linear-autofix/.env`.
- **Memory:** each kept bug holds ~1–1.5 GB (backend + 2 dev servers) and they accumulate
  across open bugs — watch `free -m` / `df -h`; t3.xlarge comfortably holds several. Set
  `config.keepPreviewUp: false` to go back to tear-down-after-verify, or bring individual
  ones down with `node .linear-autofix/preview/preview.mjs down <ID>`.

### Being sure a kept URL is reachable from your machine

Three open ports (`5173` partner, `5174` customer, `3001` API) do it: the proxy binds
`0.0.0.0` on each, rewrites the `Host` header to `localhost` (so Vite doesn't reject it),
routes by bug-id host, and injects `VITE_API_URL` = the API URL — so the page **and** its
API calls work. To be sure, make these true, in order:

1. **Open the ports to your IP:** `provision.sh` with `OPEN_PREVIEW_PORT=true`, or later
   `bash .linear-autofix/deploy/ec2/allow-ip.sh <your-ip> OPEN_PREVIEW_PORT=true`.
2. **Set `PREVIEW_IP` BEFORE the preview boots.** It's baked into `VITE_API_URL`,
   `CUSTOMER_FRONTEND_URL`, and `routes.json` at `preview up` time — a preview born on
   loopback can't be made public without a down+up. Put it where the poller sees it:
   ```bash
   echo 'PREVIEW_IP=<instance-public-ip>' >> ~/agentweb/.linear-autofix/.env
   ```
   (`run.sh` sources `.env`, so every cron-born preview embeds the public IP.)
3. **Use a stable IP.** A default public IP changes on stop/start, breaking both the SG rules
   and `PREVIEW_IP`. Allocate an **Elastic IP** and associate it if you'll rely on the URLs.

**Prove it** (from your laptop) — layered PASS/FAIL per port, each with the fix if it fails:
```bash
bash .linear-autofix/deploy/ec2/check-reachability.sh <public-ip> <BUG-ID>
```
It probes each port's Host-agnostic `/__preview_health__` (port/SG), nip.io DNS, and each
portal URL — so you know it's reachable before opening a browser. Quick manual check of one
port: `curl http://<public-ip>:5174/__preview_health__` → `preview-proxy-ok`.

## 8. Operations

- **Logs:** `tail -f ~/agentweb/.linear-autofix/poll.log`
- **State:** `~/agentweb/.linear-autofix/state.json` (secondary reprocessing guard).
- **Live previews:** `node .linear-autofix/preview/preview.mjs list` shows what's up.
- **Worktrees / disk:** kept per fixed bug under `~/agentweb/../autofix-worktrees/`
  (i.e. `~/autofix-worktrees/`). `gc.mjs` clears them on issue Done/Canceled; watch
  `df -h` on heavy days. Manual: see the tool README "Testing a fix".
- **Update the tool:** `git -C ~/agentweb pull` (on `harshit/linear-autofix`, or `main`
  after merge). Re-run `bootstrap.sh` to refresh deps.
- **Pause:** comment out the crontab line (`crontab -e`).
- **Cost:** every fix + verify draws on the same subscription quota pool as your own
  interactive Claude use. Default model is Sonnet; an `opus`/`hard`/`complex` label on
  an issue switches that one to Opus.

## 9. Granting access to other users

The security group only allows the **provisioner's** IP on port 22 (and your IP changes
break your own access too). Access is two independent things — do both:

**A. Unblock their IP** (network) — `allow-ip.sh` in this folder, run by anyone with AWS
access to the account+region:
```bash
bash .linear-autofix/deploy/ec2/allow-ip.sh 203.0.113.7          # allow a teammate's IP
bash .linear-autofix/deploy/ec2/allow-ip.sh                       # allow your own current IP (e.g. after it changed)
bash .linear-autofix/deploy/ec2/allow-ip.sh 203.0.113.7 --revoke  # remove it later
```
The teammate finds their IP with `curl -s https://checkip.amazonaws.com`. (Manual
equivalent: `aws ec2 authorize-security-group-ingress --group-id <SG> --protocol tcp --port 22 --cidr <IP>/32`.)

**B. Give them a credential** (auth) — network access alone won't log them in. Either:
- **Add their public key** (preferred — no shared secret). They send you their
  `id_ed25519.pub`; append it on the instance:
  ```bash
  echo 'ssh-ed25519 AAAA... teammate@host' >> ~ec2-user/.ssh/authorized_keys
  ```
  They then `ssh ec2-user@<IP>` with their own key.
- Or share the `~/.ssh/linear-autofix.pem` (a single shared key — discouraged; can't be
  revoked per-person).

**Better for multiple users — AWS SSM Session Manager (no IPs, no keys).** Attach an
instance profile with `AmazonSSMManagedInstanceCore` (the SSM agent ships on AL2023), and
anyone with IAM access runs `aws ssm start-session --target <instance-id>` — no inbound SG
rule and no SSH key to manage, all access is IAM-scoped and audited. Recommended if more
than one person needs in regularly; then you can keep the SG SSH rule tight or drop it.

## 10. Teardown

```bash
# from your laptop
aws ec2 terminate-instances --region us-west-2 --instance-ids <IID>
aws ec2 delete-security-group --region us-west-2 --group-name linear-autofix-sg   # after termination
```
