#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# test-env.sh — Launch / teardown / sync ephemeral cloud test environments
#
# Supports multiple environments per developer. The environment name is
# derived automatically from the developer's AWS username and the repo
# folder name (e.g., myuser-agentweb), so each clone gets its own instance.
#
# Usage:
#   ./test-env.sh launch   [--dev] [--key-name K] [--key-file F] [--instance-type T] [--no-watchdog]
#   ./test-env.sh teardown
#   ./test-env.sh sync     [backend|partner-portal|customer-portal|test-env-access]
#   ./test-env.sh status
#   ./test-env.sh allow-ip <IP>         # grant another IP access
#   ./test-env.sh revoke-ip <IP>        # revoke an IP's access
#   ./test-env.sh ssh
#   ./test-env.sh claude   [message]              # dev mode: run Claude Code
#   ./test-env.sh logs     [backend|partner-portal|customer-portal]
#   ./test-env.sh list                  # list active environment
#   ./test-env.sh teardown-all          # terminate environment
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$REPO_ROOT/.test-env"
CONFIG_FILE="$REPO_ROOT/.test-env.config"

# Defaults
REGION="${AWS_REGION:-us-west-2}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.large}"
SECRET_NAME="${SECRET_NAME:-agentweb/test-env/backend-env}"
SECRET_NAME_ACCESS="${SECRET_NAME_ACCESS:-agentweb/test-env/test-env-access-env}"
SECRET_NAME_CLAUDE="${SECRET_NAME_CLAUDE:-agentweb/test-env/claude-code-env}"
PROFILE_NAME="agentweb-test-env-profile"
SSH_USER="ec2-user"

# Load developer config if present
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[test-env]${NC} $*"; }
warn() { echo -e "${YELLOW}[test-env]${NC} $*"; }
err()  { echo -e "${RED}[test-env]${NC} $*" >&2; }

###############################################################################
# Environment name resolution
###############################################################################
resolve_env_name() {
  local aws_user folder
  aws_user=$(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null | sed 's|.*/||')
  folder=$(basename "$REPO_ROOT")
  echo "${aws_user}-${folder}"
}

state_file_for() {
  echo "$STATE_DIR/${1}.env"
}

###############################################################################
# State helpers
###############################################################################
save_state() {
  local name="$1"
  mkdir -p "$STATE_DIR"
  cat > "$(state_file_for "$name")" <<EOF
ENV_NAME=$name
INSTANCE_ID=$INSTANCE_ID
PUBLIC_IP=$PUBLIC_IP
KEY_NAME=$KEY_NAME
KEY_FILE=$KEY_FILE
SG_ID=$SG_ID
MODE=${MODE:-docker}
LAUNCH_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
}

is_dev_mode() {
  [[ "${MODE:-docker}" == "dev" ]]
}

load_state() {
  local name="$1"
  local sf
  sf="$(state_file_for "$name")"
  if [[ ! -f "$sf" ]]; then
    err "No environment for this folder. Run 'test-env.sh launch' first."
    exit 1
  fi
  # shellcheck source=/dev/null
  source "$sf"
  # Guard: verify the loaded state belongs to this folder
  if [[ "${ENV_NAME:-}" != "$name" ]]; then
    err "State file mismatch: expected '$name' but found '${ENV_NAME:-}'. Delete $sf and re-launch."
    exit 1
  fi
}

remote() {
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -i "$KEY_FILE" "$SSH_USER@$PUBLIC_IP" "$@"
}


