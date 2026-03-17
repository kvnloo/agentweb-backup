#!/bin/bash
# user-data-dev-auto.sh — EC2 user-data for Notion-triggered dev environments
#
# Fully self-contained: installs everything, clones repos, starts dev servers,
# and launches Claude Code with "prep branch for <title>" automatically.
#
# Required EC2 tags:
#   notion-page-id  — Notion page ID to fetch title/content from
#   sg-id           — Security group ID (passed to test-env-access)
#
# Required Secrets Manager secrets:
#   agentweb/test-env/github-pat       — GitHub PAT for git clone
#   agentweb/test-env/ssh-password     — Password for ec2-user SSH
#   agentweb/test-env/notion-token     — Notion API token
#   agentweb/test-env/backend-env      — Backend .env file contents
#   agentweb/test-env/test-env-access-env — test-env-access .env (Resend API key)
#   agentweb/test-env/claude-code-env  — Claude Code Bedrock config
set -euxo pipefail

REGION="${AWS_REGION:-us-west-2}"
APP_DIR="/home/ec2-user/agentweb"
LOG_DIR="$APP_DIR/logs"

###############################################################################
# Helper: fetch secret from Secrets Manager
###############################################################################
get_secret() {
  aws secretsmanager get-secret-value \
    --secret-id "$1" \
    --region "$REGION" \
    --query SecretString --output text
}

###############################################################################
# Helper: get EC2 tag value via IMDSv2
###############################################################################
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

###############################################################################
# Helper: get public IP via IMDSv2
###############################################################################
get_public_ip() {
  local token
  token=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
  curl -s -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/public-ipv4
}

###############################################################################
# 1. Install system packages + enable password SSH (do SSH early for debugging)
###############################################################################
dnf install -y git tmux rsync cronie gcc-c++ make jq \
  alsa-lib at-spi2-atk atk at-spi2-core cairo cups-libs dbus-libs \
  libdrm mesa-libgbm glib2 nspr nss pango libX11 libxcb libXcomposite \
  libXdamage libXext libXfixes libxkbcommon libXrandr
systemctl enable crond
systemctl start crond

# Enable password-based SSH immediately so we can debug if later steps fail
SSH_PASSWORD=$(get_secret "agentweb/test-env/ssh-password")
echo "ec2-user:${SSH_PASSWORD}" | chpasswd

sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config
sed -i 's/^#\?ChallengeResponseAuthentication .*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
# Also handle the sshd_config.d drop-in that AL2023 may use
if [ -d /etc/ssh/sshd_config.d ]; then
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [ -f "$f" ] && sed -i 's/^PasswordAuthentication no/PasswordAuthentication yes/' "$f"
  done
fi
systemctl restart sshd

# Install Node.js 20 via NodeSource
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# Install Claude Code CLI globally
npm install -g @anthropic-ai/claude-code

# Install GitHub CLI
dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
dnf install -y gh

# Install Google Chrome for Playwright MCP (npx playwright install chrome only works on Ubuntu/Debian)
curl -o /tmp/chrome.rpm https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm
dnf localinstall -y /tmp/chrome.rpm
rm -f /tmp/chrome.rpm

# Install Playwright browser for MCP
sudo -u ec2-user npx playwright install chromium

###############################################################################
# 3. Clone repos
###############################################################################
GITHUB_PAT=$(get_secret "agentweb/test-env/github-pat")

mkdir -p "$APP_DIR"
git clone "https://${GITHUB_PAT}@github.com/AgentWebPro/agentweb.git" "$APP_DIR"
git clone "https://${GITHUB_PAT}@github.com/AgentWebPro/agentweb-customer-portal.git" "$APP_DIR/customer-portal"

mkdir -p "$LOG_DIR"
chown -R ec2-user:ec2-user "$APP_DIR"

# Install @playwright/test in project so MCP browser_install tool doesn't fail
# (without this dep, npx playwright install warns about missing project deps and the MCP tool treats it as error)
cd "$APP_DIR" && sudo -u ec2-user npm install @playwright/test --no-save 2>/dev/null && cd /

