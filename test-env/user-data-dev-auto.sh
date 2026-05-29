#!/bin/bash
# EC2 user-data for Notion-triggered dev environments (must stay under 16KB)
set -euxo pipefail

# 0. Swap space (prevents OOM when tsc + Claude + services run together)
fallocate -l 8G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab

REGION="${AWS_REGION:-us-west-2}"
APP_DIR="/home/ec2-user/agentweb"
LOG_DIR="$APP_DIR/logs"

get_secret() {
  aws secretsmanager get-secret-value \
    --secret-id "$1" \
    --region "$REGION" \
    --query SecretString --output text
}

get_instance_tag() {
  local tag_key="$1"
  local token
  token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
  local instance_id
  instance_id=$(curl -s -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/instance-id)
  aws ec2 describe-tags \
    --region "$REGION" \
    --filters "Name=resource-id,Values=$instance_id" "Name=key,Values=$tag_key" \
    --query 'Tags[0].Value' --output text
}

get_public_ip() {
  local token
  token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
  curl -s -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/public-ipv4
}

get_instance_type() {
  local token
  token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
  curl -s -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/instance-type
}

# 1. System packages + password SSH (early for debugging)
dnf install -y git tmux rsync cronie gcc-c++ make jq \
  alsa-lib at-spi2-atk atk at-spi2-core cairo cups-libs dbus-libs \
  libdrm mesa-libgbm glib2 nspr nss pango libX11 libxcb libXcomposite \
  libXdamage libXext libXfixes libxkbcommon libXrandr
systemctl enable crond
systemctl start crond

SSH_PASSWORD=$(get_secret "agentweb/test-env/ssh-password")
echo "ec2-user:${SSH_PASSWORD}" | chpasswd

sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config
sed -i 's/^#\?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
if [ -d /etc/ssh/sshd_config.d ]; then
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [ -f "$f" ] && sed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' "$f"
  done
fi
systemctl restart sshd

curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs
npm install -g @anthropic-ai/claude-code

dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
dnf install -y gh

curl -o /tmp/chrome.rpm https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm
dnf localinstall -y /tmp/chrome.rpm
rm -f /tmp/chrome.rpm

sudo -u ec2-user npx playwright install chromium

# 3. Clone repos
GITHUB_PAT=$(get_secret "agentweb/test-env/github-pat")

mkdir -p "$APP_DIR"
git clone "https://${GITHUB_PAT}@github.com/AgentWebPro/agentweb.git" "$APP_DIR"
git clone "https://${GITHUB_PAT}@github.com/AgentWebPro/agentweb-customer-portal.git" "$APP_DIR/customer-portal"

mkdir -p "$LOG_DIR"
chown -R ec2-user:ec2-user "$APP_DIR"

cd "$APP_DIR" && sudo -u ec2-user npm install @playwright/test --no-save 2>/dev/null && cd /

