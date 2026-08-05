#!/usr/bin/env bash
# bootstrap.sh — run ON the EC2 instance as ec2-user. Idempotent; safe to re-run.
#
# Installs everything the poller + browser-verify need and clones both repos. The
# interactive auth steps (claude subscription login, Linear key, app/AWS creds) are
# done AFTER this per RUNBOOK.md. gh auth is required BEFORE cloning the private repos,
# so this script stops and tells you to run `gh auth login` on the first pass, then
# finishes the clone + deps on the second pass.
set -euo pipefail

AUTOFIX_BRANCH="${AUTOFIX_BRANCH:-harshit/linear-autofix}"  # branch carrying .linear-autofix/ (set to main after you merge it)
MAIN_REPO="${MAIN_REPO:-https://github.com/AgentWebPro/agentweb.git}"
CP_REPO="${CP_REPO:-https://github.com/AgentWebPro/agentweb-customer-portal.git}"
WORKDIR="${WORKDIR:-$HOME/agentweb}"
INSTALL_SRC_DEPS="${INSTALL_SRC_DEPS:-true}"  # npm install in backend/partner-portal/customer-portal so previews boot fast
BACKEND_ENV_SECRET="${BACKEND_ENV_SECRET:-agentweb/test-env/backend-env}"  # backend .env pulled from Secrets Manager (same secret the cloud test-env uses)
AWS_REGION="${AWS_REGION:-us-west-2}"

echo "==> System packages"
sudo dnf -y update
sudo dnf -y install git tar gzip jq cronie xorg-x11-server-Xvfb dnf-plugins-core

echo "==> Node 20 (NodeSource)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo dnf -y install nodejs
fi
echo "    node $(node -v)"

echo "==> GitHub CLI"
if ! command -v gh >/dev/null 2>&1; then
  sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
  sudo dnf -y install gh
fi

echo "==> Claude Code CLI"
sudo npm install -g @anthropic-ai/claude-code
echo "    $(claude --version 2>/dev/null || echo 'claude installed')"

echo "==> Chromium runtime libs (for @playwright/mcp browser-verify)"
sudo dnf -y install nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm \
  libXcomposite libXdamage libXext libXfixes libXrandr mesa-libgbm libxkbcommon \
  pango cairo alsa-lib libXcursor libXi libXtst gtk3 liberation-fonts || true

echo "==> Enable cron daemon"
sudo systemctl enable --now crond

# ---- gh auth gate: private repos need credentials before we can clone ----
if ! gh auth status >/dev/null 2>&1; then
  cat <<'EOF'

==> STOP: GitHub is not authenticated yet.
    Run these, then re-run this script (it is idempotent):

      gh auth login          # choose GitHub.com > HTTPS > authenticate; needs repo (write) on BOTH repos
      gh auth setup-git      # lets `git push` use your gh credentials

    Confirm write access:
      gh repo view AgentWebPro/agentweb                --json viewerPermission
      gh repo view AgentWebPro/agentweb-customer-portal --json viewerPermission
EOF
  exit 0
fi

echo "==> Clone repos (main on $AUTOFIX_BRANCH; customer-portal nested inside)"
if [ ! -d "$WORKDIR/.git" ]; then
  git clone "$MAIN_REPO" "$WORKDIR"
fi
git -C "$WORKDIR" fetch origin
if ! git -C "$WORKDIR" checkout "$AUTOFIX_BRANCH" 2>/dev/null; then
  echo "!! Branch '$AUTOFIX_BRANCH' not found on origin."
  echo "   Push it first (git push -u origin $AUTOFIX_BRANCH) or set AUTOFIX_BRANCH=main after merge."
  exit 1
fi
git -C "$WORKDIR" pull --ff-only origin "$AUTOFIX_BRANCH" || true

if [ ! -d "$WORKDIR/customer-portal/.git" ]; then
  git clone "$CP_REPO" "$WORKDIR/customer-portal"
fi
git -C "$WORKDIR/customer-portal" checkout main
git -C "$WORKDIR/customer-portal" pull --ff-only origin main || true

