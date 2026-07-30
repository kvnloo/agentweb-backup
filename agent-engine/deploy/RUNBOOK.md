# Agent Engine — Production Runbook

`task_monitor.py` fires every customer's scheduled chats and processes pending
task executions. It runs on GCP VM `agentweb-agentengine-instance-prod2`
(project `agent-engine-460619`, zone `us-west1-c`) under systemd, as a
dedicated `agentengine` OS user — not tied to any individual's account.

## Provisioning (one-time)

Already done for the current VM; documented here so it's reproducible if the
VM is ever rebuilt.

1. Create the OS user: `sudo useradd -r -m -d /opt/agent-engine -s /bin/bash agentengine`
   (temporary login shell for setup; can be switched to `/usr/sbin/nologin`
   once systemd is the only thing invoking it, since systemd's `ExecStart`
   doesn't need a login shell).
2. Clone the repo as `agentengine`: `git clone https://github.com/AgentWebPro/agentweb.git /opt/agent-engine/agentweb`
   — requires a GitHub credential; see "Secrets" below for
   `agentengine-prod-github-deploy-token`. Never leave the token embedded in
   `origin`'s URL — `git remote set-url origin https://github.com/AgentWebPro/agentweb.git`
   immediately after cloning/pulling.
3. Install miniconda under the user's own home (not a shared system path,
   not `ruiw`'s): `bash Miniconda3-latest-Linux-x86_64.sh -b -p /opt/agent-engine/miniconda`,
   then accept conda's channel ToS non-interactively:
   ```
   conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main
   conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r
   ```
4. `conda env create -f agent-engine/environment.yml`. Known gap: conda's own
   pip-solve step can silently drop some packages (observed with
   `langchain-aws`) when solved alongside the old `browser-use==0.1.48` pin —
   verify with `pip show <package>` after creation, not just "no error shown".
   Follow with `pip install -r agent-engine/requirements.txt` (with deps, not
   `--no-deps`) to pull in the rest and their transitive dependencies
   (`lxml`, etc.) — pip won't downgrade `browser-use` since 0.1.48 already
   satisfies any unpinned sub-dependency requirement from other packages.
5. `playwright install` (downloads Chromium/Firefox/WebKit — no extra
   `install-deps` needed if apt system libraries are already present, which
   they are on this VM from the original `ruiw` setup).
6. Verify before going further:
   ```
   AGENT_ENGINE_ENV=production /opt/agent-engine/miniconda/envs/agent-engine/bin/python -c \
     "import boto3, browser_use, langchain_aws; from browser_use.browser.browser import Browser, BrowserConfig; \
      from google.cloud import secretmanager, discoveryengine, storage; \
      import secrets_manager, aws_utils, task_utils, email_utils, web_agent"
   ```
7. `BROWSER_HEADLESS=false` (the real prod value) needs a working X server.
   Install and start Xvfb if the VM doesn't already have one:
   ```
   sudo apt-get install -y xvfb
   Xvfb :99 -screen 0 1024x768x24 &   # or a systemd unit / cron @reboot if this needs to survive reboots
   ```
   The current VM already has one running on `:99` from before this ticket
   (mechanism undocumented — see the `DISPLAY` note in `agent-engine.service`).
8. Set up the isolated alert-notifier runtime (root-owned, `agentengine`
   read/execute-only — see "Design decisions" in the Monitoring section
   below for why this is separate from the main checkout):
   ```
   sudo mkdir -p /opt/agent-engine-alert
   sudo python3 -m venv /opt/agent-engine-alert/venv
   sudo /opt/agent-engine-alert/venv/bin/pip install google-cloud-secret-manager
   sudo cp agent-engine/deploy/alert_oncall.py /opt/agent-engine-alert/
   sudo chown -R root:root /opt/agent-engine-alert
   sudo chmod -R a+rX,go-w /opt/agent-engine-alert
   ```
9. Install and enable the systemd units:
   ```
   sudo cp agent-engine/deploy/agent-engine.service /etc/systemd/system/
   sudo cp agent-engine/deploy/agent-engine-alert@.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable agent-engine.service
   sudo systemctl start agent-engine.service
   systemctl status agent-engine.service
   ```
   `agent-engine-alert@.service` is a template unit — nothing to `enable`,
   it only runs when `OnFailure=` triggers it.

## browser-use version — do not touch without reading this

`environment.yml` pins `browser-use[memory]==0.1.48`, matching what's
actually running in production and what `web_agent.py`'s imports expect
(`browser_use.browser.browser.Browser`/`BrowserConfig`). A prior attempt
(Jan 2026) to move to `0.8.0` broke those imports (module layout changed
upstream) and was abandoned — but `environment.yml` was left pinned to
`0.8.0` anyway, silently breaking a truly fresh `conda env create` ever
since. If a browser-use upgrade is attempted again, `web_agent.py`'s browser
setup code needs to be migrated to the new API surface first; don't just
bump the version pin.

## Secrets

All agent-engine secrets live in **GCP Secret Manager** (project
`agent-engine-460619`), not AWS Secrets Manager — deliberate, see
"Design decisions" below. Naming: `agentengine-<env>-<name>`, `env` is
`prod` or `dev`.

| Secret ID | Shape | Contents |
|---|---|---|
| `agentengine-prod-aws-credentials` | JSON | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` for a dedicated `aw_agentengine_user` IAM user (DynamoDB/S3/Bedrock only, least-privilege) |
| `agentengine-prod-azure-openai`, `-2`, `-3` | JSON | `apiKey`, `endpoint`, `apiVersion` per Azure OpenAI config slot |
| `agentengine-prod-openai`, `-gemini`, `-google-image`, `-deepseek`, `-pld-deepseek`, `-resend`, `-google-search`, `-runway`, `-reelmind`, `-openai-image`, `-github`, `-jwt-secret`, `-scheduled-chats-service-secret` | plain string | corresponding API key/secret |
| `agentengine-prod-smtp` | JSON | `user`, `pass` |
| `agentengine-prod-github-deploy-token` | JSON | `username`, `token` — GitHub PAT for `git clone`/`pull` of the private `AgentWebPro/agentweb` repo |

Local dev is unaffected: every secret has an env-var-first fallback (see
`secrets_manager.py`) — set the same-named var in `.env` and Secret Manager
is never called.

To rotate a secret: create a new **version** of the existing secret ID
(`gcloud secrets versions add <id> --data-file=-`). No code or deploy change
needed — `secrets_manager.py` always fetches `latest`.

**Known outstanding rotation**: the Azure OpenAI keys are Rui's original,
unrotated keys, just relocated out of plaintext `.env`. Tracked as a
follow-up (comment on ENG-389) — Harsha needs to generate a replacement key
in Azure Portal for `storybook.openai.azure.com`.

### Design decisions (why GCP Secret Manager, not AWS)

The rest of the org's secrets live in AWS Secrets Manager. Agent-engine uses
GCP Secret Manager instead because there is **no GCP↔AWS workload identity
federation for this VM** — the `aws-workload-sa` service account that looked
like it might provide this actually federates the *other* direction (an AWS
role assuming this GCP identity, for the Elastic Beanstalk backend calling
Vertex AI — unrelated to agent-engine). Building real GCP→AWS federation was
explicitly ruled out as bigger, riskier scope than approved for this
hardening effort. The VM's own GCP identity can reach GCP Secret Manager
directly via Application Default Credentials, with a single IAM grant
(`roles/secretmanager.secretAccessor`, conditioned to `agentengine-*` secret
names) — no new trust relationship required. The one AWS-facing exception is
a rotated static IAM key (`agentengine-prod-aws-credentials`), since a GCP
VM has no other way to authenticate to AWS.

## Deploy / update code

```bash
sudo -u agentengine -i
cd /opt/agent-engine/agentweb
# Auth for git pull — see agentengine-prod-github-deploy-token above.
DEPLOY_JSON=$(gcloud secrets versions access latest --secret=agentengine-prod-github-deploy-token --project=agent-engine-460619)
TOKEN=$(echo "$DEPLOY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
USERNAME=$(echo "$DEPLOY_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["username"])')
git remote set-url origin "https://${USERNAME}:${TOKEN}@github.com/AgentWebPro/agentweb.git"
git pull origin main
git remote set-url origin https://github.com/AgentWebPro/agentweb.git   # strip token back out
sudo systemctl restart agent-engine
```

If `environment.yml`/`requirements.txt` changed, re-run the relevant conda/pip
steps from Provisioning before restarting.

## Monitoring / status

```bash
systemctl status agent-engine.service
journalctl -u agent-engine -f
```

`agent-engine.service` deliberately has no `StandardOutput`/`StandardError=append:<path>`
— that path would live inside the `agentengine`-owned checkout, and systemd
opens it as root before dropping privileges, which is a symlink-swap
privilege-escalation path (Greptile finding on the PR). Journal is the only
log surface for this unit; `ruiw`'s pre-hardening setup did use a file
under the checkout (`log/systemd_task_monitor.log`) — that pattern is not
carried forward here.

Two alerting layers:

1. **Task-level** — `email_utils.send_oncall_alert()` emails
   `ONCALL_EMAIL_LIST` (currently `harsha@agentweb.pro`) when a single task
   fails across every configured LLM. Pre-existing mechanism; only the
   recipient was ever wrong (was Rui's personal Gmail — fixed).
2. **Process-level** — systemd's `OnFailure=agent-engine-alert@%N.service`
   fires when `agent-engine.service` exhausts its restart budget
   (`StartLimitBurst=5` within `StartLimitIntervalSec=300`). Emails
   `harsha@agentweb.pro` via the same SMTP secret (`agentengine-prod-smtp`)
   as the task-level alert — one alerting mechanism, not two. Confirmed via
   live recovery incident (2026-07-29) that no process-level alerting
   existed before this ticket at all.

   **Deliberately isolated from the checkout it monitors** (Greptile
   finding on the PR): `agent-engine.service` and the alert unit both run
   as `agentengine`, but the alert script/interpreter live under
   `/opt/agent-engine-alert`, root-owned and read/execute-only for
   `agentengine` — not inside `/opt/agent-engine/agentweb`, which
   `agentengine` owns and can write to. If `agentengine` is ever
   compromised (plausible — it executes browser-automation against
   arbitrary web content), it must not be able to tamper with the one
   thing that reports its own failure. `deploy/alert_oncall.py` is
   deliberately self-contained (does not `import secrets_manager` from the
   main checkout) for the same reason — do not "simplify" that. It also
   explicitly constructs `google.auth.compute_engine.Credentials()` rather
   than letting the GCP client library fall back to its default credential
   resolution, which checks a well-known ADC file under the *invoking
   user's* home directory before the instance metadata server — since this
   runs as `agentengine`, in `agentengine`'s own writable home, a
   compromised `agentengine` could otherwise plant a credentials file there
   to hijack the alert's own Secret Manager access.

   Provisioning steps are in the Provisioning section above (step 8).

## Restart / rollback

**Restart** (after a deploy, or to clear a stuck state):
```bash
sudo systemctl restart agent-engine
```

**Rollback** (new systemd/agentengine setup misbehaves after cutover):
1. `sudo systemctl stop agent-engine`
2. Restart the process under the pre-hardening setup if it's still intact
   (check `ls /home/ruiw/agentweb` hasn't been archived yet — see AC5
   checklist in the ENG-389 plan; the old checkout/`.env` are deliberately
   kept for 48–72h post-cutover specifically for this).
3. If already archived, the fix is forward, not backward: debug the new
   setup directly using the exact steps in this runbook's Monitoring section.

**A note on systemd unit files and backups**: this file did not exist
anywhere in git before ENG-389 — it lived only on the VM. During this work,
overwriting it without first checking `systemctl status agent-engine`
briefly put the *on-disk* definition out of sync with the live process
(the process itself was never affected — `daemon-reload`/`enable` don't
touch an already-running unit). It was recovered byte-for-byte from a GCP
automatic daily disk snapshot (`default-schedule-1`, retained ~14 days per
the snapshots visible under `gcloud compute snapshots list`). Lesson: this
project has automatic daily VM disk snapshots — useful for any future
recovery, and always run `systemctl status <unit>` before overwriting any
`/etc/systemd/system/*.service` file, even one you believe doesn't exist yet.
