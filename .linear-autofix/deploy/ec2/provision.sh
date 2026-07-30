#!/usr/bin/env bash
# provision.sh — launch a dedicated EC2 instance for the Linear -> Claude auto-fix poller.
#
# Run this from your LAPTOP with the AWS CLI configured (a profile allowed to create
# EC2 instances, security groups, and key pairs). It provisions a t3.xlarge Amazon
# Linux 2023 box sized for the FULL scope (poller + browser-verify previews), locks
# SSH to your current public IP, and prints the SSH command.
#
# By default only SSH (22) is opened. The automated browser-verify runs Playwright ON
# the instance over loopback, so no inbound app port is needed. Set OPEN_PREVIEW_PORT=true
# only if you want to open the nip.io preview proxy port to your IP for MANUAL browsing.
set -euo pipefail

REGION="${REGION:-us-west-2}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.xlarge}"   # 16 GB RAM: backend + 2 Vite dev servers + Chromium + claude
VOLUME_GB="${VOLUME_GB:-100}"                 # kept worktrees + 3x node_modules accumulate
KEY_NAME="${KEY_NAME:-linear-autofix}"
SG_NAME="${SG_NAME:-linear-autofix-sg}"
NAME_TAG="${NAME_TAG:-linear-autofix}"
# The scoped account IAM policy only authorizes ec2:RunInstances for instances tagged
# purpose=test-env, so this tag is REQUIRED to launch (teardown/watchdog target instances by
# id, not by this tag, so the poller is not swept). Override PURPOSE_TAG= to drop it if your
# identity has unconditional RunInstances.
PURPOSE_TAG="${PURPOSE_TAG-test-env}"
# Reuse the cloud test-env instance profile by default: it grants the backend preview
# Dev-AW-* DynamoDB read/write + Secrets Manager read on agentweb/test-env/* (so bootstrap
# can pull backend/.env). Same role the test-env uses. Set IAM_PROFILE= (empty) for none.
IAM_PROFILE="${IAM_PROFILE-agentweb-test-env-profile}"
OPEN_PREVIEW_PORT="${OPEN_PREVIEW_PORT:-false}"
PREVIEW_PORTS="${PREVIEW_PORTS:-5173 5174 3001}"   # partner/customer/API — must match config.mjs previewPorts

echo "==> Region=$REGION  type=$INSTANCE_TYPE  disk=${VOLUME_GB}GB"

MYIP="$(curl -fsSL https://checkip.amazonaws.com)/32"
echo "==> Locking SSH$([ "$OPEN_PREVIEW_PORT" = true ] && echo " + preview [$PREVIEW_PORTS]") to $MYIP"

AMI_ID="$(aws ec2 --region "$REGION" describe-images \
  --owners amazon \
  --filters "Name=name,Values=al2023-ami-*-x86_64" "Name=state,Values=available" \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text 2>/dev/null || true)"
if [ -z "$AMI_ID" ] || [ "$AMI_ID" = "None" ]; then
  # Fallback to the SSM public parameter for the latest AL2023 AMI.
  AMI_ID="$(aws ssm get-parameter --region "$REGION" \
    --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
    --query 'Parameter.Value' --output text)"
fi
echo "==> AMI=$AMI_ID"

# --- Key pair (create + save private key if it doesn't exist) ---
if ! aws ec2 --region "$REGION" describe-key-pairs --key-names "$KEY_NAME" >/dev/null 2>&1; then
  aws ec2 --region "$REGION" create-key-pair --key-name "$KEY_NAME" \
    --query 'KeyMaterial' --output text > "$HOME/.ssh/${KEY_NAME}.pem"
  chmod 600 "$HOME/.ssh/${KEY_NAME}.pem"
  echo "==> Created key pair -> ~/.ssh/${KEY_NAME}.pem"
else
  echo "==> Reusing key pair '$KEY_NAME' (you need ~/.ssh/${KEY_NAME}.pem locally)"
fi

# --- Security group in the default VPC ---
VPC_ID="$(aws ec2 --region "$REGION" describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"
SG_ID="$(aws ec2 --region "$REGION" describe-security-groups \
  --filters Name=group-name,Values="$SG_NAME" Name=vpc-id,Values="$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"
if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID="$(aws ec2 --region "$REGION" create-security-group --group-name "$SG_NAME" \
    --description "Linear autofix poller" --vpc-id "$VPC_ID" --query 'GroupId' --output text)"
  echo "==> Created SG $SG_ID"
else
  echo "==> Reusing SG $SG_ID"
fi
aws ec2 --region "$REGION" authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol tcp --port 22 --cidr "$MYIP" 2>/dev/null || true
if [ "$OPEN_PREVIEW_PORT" = true ]; then
  for p in $PREVIEW_PORTS; do
    aws ec2 --region "$REGION" authorize-security-group-ingress --group-id "$SG_ID" \
      --protocol tcp --port "$p" --cidr "$MYIP" 2>/dev/null || true
  done
fi

# --- Launch ---
TAGS="{Key=Name,Value=${NAME_TAG}}"
[ -n "$PURPOSE_TAG" ] && TAGS="${TAGS},{Key=purpose,Value=${PURPOSE_TAG}},{Key=env-name,Value=${NAME_TAG}}"
RUN_ARGS=(--region "$REGION" --image-id "$AMI_ID" --instance-type "$INSTANCE_TYPE"
  --key-name "$KEY_NAME" --security-group-ids "$SG_ID"
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=${VOLUME_GB},VolumeType=gp3}"
  --tag-specifications "ResourceType=instance,Tags=[${TAGS}]")
[ -n "$IAM_PROFILE" ] && RUN_ARGS+=(--iam-instance-profile "Name=$IAM_PROFILE")

IID="$(aws ec2 run-instances "${RUN_ARGS[@]}" --query 'Instances[0].InstanceId' --output text)"
echo "==> Launched $IID — waiting for running state..."
aws ec2 --region "$REGION" wait instance-running --instance-ids "$IID"
PUBIP="$(aws ec2 --region "$REGION" describe-instances --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"

cat <<EOF

==> READY
    Instance : $IID
    Public IP: $PUBIP
    SSH      : ssh -i ~/.ssh/${KEY_NAME}.pem ec2-user@${PUBIP}

Next:
  scp -i ~/.ssh/${KEY_NAME}.pem .linear-autofix/deploy/ec2/bootstrap.sh ec2-user@${PUBIP}:~
  ssh -i ~/.ssh/${KEY_NAME}.pem ec2-user@${PUBIP} 'bash ~/bootstrap.sh'
Then follow RUNBOOK.md (subscription login, gh auth, Linear key, app creds, cron).
Note: bootstrap.sh installs + enables the systemd unit for the long-running chat/WATCH server
(autofix-chat.service — Restart=on-failure, starts on boot). Cron still drives poll.mjs/gc.mjs.
EOF