###############################################################################
# launch
###############################################################################
cmd_launch() {
  local name
  name="$(resolve_env_name)"
  local NO_WATCHDOG=false
  local INSTANCE_TYPE_SPECIFIED=false
  MODE="docker"

  # Parse flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --key-name)      KEY_NAME="$2"; shift 2 ;;
      --key-file)      KEY_FILE="$2"; shift 2 ;;
      --instance-type) INSTANCE_TYPE="$2"; INSTANCE_TYPE_SPECIFIED=true; shift 2 ;;
      --no-watchdog)   NO_WATCHDOG=true; shift ;;
      --dev)           MODE="dev"; shift ;;
      *) err "Unknown flag: $1"; exit 1 ;;
    esac
  done

  # Dev mode: auto-upgrade to t3.2xlarge (32 GB) unless user specified --instance-type
  if is_dev_mode && [[ "$INSTANCE_TYPE_SPECIFIED" == "false" ]]; then
    INSTANCE_TYPE="t3.2xlarge"
  fi

  # If config missing and no flags provided, interactively create it
  if [[ -z "${KEY_NAME:-}" ]] || [[ -z "${KEY_FILE:-}" ]]; then
    if [[ ! -t 0 ]]; then
      err "KEY_NAME and KEY_FILE are required. Create .test-env.config or pass --key-name / --key-file"
      exit 1
    fi

    warn "No .test-env.config found. Let's create one."
    echo ""

    # List available key pairs
    log "Available EC2 key pairs in $REGION:"
    EXISTING_KEYS=$(aws ec2 describe-key-pairs --region "$REGION" \
      --query 'KeyPairs[*].KeyName' --output text 2>/dev/null || true)

    if [[ -n "$EXISTING_KEYS" ]]; then
      echo "$EXISTING_KEYS" | tr '\t' '\n' | while read -r k; do echo "  - $k"; done
    else
      echo "  (none found)"
    fi
    echo ""

    read -rp "Enter an existing key pair name, or press Enter to create a new one: " KEY_NAME

    if [[ -z "$KEY_NAME" ]]; then
      # Create a new key pair
      KEY_NAME="agentweb-test-env-$(whoami)"
      KEY_FILE="$HOME/.ssh/${KEY_NAME}.pem"

      log "Creating new EC2 key pair '$KEY_NAME'..."
      mkdir -p "$HOME/.ssh"

      aws ec2 create-key-pair \
        --key-name "$KEY_NAME" \
        --key-type ed25519 \
        --region "$REGION" \
        --query 'KeyMaterial' --output text > "$KEY_FILE"

      chmod 600 "$KEY_FILE"
      log "Key pair created. Private key saved to $KEY_FILE"
    else
      read -rp "Path to private key file [~/.ssh/${KEY_NAME}.pem]: " KEY_FILE
      KEY_FILE="${KEY_FILE:-~/.ssh/${KEY_NAME}.pem}"
    fi

    # Write config
    cat > "$CONFIG_FILE" <<EOF