echo "==> Playwright Chromium browser (ec2-user cache)"
( cd "$WORKDIR" && npx -y playwright install chromium )

if [ "$INSTALL_SRC_DEPS" = true ]; then
  echo "==> npm install in source repos (lets previews symlink node_modules instead of reinstalling per bug)"
  for d in backend partner-portal customer-portal; do
    if [ -f "$WORKDIR/$d/package.json" ]; then
      echo "    -> $d"
      ( cd "$WORKDIR/$d" && npm install --no-audit --no-fund ) || echo "    WARNING: npm install failed in $d"
    fi
  done
fi

echo "==> Backend .env from Secrets Manager (via the instance role — same secret the test-env uses)"
if [ ! -f "$WORKDIR/backend/.env" ]; then
  if aws --region "$AWS_REGION" secretsmanager get-secret-value \
       --secret-id "$BACKEND_ENV_SECRET" --query SecretString --output text \
       > "$WORKDIR/backend/.env" 2>/dev/null && [ -s "$WORKDIR/backend/.env" ]; then
    grep -q '^NODE_ENV=' "$WORKDIR/backend/.env" \
      && sed -i 's|^NODE_ENV=.*|NODE_ENV=development|' "$WORKDIR/backend/.env" \
      || echo 'NODE_ENV=development' >> "$WORKDIR/backend/.env"
    echo "    Wrote backend/.env from $BACKEND_ENV_SECRET (NODE_ENV=development)."
  else
    rm -f "$WORKDIR/backend/.env"
    echo "    WARNING: could not read secret '$BACKEND_ENV_SECRET'."
    echo "      The instance needs a role granting secretsmanager:GetSecretValue on it"
    echo "      (e.g. provision with IAM_PROFILE=agentweb-test-env-profile), or place"
    echo "      $WORKDIR/backend/.env manually. The browser-verify backend won't boot without it."
  fi
fi

echo "==> Linear env file"
if [ ! -f "$WORKDIR/.linear-autofix/.env" ]; then
  cp "$WORKDIR/.linear-autofix/.env.example" "$WORKDIR/.linear-autofix/.env"
  echo "    Created .linear-autofix/.env — EDIT IT and paste your LINEAR_API_KEY (lin_api_...)."
fi

# ENG-652: durable supervision for the long-running chat + WATCH server via systemd (Restart=on-failure
# for instant crash recovery + WantedBy=multi-user.target for reboot recovery). Idempotent: re-copies the
# unit each run and re-enables it. Cron (run.sh → poll.mjs/gc.mjs) is untouched — this covers ONLY the
# server. `enable --now` starts it immediately AND on every boot. `run-chat.sh ensure` (from cron) detects
# the active unit and drops to a health-only probe, so systemd is the single owner.
echo "==> systemd unit: autofix-chat.service (durable chat/WATCH-server supervision)"
UNIT_SRC="$WORKDIR/.linear-autofix/deploy/ec2/autofix-chat.service"
if [ -f "$UNIT_SRC" ]; then
  # A legacy run-chat.sh-launched server would fight the unit for :8790 — stop it before handing over.
  bash "$WORKDIR/.linear-autofix/chat/run-chat.sh" stop >/dev/null 2>&1 || true
  sudo cp "$UNIT_SRC" /etc/systemd/system/autofix-chat.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now autofix-chat.service
  echo "    autofix-chat.service enabled + started (systemctl status autofix-chat · journalctl -u autofix-chat -f)."
else
  echo "    WARNING: $UNIT_SRC not found — skipping systemd install (older checkout?)."
fi