# Ensure Playwright browser_install is allowed in Claude settings
SETTINGS_FILE="$APP_DIR/.claude/settings.local.json"
if [[ -f "$SETTINGS_FILE" ]]; then
  python3 -c "
import json
with open('$SETTINGS_FILE') as f:
    s = json.load(f)
tool = 'mcp__playwright__browser_install'
if tool not in s.get('permissions',{}).get('allow',[]):
    s.setdefault('permissions',{}).setdefault('allow',[]).append(tool)
    with open('$SETTINGS_FILE','w') as f:
        json.dump(s, f, indent=2)
        f.write('\n')
"
fi

# Set up git config for ec2-user
sudo -u ec2-user git config --global user.name "ec2-user"
sudo -u ec2-user git config --global user.email "ec2-user@test-env"

# Authenticate gh CLI with GitHub PAT
echo "$GITHUB_PAT" | sudo -u ec2-user gh auth login --with-token

###############################################################################
# 4. Configure backend .env
###############################################################################
PUBLIC_IP=$(get_public_ip)

get_secret "agentweb/test-env/backend-env" > "$APP_DIR/backend/.env"

cd "$APP_DIR/backend"
sed -i "s|^FRONTEND_URL=.*|FRONTEND_URL=http://$PUBLIC_IP:5173|" .env
sed -i "s|^CUSTOMER_FRONTEND_URL=.*|CUSTOMER_FRONTEND_URL=http://$PUBLIC_IP:5174|" .env
sed -i "s|^BACKEND_URL=.*|BACKEND_URL=http://$PUBLIC_IP:3001|" .env
grep -q '^NODE_ENV=' .env && sed -i 's|^NODE_ENV=.*|NODE_ENV=development|' .env || echo 'NODE_ENV=development' >> .env

###############################################################################
# 5. Create frontend .env.local files
###############################################################################
cat > "$APP_DIR/partner-portal/.env.local" <<ENVEOF
VITE_API_URL=http://$PUBLIC_IP:3001
VITE_CUSTOMER_FRONTEND_URL=http://$PUBLIC_IP:5174
VITE_DEBUG=true
ENVEOF

cat > "$APP_DIR/customer-portal/.env.local" <<ENVEOF
VITE_API_URL=http://$PUBLIC_IP:3001
VITE_DEBUG=true
ENVEOF

###############################################################################
# 6. Configure Claude Code Bedrock
###############################################################################
CLAUDE_ENV=$(get_secret "agentweb/test-env/claude-code-env")

# Write exports to ec2-user's .bashrc
{
  echo ''
  echo '# Claude Code Bedrock config'
  while IFS= read -r line; do
    [[ -n "$line" ]] && echo "export $line"
  done <<< "$CLAUDE_ENV"
} >> /home/ec2-user/.bashrc

###############################################################################
# 7. Write cloud-dev CLAUDE.md (user-level config for Claude Code)
###############################################################################
mkdir -p /home/ec2-user/.claude
sed "s|PUBLIC_IP|$PUBLIC_IP|g" "$APP_DIR/test-env/cloud-dev-claude.md" \
  > /home/ec2-user/.claude/CLAUDE.md
chown -R ec2-user:ec2-user /home/ec2-user/.claude

###############################################################################
# 8. npm ci in all projects
###############################################################################
cd "$APP_DIR/backend" && sudo -u ec2-user npm ci
cd "$APP_DIR/partner-portal" && sudo -u ec2-user npm ci
cd "$APP_DIR/customer-portal" && sudo -u ec2-user npm ci
cd "$APP_DIR/test-env-access" && sudo -u ec2-user npm ci

###############################################################################
# 9. Configure test-env-access
###############################################################################
SG_ID=$(get_instance_tag "sg-id")

# Allow the instance to reach its own public IP (needed for Playwright browser testing)
for PORT in 3001 5173 5174; do
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp \
    --port "$PORT" \
    --cidr "$PUBLIC_IP/32" \
    --region "$REGION" 2>/dev/null || true