KEY_NAME=$KEY_NAME
KEY_FILE=$KEY_FILE
EOF
    log "Saved .test-env.config"
    echo ""
  fi

  # Expand tilde in KEY_FILE
  KEY_FILE="${KEY_FILE/#\~/$HOME}"

  if [[ ! -f "$KEY_FILE" ]]; then
    err "Key file not found: $KEY_FILE"
    exit 1
  fi

  local sf
  sf="$(state_file_for "$name")"
  if [[ -f "$sf" ]]; then
    warn "Environment '$name' already exists. Run 'test-env.sh teardown' first."
    exit 1
  fi

  log "Launching environment: ${CYAN}$name${NC}"

  # Detect developer's public IP
  log "Detecting your public IP..."
  MY_IP=$(curl -s --max-time 5 https://checkip.amazonaws.com | tr -d '[:space:]')
  if [[ -z "$MY_IP" ]]; then
    err "Could not detect public IP. Check your internet connection."
    exit 1
  fi
  log "Your IP: $MY_IP"

  log "Resolving latest Amazon Linux 2023 AMI..."
  AMI_ID=$(aws ssm get-parameters \
    --names /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
    --region "$REGION" \
    --query 'Parameters[0].Value' --output text)
  log "AMI: $AMI_ID"

  # Get default VPC
  VPC_ID=$(aws ec2 describe-vpcs \
    --filters "Name=isDefault,Values=true" \
    --region "$REGION" \
    --query 'Vpcs[0].VpcId' --output text 2>/dev/null || true)

  if [[ -z "$VPC_ID" || "$VPC_ID" == "None" ]]; then
    err "No default VPC found in $REGION."
    exit 1
  fi

  # Create per-instance security group locked to developer's IP
  local sg_name="agentweb-test-env-${name}"
  log "Creating security group '$sg_name' (locked to $MY_IP)..."
  SG_ID=$(aws ec2 create-security-group \
    --group-name "$sg_name" \
    --description "AgentWeb test-env for $name - IP-restricted" \
    --vpc-id "$VPC_ID" \
    --region "$REGION" \
    --query 'GroupId' --output text)

  # Tag the SG for IAM policy and cleanup
  aws ec2 create-tags \
    --resources "$SG_ID" \
    --tags Key=purpose,Value=test-env Key=env-name,Value="$name" \
    --region "$REGION"

  for PORT in 22 3001 5173 5174; do
    aws ec2 authorize-security-group-ingress \
      --group-id "$SG_ID" \
      --protocol tcp \
      --port "$PORT" \
      --cidr "$MY_IP/32" \
      --region "$REGION" > /dev/null
  done

  # IP allowlist service must be publicly accessible so users can self-register
  # (not needed in dev mode — no test-env-access container)
  if ! is_dev_mode; then
    aws ec2 authorize-security-group-ingress \
      --group-id "$SG_ID" \
      --protocol tcp \
      --port 5175 \
      --cidr "0.0.0.0/0" \
      --region "$REGION" > /dev/null
  fi
  log "Security group: $SG_ID"

  # Look up instance profile
  PROFILE_ARN=$(aws iam get-instance-profile \
    --instance-profile-name "$PROFILE_NAME" \
    --query 'InstanceProfile.Arn' --output text 2>/dev/null || true)

  if [[ -z "$PROFILE_ARN" || "$PROFILE_ARN" == "None" ]]; then
    err "Instance profile '$PROFILE_NAME' not found. Run setup-infra.sh first."
    exit 1
  fi
  log "Instance profile: $PROFILE_NAME"

  # Select user-data script and EBS volume size based on mode
  local user_data_script volume_size
  if is_dev_mode; then
    user_data_script="$SCRIPT_DIR/user-data-dev.sh"
    volume_size=50
  else
    user_data_script="$SCRIPT_DIR/user-data.sh"
    volume_size=30
  fi

  log "Launching EC2 instance ($INSTANCE_TYPE, ${volume_size}GB, mode: $MODE)..."
  INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --iam-instance-profile "Name=$PROFILE_NAME" \
    --instance-initiated-shutdown-behavior terminate \
    --user-data "file://$user_data_script" \
    --tag-specifications "ResourceType=instance,Tags=[
      {Key=Name,Value=agentweb-test-env-$(whoami)-${name}},
      {Key=purpose,Value=test-env},
      {Key=creator,Value=$(whoami)},
      {Key=env-name,Value=${name}},
      {Key=mode,Value=${MODE}}
    ]" \
    --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":${volume_size},\"VolumeType\":\"gp3\"}}]" \
    --region "$REGION" \
    --query 'Instances[0].InstanceId' --output text)

  log "Instance: $INSTANCE_ID"

  # Wait for running state
  log "Waiting for instance to start..."
  aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

  PUBLIC_IP=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)

  log "Public IP: $PUBLIC_IP"
  save_state "$name"

  # Wait for SSH
  log "Waiting for SSH to become available..."
  for i in $(seq 1 60); do
    if ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
           -o ConnectTimeout=5 -o LogLevel=ERROR \
           -i "$KEY_FILE" "$SSH_USER@$PUBLIC_IP" "true" 2>/dev/null; then
      break
    fi
    if [[ $i -eq 60 ]]; then
      err "SSH timeout after 5 minutes"
      exit 1
    fi
    sleep 5
  done

  # Wait for user-data to finish
  local ready_file setup_label
  if is_dev_mode; then
    ready_file="/home/ec2-user/.test-env-dev-ready"
    setup_label="Node.js"
  else
    ready_file="/home/ec2-user/.test-env-ready"
    setup_label="Docker"
  fi
  log "Waiting for $setup_label setup to complete..."
  for i in $(seq 1 60); do
    if remote "test -f $ready_file" 2>/dev/null; then
      break
    fi
    if [[ $i -eq 60 ]]; then
      err "$setup_label setup timeout"
      exit 1
    fi
    sleep 10
  done

  log "Instance ready. Syncing code..."

  if is_dev_mode; then
    _do_sync_dev "all"
  else
    _do_sync "all"
  fi

  if is_dev_mode; then
    # --- Dev mode post-launch ---

    # Fetch backend .env from Secrets Manager and patch URLs
    log "Fetching backend .env from Secrets Manager..."
    remote "aws secretsmanager get-secret-value \
      --secret-id '$SECRET_NAME' \
      --region '$REGION' \
      --query SecretString --output text \
      > /home/ec2-user/agentweb/backend/.env"

    log "Patching backend .env with instance URLs..."
    remote "cd /home/ec2-user/agentweb/backend && \
      sed -i 's|^FRONTEND_URL=.*|FRONTEND_URL=http://$PUBLIC_IP:5173|' .env && \
      sed -i 's|^CUSTOMER_FRONTEND_URL=.*|CUSTOMER_FRONTEND_URL=http://$PUBLIC_IP:5174|' .env && \
      sed -i 's|^BACKEND_URL=.*|BACKEND_URL=http://$PUBLIC_IP:3001|' .env && \
      grep -q '^NODE_ENV=' .env && sed -i 's|^NODE_ENV=.*|NODE_ENV=development|' .env || echo 'NODE_ENV=development' >> .env"

    # Create frontend .env.local files with VITE_API_URL
    log "Creating frontend .env.local files..."
    remote "echo 'VITE_API_URL=http://$PUBLIC_IP:3001
VITE_CUSTOMER_FRONTEND_URL=http://$PUBLIC_IP:5174
VITE_DEBUG=true' > /home/ec2-user/agentweb/partner-portal/.env.local"

    remote "echo 'VITE_API_URL=http://$PUBLIC_IP:3001