# Create Claude Code project settings with pre-approved tool permissions
# This goes in the user-level project settings directory (not the repo .claude/)
CLAUDE_PROJECT_DIR="/home/ec2-user/.claude/projects/-home-ec2-user-agentweb"
mkdir -p "$CLAUDE_PROJECT_DIR"
cat > "$CLAUDE_PROJECT_DIR/settings.local.json" <<'CLSEOF'
{
  "permissions": {
    "allow": [
      "Bash(npm test*)",
      "Bash(npx tsc*)",
      "Bash(npx vite*)",
      "Bash(npx ts-node*)",
      "Bash(npx playwright*)",
      "Bash(git *)",
      "Bash(gh *)",
      "Bash(cat *)",
      "Bash(ls *)",
      "Bash(find *)",
      "Bash(grep *)",
      "Bash(curl *)",
      "Bash(cd *)",
      "Bash(aws *)",
      "Bash(mkdir *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(rm *)",
      "Bash(echo *)",
      "Bash(tail *)",
      "Bash(head *)",
      "Bash(wc *)",
      "Bash(diff *)",
      "Bash(sed *)",
      "Bash(sort *)",
      "Bash(tmux *)",
      "Bash(nohup *)",
      "Bash(kill *)",
      "Bash(chmod *)",
      "Bash(~/agentweb/test-env/*)",
      "Bash(/home/ec2-user/agentweb/test-env/*)",
      "Bash(npm run *)",
      "Bash(touch *)",
      "mcp__playwright__browser_navigate",
      "mcp__playwright__browser_snapshot",
      "mcp__playwright__browser_click",
      "mcp__playwright__browser_type",
      "mcp__playwright__browser_fill_form",
      "mcp__playwright__browser_file_upload",
      "mcp__playwright__browser_take_screenshot",
      "mcp__playwright__browser_press_key",
      "mcp__playwright__browser_select_option",
      "mcp__playwright__browser_hover",
      "mcp__playwright__browser_wait_for",
      "mcp__playwright__browser_tabs",
      "mcp__playwright__browser_navigate_back",
      "mcp__playwright__browser_console_messages",
      "mcp__playwright__browser_network_requests",
      "mcp__playwright__browser_handle_dialog",
      "mcp__playwright__browser_drag",
      "mcp__playwright__browser_evaluate",
      "mcp__playwright__browser_run_code",
      "mcp__playwright__browser_resize",
      "mcp__playwright__browser_close",
      "mcp__playwright__browser_install",
      "mcp__notion__API-post-search",
      "mcp__notion__API-retrieve-a-page",
      "mcp__notion__API-retrieve-a-comment",
      "mcp__notion__API-create-a-comment",
      "mcp__notion__API-patch-page",
      "mcp__notion__API-get-block-children",
      "mcp__notion__API-retrieve-a-database",
      "mcp__notion__API-query-data-source",
      "WebFetch"
    ],
    "deny": []
  }
}
CLSEOF
chown -R ec2-user:ec2-user /home/ec2-user/.claude

# 3b. Preload Claude Code memory files (engineering knowledge)
CLAUDE_MEMORY_DIR="$CLAUDE_PROJECT_DIR/memory"
mkdir -p "$CLAUDE_MEMORY_DIR"
cp "$APP_DIR/test-env/claude-memory/"*.md "$CLAUDE_MEMORY_DIR/"
chown -R ec2-user:ec2-user /home/ec2-user/.claude

sudo -u ec2-user git config --global user.name "Rui Wang"
sudo -u ec2-user git config --global user.email "52230987+john-the-dev@users.noreply.github.com"
echo "$GITHUB_PAT" | sudo -u ec2-user gh auth login --with-token

# 4. Configure backend .env
PUBLIC_IP=$(get_public_ip)
INSTANCE_TYPE=$(get_instance_type)
LAUNCH_EPOCH=$(date -u +%s)
printf 'instance_type=%s\nlaunch_epoch=%s\n' "$INSTANCE_TYPE" "$LAUNCH_EPOCH" \
  > "$APP_DIR/.ec2-session-meta"
chown ec2-user:ec2-user "$APP_DIR/.ec2-session-meta"

get_secret "agentweb/test-env/backend-env" > "$APP_DIR/backend/.env"

cd "$APP_DIR/backend"
sed -i "s|^FRONTEND_URL=.*|FRONTEND_URL=http://$PUBLIC_IP:5173|" .env
sed -i "s|^CUSTOMER_FRONTEND_URL=.*|CUSTOMER_FRONTEND_URL=http://$PUBLIC_IP:5174|" .env
sed -i "s|^BACKEND_URL=.*|BACKEND_URL=http://$PUBLIC_IP:3001|" .env
grep -q '^NODE_ENV=' .env && sed -i 's|^NODE_ENV=.*|NODE_ENV=development|' .env || echo 'NODE_ENV=development' >> .env

# 5. Frontend .env.local files
cat > "$APP_DIR/partner-portal/.env.local" <<ENVEOF
VITE_API_URL=http://$PUBLIC_IP:3001
VITE_CUSTOMER_FRONTEND_URL=http://$PUBLIC_IP:5174
VITE_DEBUG=true
ENVEOF

cat > "$APP_DIR/customer-portal/.env.local" <<ENVEOF
VITE_API_URL=http://$PUBLIC_IP:3001
VITE_DEBUG=true
ENVEOF

# 6. Claude Code Bedrock config
CLAUDE_ENV=$(get_secret "agentweb/test-env/claude-code-env")
{
  echo ''
  echo '# Claude Code Bedrock config'
  while IFS= read -r line; do
    [[ -n "$line" ]] && echo "export $line"
  done <<< "$CLAUDE_ENV"
} >> /home/ec2-user/.bashrc

