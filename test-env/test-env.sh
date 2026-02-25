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
#   ./test-env.sh launch   [--key-name K] [--key-file F] [--instance-type T] [--no-watchdog]
#   ./test-env.sh teardown
#   ./test-env.sh sync     [backend|partner-portal|customer-portal|test-env-access]
#   ./test-env.sh status
#   ./test-env.sh allow-ip <IP>         # grant another IP access
#   ./test-env.sh revoke-ip <IP>        # revoke an IP's access
#   ./test-env.sh ssh
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
LAUNCH_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
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

  # Parse flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --key-name)      KEY_NAME="$2"; shift 2 ;;
      --key-file)      KEY_FILE="$2"; shift 2 ;;
      --instance-type) INSTANCE_TYPE="$2"; shift 2 ;;
      --no-watchdog)   NO_WATCHDOG=true; shift ;;
      *) err "Unknown flag: $1"; exit 1 ;;
    esac
  done

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
  aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp \
    --port 5175 \
    --cidr "0.0.0.0/0" \
    --region "$REGION" > /dev/null
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

  log "Launching EC2 instance ($INSTANCE_TYPE)..."
  INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --iam-instance-profile "Name=$PROFILE_NAME" \
    --instance-initiated-shutdown-behavior terminate \
    --user-data "file://$SCRIPT_DIR/user-data.sh" \
    --tag-specifications "ResourceType=instance,Tags=[
      {Key=Name,Value=agentweb-test-env-$(whoami)-${name}},
      {Key=purpose,Value=test-env},
      {Key=creator,Value=$(whoami)},
      {Key=env-name,Value=${name}}
    ]" \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
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

  # Wait for user-data to finish (Docker installed)
  log "Waiting for Docker setup to complete..."
  for i in $(seq 1 60); do
    if remote "test -f /home/ec2-user/.test-env-ready" 2>/dev/null; then
      break
    fi
    if [[ $i -eq 60 ]]; then
      err "Docker setup timeout"
      exit 1
    fi
    sleep 10
  done

  log "Instance ready. Syncing code..."
  _do_sync "all"

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

  # Seed IP allowlist with developer's IP so the UI shows correct status
  local dev_subnet dev_now
  dev_subnet="$(echo "$MY_IP" | awk -F. '{printf "%s.%s.%s.0/24", $1, $2, $3}')"
  dev_now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "Seeding IP allowlist with developer IP ($MY_IP)..."
  remote "printf '%s' '{\"ips\":[{\"ip\":\"$MY_IP\",\"subnet\":\"$dev_subnet\",\"email\":\"launcher\",\"addedAt\":\"$dev_now\"}]}' | \
    docker compose -f /home/ec2-user/agentweb/test-env/docker-compose.yml exec -T test-env-access sh -c 'cat > /app/data/allowlist.json'"

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
  echo -e " ${CYAN}Backend:${NC}          http://$PUBLIC_IP:3001"
  echo -e " ${CYAN}Partner Portal:${NC}   http://$PUBLIC_IP:5173"
  echo -e " ${CYAN}Customer Portal:${NC}  http://$PUBLIC_IP:5174"
  echo -e " ${CYAN}IP Allowlist:${NC}     http://$PUBLIC_IP:5175"
  echo -e " ${CYAN}SSH:${NC}              ssh -i $KEY_FILE $SSH_USER@$PUBLIC_IP"
  echo ""
  if [[ "$NO_WATCHDOG" == "true" ]]; then
    echo -e " ${YELLOW}Auto-shutdown:${NC}    DISABLED (manual teardown required)"
  else
    echo -e " ${YELLOW}Auto-shutdown:${NC}    After 24 hours of inactivity"
  fi
  echo -e " ${YELLOW}Teardown:${NC}         ./test-env.sh teardown"
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

cmd_sync() {
  local name
  name="$(resolve_env_name)"
  load_state "$name"

  local service="${1:-all}"
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
  echo -e "${CYAN}Launched:${NC}    $LAUNCH_TIME"

  if [[ "$state" == "running" ]]; then
    echo ""
    echo -e "${CYAN}Services:${NC}"
    remote "cd /home/ec2-user/agentweb/test-env && docker compose ps" 2>/dev/null || \
      warn "Could not reach instance"
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
  exec ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
       -i "$KEY_FILE" "$SSH_USER@$PUBLIC_IP"
}

###############################################################################
# logs
###############################################################################
cmd_logs() {
  local name
  name="$(resolve_env_name)"
  load_state "$name"

  local service="${1:-}"
  if [[ -n "$service" ]]; then
    remote "cd /home/ec2-user/agentweb/test-env && docker compose logs --tail=100 -f $service"
  else
    remote "cd /home/ec2-user/agentweb/test-env && docker compose logs --tail=100 -f"
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
  logs)         cmd_logs "${1:-}" ;;
  help|*)
    echo "Usage: test-env.sh <command> [options]"
    echo ""
    echo "Commands:"
    echo "  launch       Launch a new test environment"
    echo "  teardown     Terminate a test environment"
    echo "  teardown-all Terminate ALL test environments"
    echo "  sync         Sync code and rebuild [backend|partner-portal|customer-portal|test-env-access|all]"
    echo "  status       Show environment status"
    echo "  list         List all active environments"
    echo "  allow-ip IP  Grant another IP access to this environment"
    echo "  revoke-ip IP Revoke an IP's access"
    echo "  ssh          Open SSH session to the instance"
    echo "  logs         View container logs [service]"
    echo ""
    echo "The environment name is derived automatically from your AWS username"
    echo "and the repo folder name (e.g., myuser-agentweb)."
    echo ""
    echo "By default, only the developer's IP (detected at launch) can access"
    echo "the instance. Use 'allow-ip' to grant access to others."
    echo ""
    echo "Examples:"
    echo "  ./test-env.sh launch                    # launch environment"
    echo "  ./test-env.sh launch --no-watchdog      # launch without auto-shutdown"
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