VITE_DEBUG=true' > /home/ec2-user/agentweb/customer-portal/.env.local"

    # Fetch Claude Code Bedrock config from Secrets Manager and write to .bashrc
    log "Fetching Claude Code config from Secrets Manager..."
    remote "aws secretsmanager get-secret-value \
      --secret-id '$SECRET_NAME_CLAUDE' \
      --region '$REGION' \
      --query SecretString --output text \
      > /tmp/claude-code-env && \
      sed -i '/# Claude Code Bedrock config/,/^$/d' ~/.bashrc && \
      echo '' >> ~/.bashrc && \
      echo '# Claude Code Bedrock config' >> ~/.bashrc && \
      while IFS= read -r line; do
        [[ -n \"\$line\" ]] && echo \"export \$line\" >> ~/.bashrc
      done < /tmp/claude-code-env && \
      rm -f /tmp/claude-code-env"

    # Write cloud-dev CLAUDE.md (user-level config for Claude Code)
    log "Writing cloud-dev CLAUDE.md..."
    remote "mkdir -p /home/ec2-user/.claude"
    scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -i "$KEY_FILE" \
        "$SCRIPT_DIR/cloud-dev-claude.md" "$SSH_USER@$PUBLIC_IP:/home/ec2-user/.claude/CLAUDE.md"
    remote "sed -i 's|PUBLIC_IP|$PUBLIC_IP|g' /home/ec2-user/.claude/CLAUDE.md"

    # Authenticate gh CLI with GitHub PAT from Secrets Manager
    log "Authenticating gh CLI..."
    remote "aws secretsmanager get-secret-value \
      --secret-id 'agentweb/test-env/github-pat' \
      --region '$REGION' \
      --query SecretString --output text \
      | gh auth login --with-token"

    # Install npm dependencies
    log "Installing npm dependencies (this may take a few minutes)..."
    remote "cd /home/ec2-user/agentweb/backend && npm ci"
    remote "cd /home/ec2-user/agentweb/partner-portal && npm ci"
    remote "cd /home/ec2-user/agentweb/customer-portal && npm ci"

    # Deploy and start dev services
    log "Starting dev servers..."
    remote "chmod +x /home/ec2-user/agentweb/test-env/dev-services.sh && \
      /home/ec2-user/agentweb/test-env/dev-services.sh start-all"

  else
    # --- Docker mode post-launch ---

    # Fetch .env files from Secrets Manager
    log "Fetching backend .env from Secrets Manager..."
    remote "aws secretsmanager get-secret-value \
      --secret-id '$SECRET_NAME' \
      --region '$REGION' \
      --query SecretString --output text \
      > /home/ec2-user/agentweb/.env.test-env"

    log "Fetching test-env-access .env from Secrets Manager..."
    remote "aws secretsmanager get-secret-value \
      --secret-id '$SECRET_NAME_ACCESS' \
      --region '$REGION' \
      --query SecretString --output text \
      > /home/ec2-user/agentweb/.env.test-env-access"

    log "Building and starting services (this may take a few minutes on first run)..."
    remote "cd /home/ec2-user/agentweb/test-env && \
      export PUBLIC_IP='$PUBLIC_IP' && \
      export SG_ID='$SG_ID' && \
      export AWS_REGION='$REGION' && \
      docker compose build && \
      docker compose up -d"

    # Seed IP allowlist with developer's IP (and any EXTRA_IPS) so the UI shows correct status
    local dev_subnet dev_now allowlist_ips
    dev_subnet="$(echo "$MY_IP" | awk -F. '{printf "%s.%s.%s.0/24", $1, $2, $3}')"
    dev_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    allowlist_ips="{\"ip\":\"$MY_IP\",\"subnet\":\"$dev_subnet\",\"email\":\"launcher\",\"addedAt\":\"$dev_now\"}"
    for extra_ip in ${EXTRA_IPS:-}; do
      extra_subnet="$(echo "$extra_ip" | awk -F. '{printf "%s.%s.%s.0/24", $1, $2, $3}')"
      allowlist_ips="$allowlist_ips,{\"ip\":\"$extra_ip\",\"subnet\":\"$extra_subnet\",\"email\":\"launcher\",\"addedAt\":\"$dev_now\"}"
    done
    log "Seeding IP allowlist with developer IP ($MY_IP)..."
    remote "printf '%s' '{\"ips\":[$allowlist_ips]}' | \
      docker compose -f /home/ec2-user/agentweb/test-env/docker-compose.yml exec -T test-env-access sh -c 'cat > /app/data/allowlist.json'"
  fi

  # Set up watchdog cron (unless --no-watchdog)
  if [[ "$NO_WATCHDOG" == "true" ]]; then
    log "Skipping inactivity watchdog (--no-watchdog). Instance will run until manually torn down."
  else
    log "Setting up inactivity watchdog..."
    remote "sudo cp /home/ec2-user/agentweb/test-env/watchdog.sh /opt/watchdog.sh && \
      sudo chmod +x /opt/watchdog.sh && \
      echo '0 * * * * /opt/watchdog.sh >> /var/log/watchdog.log 2>&1' | sudo crontab -"
  fi

  echo ""
  log "========================================="
  log " Test environment '$name' is ready!"
  log "========================================="
  echo -e " ${CYAN}Mode:${NC}             $MODE"
  echo -e " ${CYAN}Backend:${NC}          http://$PUBLIC_IP:3001"
  echo -e " ${CYAN}Partner Portal:${NC}   http://$PUBLIC_IP:5173"
  echo -e " ${CYAN}Customer Portal:${NC}  http://$PUBLIC_IP:5174"
  if ! is_dev_mode; then
    echo -e " ${CYAN}IP Allowlist:${NC}     http://$PUBLIC_IP:5175"
  fi
  if is_dev_mode; then
    echo -e " ${CYAN}SSH:${NC}              ssh -A -i $KEY_FILE $SSH_USER@$PUBLIC_IP"
  else
    echo -e " ${CYAN}SSH:${NC}              ssh -i $KEY_FILE $SSH_USER@$PUBLIC_IP"
  fi
  echo ""
  if [[ "$NO_WATCHDOG" == "true" ]]; then
    echo -e " ${YELLOW}Auto-shutdown:${NC}    DISABLED (manual teardown required)"
  else
    echo -e " ${YELLOW}Auto-shutdown:${NC}    After 24 hours of inactivity"
  fi
  echo -e " ${YELLOW}Teardown:${NC}         ./test-env.sh teardown"
  if is_dev_mode; then
    echo ""
    echo -e " ${CYAN}Claude Code:${NC}      SSH in, then run 'claude login' (first time) and 'cd ~/agentweb && claude'"
    echo ""
    echo -e " ${YELLOW}NOTE:${NC} Dev servers auto-reload on file changes. No need to sync after editing on the instance."
    echo -e " ${YELLOW}NOTE:${NC} If you sync from local, commit on-instance changes first (rsync --delete overwrites remote files)."
  fi
  log "========================================="
}

###############################################################################
# teardown
###############################################################################
cmd_teardown() {
  local name
  name="$(resolve_env_name)"
  load_state "$name"

  log "Terminating environment '$name' (instance $INSTANCE_ID)..."
  aws ec2 terminate-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" > /dev/null

  # Delete per-instance security group (must wait for instance to detach)
  if [[ -n "${SG_ID:-}" ]]; then
    log "Waiting for instance to terminate before deleting security group..."
    aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID" --region "$REGION" 2>/dev/null || true
    log "Deleting security group $SG_ID..."
    aws ec2 delete-security-group --group-id "$SG_ID" --region "$REGION" 2>/dev/null || \
      warn "Could not delete security group $SG_ID (may need manual cleanup)"
  fi

  rm -f "$(state_file_for "$name")"
  log "Instance terminated. Environment '$name' removed."
}

###############################################################################
# teardown-all
###############################################################################
cmd_teardown_all() {
  local expected_name
  expected_name="$(resolve_env_name)"
  local sf

  sf="$(state_file_for "$expected_name")"
  if [[ ! -f "$sf" ]]; then
    log "No active environment for this folder."
    return
  fi

  # shellcheck source=/dev/null
  source "$sf"
  if [[ "${ENV_NAME:-}" != "$expected_name" ]]; then
    err "State file mismatch: expected '$expected_name' but found '${ENV_NAME:-}'. Delete $sf and re-launch."
    exit 1
  fi

  log "Terminating '$ENV_NAME' ($INSTANCE_ID)..."
  aws ec2 terminate-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" > /dev/null 2>&1 || warn "Failed to terminate $INSTANCE_ID"

  if [[ -n "${SG_ID:-}" ]]; then
    log "Waiting for instance to terminate before deleting security group..."
    aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID" --region "$REGION" 2>/dev/null || true
    aws ec2 delete-security-group --group-id "$SG_ID" --region "$REGION" 2>/dev/null || \
      warn "Could not delete security group $SG_ID"
  fi

  rm -f "$sf"
  log "Environment terminated."
}

###############################################################################
# sync
###############################################################################
_do_sync() {
  local service="${1:-all}"
  local targets=()

  case "$service" in
    all)
      targets=("backend" "partner-portal" "customer-portal" "test-env-access" "test-env")
      ;;
    backend|partner-portal|customer-portal|test-env-access)
      targets=("$service" "test-env")
      ;;
    *)
      err "Unknown service: $service (use backend, partner-portal, customer-portal, or test-env-access)"
      exit 1
      ;;
  esac

  for target in "${targets[@]}"; do
    local src_path="$REPO_ROOT/$target/"
    if [[ ! -d "$src_path" ]]; then
      warn "Directory not found: $src_path — skipping"
      continue
    fi

    log "Syncing $target..."
    rsync -az --delete \
      --exclude 'node_modules' \
      --exclude 'dist' \
      --exclude '.env' \
      --exclude '.env.*' \
      --exclude 'coverage' \
      --exclude 'logs' \
      --exclude '.git' \
      --exclude '.cache' \
      --exclude '*.log' \
      --exclude 'builds' \
      --exclude '*.zip' \
      --exclude '*.pem' \
      -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $KEY_FILE" \
      "$src_path" "$SSH_USER@$PUBLIC_IP:/home/ec2-user/agentweb/$target/"
  done

  # Also sync .dockerignore from repo root
  rsync -az \
    -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $KEY_FILE" \
    "$REPO_ROOT/.dockerignore" "$SSH_USER@$PUBLIC_IP:/home/ec2-user/agentweb/.dockerignore"
}