# 7. Cloud-dev CLAUDE.md
mkdir -p /home/ec2-user/.claude
sed "s|PUBLIC_IP|$PUBLIC_IP|g" "$APP_DIR/test-env/cloud-dev-claude.md" \
  > /home/ec2-user/.claude/CLAUDE.md
chown -R ec2-user:ec2-user /home/ec2-user/.claude

# 8. npm ci
cd "$APP_DIR/backend" && sudo -u ec2-user npm ci
cd "$APP_DIR/partner-portal" && sudo -u ec2-user npm ci
cd "$APP_DIR/customer-portal" && sudo -u ec2-user npm ci
cd "$APP_DIR/test-env-access" && sudo -u ec2-user npm ci

# 9. Configure test-env-access
SG_ID=$(get_instance_tag "sg-id")

for PORT in 3001 5173 5174; do
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp \
    --port "$PORT" \
    --cidr "$PUBLIC_IP/32" \
    --region "$REGION" 2>/dev/null || true
done

TEA_ENV=$(get_secret "agentweb/test-env/test-env-access-env")
RESEND_KEY=$(echo "$TEA_ENV" | grep '^RESEND_API_KEY=' | cut -d= -f2-)

NOTION_PAGE_ID=$(get_instance_tag "notion-page-id")

cat > "$APP_DIR/test-env-access/.env" <<ENVEOF
RESEND_API_KEY=${RESEND_KEY}
SG_ID=${SG_ID}
AWS_REGION=${REGION}
NOTION_PAGE_ID=${NOTION_PAGE_ID}
ENVEOF

# 10. Start services
sudo -u ec2-user tmux new-session -d -s backend -c "$APP_DIR/backend" \
  "while true; do echo \"[backend] Starting ts-node-dev at \$(date)\" | tee -a $LOG_DIR/backend.log; npx ts-node-dev --respawn --exit-child --transpile-only src/server.ts 2>&1 | tee -a $LOG_DIR/backend.log; echo \"[backend] Process exited (\$?) at \$(date). Restarting in 3s...\" | tee -a $LOG_DIR/backend.log; sleep 3; done"

sudo -u ec2-user tmux new-session -d -s partner-portal -c "$APP_DIR/partner-portal" \
  "npx vite --host 0.0.0.0 --port 5173 2>&1 | tee -a $LOG_DIR/partner-portal.log; exec bash"

sudo -u ec2-user tmux new-session -d -s customer-portal -c "$APP_DIR/customer-portal" \
  "npx vite --host :: --port 5174 2>&1 | tee -a $LOG_DIR/customer-portal.log; exec bash"

sudo -u ec2-user tmux new-session -d -s test-env-access -c "$APP_DIR/test-env-access" \
  "node server.js 2>&1 | tee -a $LOG_DIR/test-env-access.log; exec bash"

# 11. Watchdog cron
if [ -f "$APP_DIR/test-env/watchdog.sh" ]; then
  cp "$APP_DIR/test-env/watchdog.sh" /opt/watchdog.sh
  chmod +x /opt/watchdog.sh
  echo '0 * * * * /opt/watchdog.sh >> /var/log/watchdog.log 2>&1' | crontab -
fi

# 12. Launch Claude Code with Notion task context
NOTION_TOKEN=$(get_secret "agentweb/test-env/notion-token")

PAGE_JSON=$(curl -s "https://api.notion.com/v1/pages/${NOTION_PAGE_ID}" \
  -H "Authorization: Bearer ${NOTION_TOKEN}" \
  -H "Notion-Version: 2022-06-28")

