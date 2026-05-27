## Cloud Test Environment

Ephemeral test environments can be launched on EC2 for manual testing. All files live in `test-env/`.

Each environment is automatically named from the developer's AWS username and repo folder name (e.g., `myuser-agentweb`). Scripts in each clone can only operate that clone's instance — `agentweb/` and `agentweb1/` are fully isolated.

### Prerequisites (One-Time Admin Setup)

```bash
cd test-env
./setup-infra.sh
```

This creates:
- **Secrets Manager secret** (`agentweb/test-env/backend-env`) — stores backend `.env`
- **IAM role + instance profile** — EC2 can read the secret
- Security groups are created per-instance at launch time, locked to the developer's IP

### Developer IAM Policy

Each developer needs the `AgentWebTestEnvDeveloper` inline policy on their IAM user. See `README.md` → "Cloud Test Environment" → "Developer IAM Policy" for the full policy JSON. The policy uses tag-based conditions so developers can only launch/terminate instances tagged `purpose=test-env` (production instances are protected).

### Ngrok (HTTPS tunnel for webhooks)

The test environment runs an ngrok container that exposes the backend over HTTPS. This is required for any feature that needs an HTTPS callback URL (e.g. Unipile webhooks, OAuth redirects).

Two secrets must exist in AWS Secrets Manager under `agentweb/test-env/backend-env`:

| Variable | Description |
|---|---|
| `NGROK_AUTHTOKEN` | Your personal ngrok auth token — from [dashboard.ngrok.com/get-started/your-authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) |
| `NGROK_DOMAIN` | Your reserved ngrok domain — e.g. `my-name.ngrok-free.app` (free tier supports one static domain) |

Once set, the `BACKEND_URL` in Secrets Manager should point to `https://<NGROK_DOMAIN>` so webhooks hit the ngrok tunnel.

### Developer Setup

On first `launch`, the script interactively creates `.test-env.config` and an EC2 key pair. Or create the config manually in repo root:

```
KEY_NAME=my-keypair
KEY_FILE=~/.ssh/my-keypair.pem
```

### Usage

**CRITICAL:** When a test environment is active (check with `./test-env/test-env.sh list`), you MUST run `./test-env/test-env.sh sync` after EVERY code change to deploy it to the instance. Always sync immediately after making changes — do not wait for the user to ask. Sync the specific service that changed (e.g., `sync backend`, `sync customer-portal`) or `sync` for all. There is no automatic file watcher — sync must be run explicitly after each change.

```bash
# Launch environment (auto-detects your IP and locks access to it)
./test-env/test-env.sh launch

# Sync local code changes and rebuild (run after every code change)
./test-env/test-env.sh sync              # all services
./test-env/test-env.sh sync backend      # just backend

# Grant/revoke access for other people (MUST use IPv4 — see note below)
./test-env/test-env.sh allow-ip 203.0.113.50
./test-env/test-env.sh revoke-ip 203.0.113.50

# View logs
./test-env/test-env.sh logs backend

# SSH into instance
./test-env/test-env.sh ssh

# Check status
./test-env/test-env.sh status

# Show this folder's environment
./test-env/test-env.sh list

# Tear down (also deletes the per-instance security group)
./test-env/test-env.sh teardown
```

### IPv4 Requirement for allow-ip

**CRITICAL:** The EC2 security group only works with IPv4 addresses. When allowing an IP, always force IPv4:

```bash
# CORRECT — force IPv4
./test-env/test-env.sh allow-ip $(curl -4 -s ifconfig.me)

# WRONG — may return IPv6 which won't work with EC2 security groups
./test-env/test-env.sh allow-ip $(curl -s ifconfig.me)
```

`curl ifconfig.me` (without `-4`) can return an IPv6 address on dual-stack networks. IPv6 rules won't grant access to IPv4-only EC2 instances, causing silent connectivity failures (SSH hangs, browser timeouts).

### Cloud-Dev CLAUDE.md

In dev mode, a user-level `~/.claude/CLAUDE.md` is automatically written to the EC2 instance during setup. This file overrides project-level CLAUDE.md instructions that don't apply in the cloud dev context:

- Tells Claude Code it **is** the test environment (no `sync` needed)
- Provides the actual service URLs using the instance's public IP
- Documents service management via `dev-services.sh`
- Notes that services auto-reload on file changes

The template lives at `test-env/cloud-dev-claude.md`. During setup, `PUBLIC_IP` is substituted with the real EC2 public IP. Because the file is at `~/.claude/CLAUDE.md` (outside the repo), `sync` operations won't overwrite it.

### Architecture

- Three Docker containers on one EC2 instance (t3.large)
- **IP-restricted (IPv4 only)** — per-instance security group locked to developer's IP at launch; use `allow-ip`/`revoke-ip` to manage access
- Backend `.env` fetched from Secrets Manager at launch (developers never see it)
- Code synced via `rsync` — only changed files transferred
- Auto-terminates after **24 hours of inactivity** (watchdog cron)
- Per-clone isolation enforced via name-based state files and validation guards
- Ports: backend=3001, partner-portal=5173, customer-portal=5174