done

# Fetch Resend API key from Secrets Manager
TEA_ENV=$(get_secret "agentweb/test-env/test-env-access-env")
RESEND_KEY=$(echo "$TEA_ENV" | grep '^RESEND_API_KEY=' | cut -d= -f2-)

NOTION_PAGE_ID=$(get_instance_tag "notion-page-id")

cat > "$APP_DIR/test-env-access/.env" <<ENVEOF
RESEND_API_KEY=${RESEND_KEY}
SG_ID=${SG_ID}
AWS_REGION=${REGION}
NOTION_PAGE_ID=${NOTION_PAGE_ID}
ENVEOF

###############################################################################
# 10. Start all services (including test-env-access)
###############################################################################
sudo -u ec2-user tmux new-session -d -s backend -c "$APP_DIR/backend" \
  "while true; do echo \"[backend] Starting ts-node-dev at \$(date)\" | tee -a $LOG_DIR/backend.log; npx ts-node-dev --respawn --exit-child --transpile-only src/server.ts 2>&1 | tee -a $LOG_DIR/backend.log; echo \"[backend] Process exited (\$?) at \$(date). Restarting in 3s...\" | tee -a $LOG_DIR/backend.log; sleep 3; done"

sudo -u ec2-user tmux new-session -d -s partner-portal -c "$APP_DIR/partner-portal" \
  "npx vite --host 0.0.0.0 --port 5173 2>&1 | tee -a $LOG_DIR/partner-portal.log; exec bash"

sudo -u ec2-user tmux new-session -d -s customer-portal -c "$APP_DIR/customer-portal" \
  "npx vite --host :: --port 5174 2>&1 | tee -a $LOG_DIR/customer-portal.log; exec bash"

sudo -u ec2-user tmux new-session -d -s test-env-access -c "$APP_DIR/test-env-access" \
  "node server.js 2>&1 | tee -a $LOG_DIR/test-env-access.log; exec bash"

###############################################################################
# 11. Set up watchdog cron
###############################################################################
if [ -f "$APP_DIR/test-env/watchdog.sh" ]; then
  cp "$APP_DIR/test-env/watchdog.sh" /opt/watchdog.sh
  chmod +x /opt/watchdog.sh
  echo '0 * * * * /opt/watchdog.sh >> /var/log/watchdog.log 2>&1' | crontab -
fi

###############################################################################
# 12. Launch Claude Code with Notion task context
###############################################################################
# NOTION_PAGE_ID already set in step 9
NOTION_TOKEN=$(get_secret "agentweb/test-env/notion-token")

# Fetch page title from Notion API
PAGE_JSON=$(curl -s "https://api.notion.com/v1/pages/${NOTION_PAGE_ID}" \
  -H "Authorization: Bearer ${NOTION_TOKEN}" \
  -H "Notion-Version: 2022-06-28")