PAGE_TITLE=$(echo "$PAGE_JSON" | jq -r '
  .properties | to_entries[] |
  select(.value.type == "title") |
  .value.title | map(.plain_text) | join("")
')

BLOCKS_JSON=$(curl -s "https://api.notion.com/v1/blocks/${NOTION_PAGE_ID}/children?page_size=100" \
  -H "Authorization: Bearer ${NOTION_TOKEN}" \
  -H "Notion-Version: 2022-06-28")

PAGE_CONTENT=$(echo "$BLOCKS_JSON" | jq -r '
  .results[] |
  (
    .paragraph?.rich_text //
    .heading_1?.rich_text //
    .heading_2?.rich_text //
    .heading_3?.rich_text //
    .bulleted_list_item?.rich_text //
    .numbered_list_item?.rich_text //
    .to_do?.rich_text //
    .toggle?.rich_text //
    .callout?.rich_text //
    .quote?.rich_text //
    []
  ) | map(.plain_text) | join("")
' | sed '/^$/d')

ATTACHMENTS_DIR="$APP_DIR/.notion-attachments"
mkdir -p "$ATTACHMENTS_DIR"
chown ec2-user:ec2-user "$ATTACHMENTS_DIR"

# Helper function to download an attachment
download_attachment() {
  local url="$1" name="$2"
  [[ -z "$url" ]] && return
  local decoded_name
  decoded_name=$(printf '%b' "${name//%/\\x}")
  decoded_name=$(echo "$decoded_name" | tr -d '/' | tr -cd '[:print:]')
  [[ -z "$decoded_name" ]] && decoded_name="attachment_$(date +%s%N)"
  local dest="$ATTACHMENTS_DIR/$decoded_name"
  echo "Downloading attachment: $decoded_name"
  if curl -sL -o "$dest" "$url"; then
    chown ec2-user:ec2-user "$dest"
    ATTACHMENT_LIST="${ATTACHMENT_LIST}
- ${dest}"
  else
    echo "WARNING: Failed to download $url"
  fi
}

ATTACHMENT_LIST=""

# Extract attachments from page-level file properties (Files & media properties)
while IFS=$'\t' read -r url name; do
  download_attachment "$url" "$name"
done < <(echo "$PAGE_JSON" | jq -r '
  .properties | to_entries[] |
  select(.value.type == "files") |
  .value.files[] |
  (if .type == "file" then .file.url
   elif .type == "external" then .external.url
   else empty end) as $url |
  .name as $name |
  "\($url)\t\($name)"
')

# Extract attachments from block-level images, files, PDFs, and videos
while IFS=$'\t' read -r url name; do
  download_attachment "$url" "$name"
done < <(echo "$BLOCKS_JSON" | jq -r '
  .results[] |
  select(.type == "image" or .type == "file" or .type == "pdf" or .type == "video") |
  . as $block |
  ($block[$block.type] |
    (if .type == "file" then .file.url
     elif .type == "external" then .external.url
     else empty end)
  ) as $url |
  ($block[$block.type] |
    (if .caption and (.caption | length > 0) then (.caption | map(.plain_text) | join(""))
     elif .name then .name
     else ($url | split("/") | last | split("?") | first)
     end)
  ) as $name |
  "\($url)\t\($name)"
')

CLAUDE_PROMPT="Prep branch for ${PAGE_TITLE}."
if [[ -n "$PAGE_CONTENT" ]]; then
  CLAUDE_PROMPT="${CLAUDE_PROMPT} More details: ${PAGE_CONTENT}"
fi
if [[ -n "$ATTACHMENT_LIST" ]]; then
  CLAUDE_PROMPT="${CLAUDE_PROMPT}

IMPORTANT: The following screenshot/image attachments from the Notion page have been downloaded to the EC2 instance. You MUST use the Read tool to view each image file BEFORE starting any work — these contain critical visual context for the task:
${ATTACHMENT_LIST}"
fi

echo "$CLAUDE_PROMPT" > "$APP_DIR/.claude-prompt"
chown ec2-user:ec2-user "$APP_DIR/.claude-prompt"

cp "$APP_DIR/test-env/claude-comment.py" "$APP_DIR/.claude-comment.py"
chown ec2-user:ec2-user "$APP_DIR/.claude-comment.py"

cp "$APP_DIR/test-env/claude-run.sh" "$APP_DIR/.claude-run.sh"
chmod +x "$APP_DIR/.claude-run.sh"

echo "$NOTION_PAGE_ID" > "$APP_DIR/.notion-page-id"
echo "$NOTION_TOKEN" > "$APP_DIR/.notion-token"
chown ec2-user:ec2-user "$APP_DIR/.claude-run.sh" "$APP_DIR/.notion-page-id" "$APP_DIR/.notion-token"

# Clear any resume pointer carried over from a prior task on a recycled instance,
# so the follow-up-comment handler can't resume the previous task's Claude session.
rm -f "$APP_DIR/.claude-session-id"

sudo -u ec2-user tmux new-session -d -s claude "$APP_DIR/.claude-run.sh"

# 13. Signal readiness
touch /home/ec2-user/.test-env-dev-ready