_do_sync_dev() {
  local service="${1:-all}"
  local targets=()

  case "$service" in
    all)
      targets=("backend" "partner-portal" "customer-portal" "test-env")
      ;;
    backend|partner-portal|customer-portal)
      targets=("$service")
      ;;
    *)
      err "Unknown service: $service (use backend, partner-portal, or customer-portal)"
      exit 1
      ;;
  esac

  for target in "${targets[@]}"; do
    local src_path="$REPO_ROOT/$target/"
    if [[ ! -d "$src_path" ]]; then
      warn "Directory not found: $src_path — skipping"
      continue
    fi

    log "Syncing $target..."
    rsync -az --delete \
      --exclude 'node_modules' \
      --exclude 'dist' \
      --exclude '.env' \
      --exclude '.env.local' \
      --exclude '.env.*.local' \
      --exclude 'coverage' \
      --exclude 'logs' \
      --exclude '.cache' \
      --exclude '*.log' \
      --exclude 'builds' \
      --exclude '*.zip' \
      --exclude '*.pem' \
      -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $KEY_FILE" \
      "$src_path" "$SSH_USER@$PUBLIC_IP:/home/ec2-user/agentweb/$target/"
  done

  # On full sync, also sync repo-root files needed for development
  if [[ "$service" == "all" ]]; then
    log "Syncing repo-root .git/ directory..."
    rsync -az \
      -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $KEY_FILE" \
      "$REPO_ROOT/.git/" "$SSH_USER@$PUBLIC_IP:/home/ec2-user/agentweb/.git/"

    log "Syncing repo-root files..."
    for f in CLAUDE.md .gitignore; do
      if [[ -f "$REPO_ROOT/$f" ]]; then
        rsync -az \
          -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $KEY_FILE" \
          "$REPO_ROOT/$f" "$SSH_USER@$PUBLIC_IP:/home/ec2-user/agentweb/$f"
      fi
    done

    # Sync .claude/ directory if it exists
    if [[ -d "$REPO_ROOT/.claude" ]]; then
      rsync -az \
        -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i $KEY_FILE" \
        "$REPO_ROOT/.claude/" "$SSH_USER@$PUBLIC_IP:/home/ec2-user/agentweb/.claude/"
    fi
  fi
}