# Extract title — handles both "Name" and "title" property names
PAGE_TITLE=$(echo "$PAGE_JSON" | jq -r '
  .properties | to_entries[] |
  select(.value.type == "title") |
  .value.title | map(.plain_text) | join("")
')

# Fetch page content (block children) from Notion API
BLOCKS_JSON=$(curl -s "https://api.notion.com/v1/blocks/${NOTION_PAGE_ID}/children?page_size=100" \
  -H "Authorization: Bearer ${NOTION_TOKEN}" \
  -H "Notion-Version: 2022-06-28")

# Extract plain text from all text-bearing block types
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

# Extract and download attachments (image, file, pdf, video blocks)
ATTACHMENTS_DIR="$APP_DIR/.notion-attachments"
mkdir -p "$ATTACHMENTS_DIR"
chown ec2-user:ec2-user "$ATTACHMENTS_DIR"

ATTACHMENT_LIST=""
while IFS=$'\t' read -r url name; do
  [[ -z "$url" ]] && continue
  # URL-decode the filename
  decoded_name=$(printf '%b' "${name//%/\\x}")
  # Sanitize: remove path separators and control characters
  decoded_name=$(echo "$decoded_name" | tr -d '/' | tr -cd '[:print:]')
  [[ -z "$decoded_name" ]] && decoded_name="attachment_$(date +%s%N)"
  dest="$ATTACHMENTS_DIR/$decoded_name"
  echo "Downloading attachment: $decoded_name"
  if curl -sL -o "$dest" "$url"; then
    chown ec2-user:ec2-user "$dest"
    ATTACHMENT_LIST="${ATTACHMENT_LIST}
- ${dest}"
  else
    echo "WARNING: Failed to download $url"
  fi
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

# Build the Claude prompt
CLAUDE_PROMPT="Prep branch for ${PAGE_TITLE}."
if [[ -n "$PAGE_CONTENT" ]]; then
  CLAUDE_PROMPT="${CLAUDE_PROMPT} More details: ${PAGE_CONTENT}"
fi
if [[ -n "$ATTACHMENT_LIST" ]]; then
  CLAUDE_PROMPT="${CLAUDE_PROMPT}

The following attachments from the Notion page have been downloaded to the EC2 instance. Read/view them as needed:
${ATTACHMENT_LIST}"
fi

# Write prompt file
echo "$CLAUDE_PROMPT" > "$APP_DIR/.claude-prompt"
chown ec2-user:ec2-user "$APP_DIR/.claude-prompt"

# Script to run Claude and post its output as a Notion comment
cat > "$APP_DIR/.claude-run.sh" <<'RUNEOF'
#!/bin/bash
source ~/.bashrc
cd ~/agentweb

OUTPUT=$(claude -p "$(cat .claude-prompt)" 2>&1)
EXIT_CODE=$?

NOTION_PAGE_ID=$(cat .notion-page-id 2>/dev/null)
NOTION_TOKEN=$(cat .notion-token 2>/dev/null)
if [[ -n "$NOTION_PAGE_ID" && -n "$NOTION_TOKEN" ]]; then
  if [[ $EXIT_CODE -ne 0 ]]; then
    OUTPUT="Claude Code exited with code $EXIT_CODE:
$OUTPUT"
  fi
  # Write output to temp file to avoid shell interpolation issues
  printf '%s' "$OUTPUT" > /tmp/.claude-output.txt
  # Build Notion comment JSON via Python (reads from file, avoids shell escaping)
  BODY=$(python3 -c "
import json, sys
with open('/tmp/.claude-output.txt', 'r', errors='replace') as f:
    text = f.read()
# Truncate to ~9900 chars
if len(text) > 9900:
    text = text[:9900] + '\n\n...(truncated)'
chunks = [{'text': {'content': text[i:i+2000]}} for i in range(0, len(text), 2000)]
if not chunks:
    chunks = [{'text': {'content': '(no output)'}}]
print(json.dumps({'parent': {'page_id': sys.argv[1]}, 'rich_text': chunks}))
" "$NOTION_PAGE_ID")
  if [[ -n "$BODY" ]]; then
    curl -s -X POST "https://api.notion.com/v1/comments" \
      -H "Authorization: Bearer $NOTION_TOKEN" \
      -H "Notion-Version: 2022-06-28" \
      -H "Content-Type: application/json" \
      -d "$BODY"
  fi
  rm -f /tmp/.claude-output.txt
fi
exec bash
RUNEOF
chmod +x "$APP_DIR/.claude-run.sh"

# Write Notion page ID and token for the post-session script
echo "$NOTION_PAGE_ID" > "$APP_DIR/.notion-page-id"
echo "$NOTION_TOKEN" > "$APP_DIR/.notion-token"
chown ec2-user:ec2-user "$APP_DIR/.claude-run.sh" "$APP_DIR/.notion-page-id" "$APP_DIR/.notion-token"

# Launch Claude Code in a tmux session as ec2-user
sudo -u ec2-user tmux new-session -d -s claude "$APP_DIR/.claude-run.sh"

###############################################################################
# 13. Signal readiness
###############################################################################
touch /home/ec2-user/.test-env-dev-ready
