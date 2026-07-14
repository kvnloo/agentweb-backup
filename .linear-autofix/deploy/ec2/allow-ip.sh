#!/usr/bin/env bash
# allow-ip.sh — grant (or revoke) inbound SSH for an additional IP on the poller's
# security group. Run from any machine with AWS CLI access to the same account+region.
#
#   bash allow-ip.sh                      # allow the CALLER's current public IP
#   bash allow-ip.sh 203.0.113.7          # allow a specific IP (a teammate's)
#   bash allow-ip.sh 203.0.113.7 --revoke # remove that IP again
#   OPEN_PREVIEW_PORT=true bash allow-ip.sh 203.0.113.7   # also open the preview ports (5173/5174/3001)
#
# NOTE: opening the network is only half of access — the user still needs an SSH
# credential the box accepts (the key pair .pem, or their public key in ec2-user's
# authorized_keys). See RUNBOOK.md "Granting access to other users".
set -euo pipefail

REGION="${REGION:-us-west-2}"
SG_NAME="${SG_NAME:-linear-autofix-sg}"
PREVIEW_PORTS="${PREVIEW_PORTS:-5173 5174 3001}"   # partner/customer/API — must match config.mjs previewPorts
OPEN_PREVIEW_PORT="${OPEN_PREVIEW_PORT:-false}"

IP=""
ACTION="authorize"
for a in "$@"; do
  case "$a" in
    --revoke) ACTION="revoke" ;;
    *)        IP="$a" ;;
  esac
done
[ -z "$IP" ] && IP="$(curl -fsSL https://checkip.amazonaws.com)"
CIDR="${IP}/32"

VPC_ID="$(aws ec2 --region "$REGION" describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"
SG_ID="$(aws ec2 --region "$REGION" describe-security-groups \
  --filters Name=group-name,Values="$SG_NAME" Name=vpc-id,Values="$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"
if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
  echo "Security group '$SG_NAME' not found in $REGION." >&2; exit 1
fi

echo "==> ${ACTION} SSH for $CIDR on $SG_ID ($SG_NAME)"
apply() {  # $1 = port
  local out
  if out="$(aws ec2 --region "$REGION" "${ACTION}-security-group-ingress" \
       --group-id "$SG_ID" --protocol tcp --port "$1" --cidr "$CIDR" 2>&1)"; then
    echo "    port $1: ${ACTION}d"
  elif echo "$out" | grep -qiE 'Duplicate|NotFound|does not exist'; then
    echo "    port $1: already in desired state"
  else
    echo "$out" >&2; return 1
  fi
}
apply 22
[ "$OPEN_PREVIEW_PORT" = true ] && for p in $PREVIEW_PORTS; do apply "$p"; done
echo "==> done"