cmd_sync() {
  local name
  name="$(resolve_env_name)"
  load_state "$name"

  local service="${1:-all}"

  if is_dev_mode; then
    _do_sync_dev "$service"
    log "Sync complete. Dev servers will auto-reload changed files."
    if [[ "$service" == "all" ]]; then
      warn "If package.json changed, SSH in and run 'npm ci' in the affected service directory."
    fi
    return
  fi

  _do_sync "$service"

  # Rebuild and restart affected containers
  if [[ "$service" == "all" ]]; then
    log "Rebuilding all services..."
    remote "cd /home/ec2-user/agentweb/test-env && \
      export PUBLIC_IP='$PUBLIC_IP' && \
      export SG_ID='$SG_ID' && \
      export AWS_REGION='$REGION' && \
      docker compose up -d --build"
  else
    log "Rebuilding $service..."
    remote "cd /home/ec2-user/agentweb/test-env && \
      export PUBLIC_IP='$PUBLIC_IP' && \
      export SG_ID='$SG_ID' && \
      export AWS_REGION='$REGION' && \
      docker compose up -d --build $service"
  fi

  log "Sync complete."
}

###############################################################################
# status
###############################################################################
cmd_status() {
  local name
  name="$(resolve_env_name)"
  load_state "$name"

  local state
  state=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo "unknown")

  echo -e "${CYAN}Environment:${NC} $name"
  echo -e "${CYAN}Instance:${NC}    $INSTANCE_ID"
  echo -e "${CYAN}State:${NC}       $state"
  echo -e "${CYAN}IP:${NC}          $PUBLIC_IP"
  echo -e "${CYAN}Mode:${NC}        ${MODE:-docker}"
  echo -e "${CYAN}Launched:${NC}    $LAUNCH_TIME"

  if [[ "$state" == "running" ]]; then
    echo ""
    echo -e "${CYAN}Services:${NC}"
    if is_dev_mode; then
      remote "/home/ec2-user/agentweb/test-env/dev-services.sh status" 2>/dev/null || \
        warn "Could not reach instance"
    else
      remote "cd /home/ec2-user/agentweb/test-env && docker compose ps" 2>/dev/null || \
        warn "Could not reach instance"
    fi
  fi
}