# Memory guardrails for BOTH cgroups the work lands in (which one depends on who started it: the chat
# server → system.slice/autofix-chat.service, cron fix cycles + SSH → user.slice/user-1000.slice).
# These were host-only for a day and that hurt: on 2026-08-05 the chat service was OOM-killed four times
# in 56 minutes, and a rebuilt box would have inherited none of the fix. See each file's header for the
# post-mortem; the short version is that MemoryHigh + ManagedOOMMemoryPressure=kill is self-defeating,
# because MemoryHigh's own throttling reclaim IS the PSI stall oomd then kills the whole cgroup for.
# Applied with daemon-reload only — cgroup properties re-realize on running units, so this never needs a
# restart and never interrupts in-flight turns.
echo "==> systemd memory guardrails (cgroup limits for autofix-chat.service + user-1000.slice)"
for pair in "autofix-chat.service.d-10-memory.conf:autofix-chat.service.d" "user-1000.slice.d-10-memory.conf:user-1000.slice.d"; do
  SRC="$WORKDIR/.linear-autofix/deploy/ec2/${pair%%:*}"
  DIR="/etc/systemd/system/${pair##*:}"
  if [ -f "$SRC" ]; then
    sudo mkdir -p "$DIR"
    sudo install -m 0644 -o root -g root "$SRC" "$DIR/10-memory.conf"
    echo "    installed $DIR/10-memory.conf"
  else
    echo "    WARNING: $SRC not found — skipping (older checkout?)."
  fi
done
sudo systemctl daemon-reload
# Confirm oomd is NOT pressure-killing these cgroups: "Memory Pressure Monitored CGroups" must be empty.
sudo oomctl 2>/dev/null | sed -n '/Memory Pressure Monitored CGroups/,$p' | head -3 || true

# ENG-655: durable log retention. Install a logrotate policy so poll.log + chat.log can't grow unbounded
# even if the poll cron (which does per-cycle rotation) stops. Idempotent — re-copies the config each run.
echo "==> Log retention: logrotate for poll.log + chat.log"
sudo dnf -y install logrotate >/dev/null 2>&1 || true
LOGROTATE_SRC="$WORKDIR/.linear-autofix/deploy/ec2/autofix-logrotate.conf"
if [ -f "$LOGROTATE_SRC" ]; then
  sudo cp "$LOGROTATE_SRC" /etc/logrotate.d/autofix
  sudo systemctl enable --now logrotate.timer >/dev/null 2>&1 || true   # AL2023 runs logrotate via a timer
  sudo logrotate --debug /etc/logrotate.d/autofix >/dev/null 2>&1 && echo "    /etc/logrotate.d/autofix installed (validated)." || echo "    /etc/logrotate.d/autofix installed."
else
  echo "    WARNING: $LOGROTATE_SRC not found — skipping logrotate install."
fi

# ENG-655: SSM Agent for remote management / Session Manager / Run Command. Idempotent install + enable.
# On AL2023 it is usually preinstalled; this makes sure it's present and running.
# NOTE (do NOT apply here): the instance only becomes a MANAGED instance once its IAM role grants SSM
# permissions (AmazonSSMManagedInstanceCore, i.e. ssm:UpdateInstanceInformation + messages/* etc). That
# is an IAM change — flag it for the role/IAM step (Harsha / ENG-562); the agent running without perms is
# harmless (it just can't register).
echo "==> SSM Agent (install + enable; managed-instance registration needs IAM perms — see ENG-562)"
if ! systemctl list-unit-files 2>/dev/null | grep -q '^amazon-ssm-agent'; then
  sudo dnf -y install amazon-ssm-agent >/dev/null 2>&1 || true
fi
sudo systemctl enable --now amazon-ssm-agent >/dev/null 2>&1 \
  && echo "    amazon-ssm-agent enabled (grant the role AmazonSSMManagedInstanceCore to register — ENG-562)." \
  || echo "    amazon-ssm-agent present/enable attempted — registration still needs role SSM perms (ENG-562)."

cat <<EOF

==> Bootstrap complete. Remaining interactive steps (see RUNBOOK.md):
    1) claude   -> /login       subscription login (use SSH -L port-forward; see runbook)
    2) edit $WORKDIR/.linear-autofix/.env    (LINEAR_API_KEY)
    3) confirm $WORKDIR/backend/.env exists (auto-pulled from Secrets Manager above);
       dev DynamoDB + secrets access come from the instance role — nothing to copy
    4) test ONE bug by hand:  node .linear-autofix/autofix.mjs <ID> --dry-run
    5) install the cron line (RUNBOOK.md, uses xvfb-run for headless browser-verify)
EOF