###############################################################################
# list
###############################################################################
cmd_list() {
  local name
  name="$(resolve_env_name)"
  local sf
  sf="$(state_file_for "$name")"

  if [[ ! -f "$sf" ]]; then
    log "No active environment for this folder."
    return
  fi

  # shellcheck source=/dev/null
  source "$sf"

  printf "${CYAN}%-25s %-22s %-16s %s${NC}\n" "NAME" "INSTANCE" "IP" "LAUNCHED"
  printf "%-25s %-22s %-16s %s\n" "----" "--------" "--" "--------"
  printf "%-25s %-22s %-16s %s\n" "$ENV_NAME" "$INSTANCE_ID" "$PUBLIC_IP" "$LAUNCH_TIME"
}

###############################################################################
# allow-ip / revoke-ip
###############################################################################
cmd_allow_ip() {
  local name
  name="$(resolve_env_name)"
  load_state "$name"

  local ip="${1:-}"
  if [[ -z "$ip" ]]; then
    err "Usage: test-env.sh allow-ip <IP_ADDRESS>"
    exit 1
  fi

  # Strip trailing /32 if provided
  ip="${ip%/32}"

  if [[ -z "${SG_ID:-}" ]]; then
    err "No security group found in state. Re-launch the environment."
    exit 1
  fi

  log "Allowing $ip access to environment '$name' (SG: $SG_ID)..."
  for PORT in 22 3001 5173 5174; do
    aws ec2 authorize-security-group-ingress \
      --group-id "$SG_ID" \
      --protocol tcp \
      --port "$PORT" \
      --cidr "$ip/32" \
      --region "$REGION" > /dev/null 2>&1 || true
  done

  log "Done. $ip can now access:"
  echo -e " ${CYAN}Backend:${NC}          http://$PUBLIC_IP:3001"
  echo -e " ${CYAN}Partner Portal:${NC}   http://$PUBLIC_IP:5173"
  echo -e " ${CYAN}Customer Portal:${NC}  http://$PUBLIC_IP:5174"
  echo -e " ${CYAN}IP Allowlist:${NC}     http://$PUBLIC_IP:5175"
}

cmd_revoke_ip() {
  local name
  name="$(resolve_env_name)"
  load_state "$name"

  local ip="${1:-}"
  if [[ -z "$ip" ]]; then
    err "Usage: test-env.sh revoke-ip <IP_ADDRESS>"
    exit 1
  fi

  ip="${ip%/32}"

  if [[ -z "${SG_ID:-}" ]]; then
    err "No security group found in state. Re-launch the environment."
    exit 1
  fi

  log "Revoking $ip access from environment '$name' (SG: $SG_ID)..."
  for PORT in 22 3001 5173 5174; do
    aws ec2 revoke-security-group-ingress \
      --group-id "$SG_ID" \
      --protocol tcp \
      --port "$PORT" \
      --cidr "$ip/32" \
      --region "$REGION" > /dev/null 2>&1 || true
  done

  log "Done. $ip access revoked."
}

###############################################################################
# ssh
###############################################################################
cmd_ssh() {
  local name
  name="$(resolve_env_name)"
  load_state "$name"
  if is_dev_mode; then
    # -A enables SSH agent forwarding for git push/pull on the instance
    exec ssh -A -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
         -i "$KEY_FILE" "$SSH_USER@$PUBLIC_IP"
  else
    exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
         -i "$KEY_FILE" "$SSH_USER@$PUBLIC_IP"
  fi
}

###############################################################################
# claude — run Claude Code on the instance with an optional message
###############################################################################
cmd_claude() {
  local name
  name="$(resolve_env_name)"
  load_state "$name"

  if ! is_dev_mode; then
    err "The 'claude' command is only available in dev mode (launch with --dev)."
    exit 1
  fi

  local message="$*"
  if [[ -n "$message" ]]; then
    # Run Claude Code with a prompt (non-interactive, streams output back)
    ssh -A -t -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -i "$KEY_FILE" "$SSH_USER@$PUBLIC_IP" \
        "source ~/.bashrc && cd /home/ec2-user/agentweb && claude --model us.anthropic.claude-sonnet-4-6 --permission-mode auto -p $(printf '%q' "$message")"
  else
    # Interactive Claude Code session
    ssh -A -t -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR -i "$KEY_FILE" "$SSH_USER@$PUBLIC_IP" \
        "source ~/.bashrc && cd /home/ec2-user/agentweb && claude"
  fi
}

###############################################################################
# logs
###############################################################################
cmd_logs() {
  local name
  name="$(resolve_env_name)"
  load_state "$name"

  local service="${1:-}"
  if is_dev_mode; then
    if [[ -n "$service" ]]; then
      remote "tail -f /home/ec2-user/agentweb/logs/$service.log"
    else
      remote "tail -f /home/ec2-user/agentweb/logs/backend.log /home/ec2-user/agentweb/logs/partner-portal.log /home/ec2-user/agentweb/logs/customer-portal.log"
    fi
  else
    if [[ -n "$service" ]]; then
      remote "cd /home/ec2-user/agentweb/test-env && docker compose logs --tail=100 -f $service"
    else
      remote "cd /home/ec2-user/agentweb/test-env && docker compose logs --tail=100 -f"
    fi
  fi
}

###############################################################################
# Main — dispatch command
###############################################################################
CMD="${1:-help}"
shift || true

case "$CMD" in
  launch)       cmd_launch "$@" ;;
  teardown)     cmd_teardown ;;
  teardown-all) cmd_teardown_all ;;
  sync)         cmd_sync "${1:-all}" ;;
  status)       cmd_status ;;
  list)         cmd_list ;;
  allow-ip)     cmd_allow_ip "${1:-}" ;;
  revoke-ip)    cmd_revoke_ip "${1:-}" ;;
  ssh)          cmd_ssh ;;
  claude)       cmd_claude "$@" ;;
  logs)         cmd_logs "${1:-}" ;;
  help|*)
    echo "Usage: test-env.sh <command> [options]"
    echo ""
    echo "Commands:"
    echo "  launch       Launch a new test environment"
    echo "  teardown     Terminate a test environment"
    echo "  teardown-all Terminate ALL test environments"
    echo "  sync         Sync code [backend|partner-portal|customer-portal|test-env-access|all]"
    echo "  status       Show environment status"
    echo "  list         List all active environments"
    echo "  allow-ip IP  Grant another IP access to this environment"
    echo "  revoke-ip IP Revoke an IP's access"
    echo "  ssh          Open SSH session to the instance"
    echo "  claude [msg] Run Claude Code on instance (dev mode only)"
    echo "  logs         View service logs [service]"
    echo ""
    echo "Launch flags:"
    echo "  --dev            Dev mode: hot-reload dev servers + Claude Code (no Docker)"
    echo "  --key-name K     EC2 key pair name"
    echo "  --key-file F     Path to private key file"
    echo "  --instance-type T  Instance type (default: t3.large, dev mode: t3.2xlarge)"
    echo "  --no-watchdog    Disable auto-shutdown watchdog"
    echo ""
    echo "The environment name is derived automatically from your AWS username"
    echo "and the repo folder name (e.g., myuser-agentweb)."
    echo ""
    echo "By default, only the developer's IP (detected at launch) can access"
    echo "the instance. Use 'allow-ip' to grant access to others."
    echo ""
    echo "Modes:"
    echo "  Docker (default): 4 Docker containers, sync + rebuild cycle"
    echo "  Dev (--dev):      Hot-reload dev servers, Claude Code CLI installed"
    echo "                    SSH in and use 'claude' to develop in the cloud"
    echo ""
    echo "Examples:"
    echo "  ./test-env.sh launch                    # launch Docker environment"
    echo "  ./test-env.sh launch --dev              # launch dev environment"
    echo "  ./test-env.sh launch --no-watchdog      # launch without auto-shutdown"
    echo "  ./test-env.sh claude                    # interactive Claude Code (dev mode)"
    echo "  ./test-env.sh claude 'fix the login bug'  # run Claude with a prompt"
    echo "  ./test-env.sh sync                      # sync all services"
    echo "  ./test-env.sh sync backend              # sync just backend"
    echo "  ./test-env.sh allow-ip 203.0.113.50     # grant IP access"
    echo "  ./test-env.sh revoke-ip 203.0.113.50    # revoke IP access"
    echo "  ./test-env.sh list                      # show all environments"
    echo "  ./test-env.sh teardown                  # terminate environment"
    echo "  ./test-env.sh teardown-all              # terminate everything"
    echo ""
    echo "Configuration:"
    echo "  Create .test-env.config in repo root with:"
    echo "    KEY_NAME=my-keypair"
    echo "    KEY_FILE=~/.ssh/my-keypair.pem"
    echo "    INSTANCE_TYPE=t3.large    # optional, default: t3.large"
    ;;
esac
