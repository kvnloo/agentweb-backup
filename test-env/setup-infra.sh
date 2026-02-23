#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# setup-infra.sh — One-time setup of AWS resources for test-env
#
# Creates:
#   1. Secrets Manager secret for backend .env
#   2. IAM role + instance profile for EC2 (Secrets Manager read access)
#   3. Security group with ports 22, 3001, 5173, 5174
#
# Run once by an admin. Developers only need launch/teardown permissions.
###############################################################################

REGION="${AWS_REGION:-us-west-2}"
SECRET_NAME="agentweb/test-env/backend-env"
SECRET_NAME_ACCESS="agentweb/test-env/test-env-access-env"
ROLE_NAME="agentweb-test-env-ec2-role"
PROFILE_NAME="agentweb-test-env-profile"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
err()  { echo -e "${RED}[setup]${NC} $*" >&2; }

###############################################################################
# 1. Secrets Manager secret
###############################################################################
log "=== Secrets Manager ==="

if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --region "$REGION" &>/dev/null; then
  log "Secret '$SECRET_NAME' already exists."
  echo ""
  warn "To update it, run:"
  warn "  aws secretsmanager put-secret-value \\"
  warn "    --secret-id '$SECRET_NAME' \\"
  warn "    --secret-string \"\$(cat backend/.env)\" \\"
  warn "    --region $REGION"
else
  log "Creating secret '$SECRET_NAME'..."

  if [[ -f "backend/.env" ]]; then
    aws secretsmanager create-secret \
      --name "$SECRET_NAME" \
      --description "Backend .env for test environments" \
      --secret-string "$(cat backend/.env)" \
      --region "$REGION" > /dev/null
    log "Secret created from backend/.env"
  else
    aws secretsmanager create-secret \
      --name "$SECRET_NAME" \
      --description "Backend .env for test environments" \
      --secret-string "PLACEHOLDER — update with real .env content" \
      --region "$REGION" > /dev/null
    warn "Secret created with placeholder. Update it with:"
    warn "  aws secretsmanager put-secret-value \\"
    warn "    --secret-id '$SECRET_NAME' \\"
    warn "    --secret-string \"\$(cat backend/.env)\" \\"
    warn "    --region $REGION"
  fi
fi
echo ""

log "=== Secrets Manager (test-env-access) ==="

if aws secretsmanager describe-secret --secret-id "$SECRET_NAME_ACCESS" --region "$REGION" &>/dev/null; then
  log "Secret '$SECRET_NAME_ACCESS' already exists."
  echo ""
  warn "To update it, run:"
  warn "  aws secretsmanager put-secret-value \\"
  warn "    --secret-id '$SECRET_NAME_ACCESS' \\"
  warn "    --secret-string \"\$(cat test-env-access/.env)\" \\"
  warn "    --region $REGION"
else
  log "Creating secret '$SECRET_NAME_ACCESS'..."

  if [[ -f "test-env-access/.env" ]]; then
    aws secretsmanager create-secret \
      --name "$SECRET_NAME_ACCESS" \
      --description "test-env-access .env (Resend API key) for test environments" \
      --secret-string "$(cat test-env-access/.env)" \
      --region "$REGION" > /dev/null
    log "Secret created from test-env-access/.env"
  else
    aws secretsmanager create-secret \
      --name "$SECRET_NAME_ACCESS" \
      --description "test-env-access .env (Resend API key) for test environments" \
      --secret-string "RESEND_API_KEY=re_xxxx" \
      --region "$REGION" > /dev/null
    warn "Secret created with placeholder. Update it with:"
    warn "  aws secretsmanager put-secret-value \\"
    warn "    --secret-id '$SECRET_NAME_ACCESS' \\"
    warn "    --secret-string \"\$(cat test-env-access/.env)\" \\"
    warn "    --region $REGION"
  fi
fi
echo ""

###############################################################################
# 2. IAM role + instance profile
###############################################################################
log "=== IAM Role & Instance Profile ==="

# Trust policy — allow EC2 to assume the role
TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ec2.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}'

# Permissions — read the specific secret
PERMISSIONS_POLICY='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": [
        "arn:aws:secretsmanager:'"$REGION"':'"$ACCOUNT_ID"':secret:'"$SECRET_NAME"'*",
        "arn:aws:secretsmanager:'"$REGION"':'"$ACCOUNT_ID"':secret:'"$SECRET_NAME_ACCESS"'*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["ec2:AuthorizeSecurityGroupIngress"],
      "Resource": "arn:aws:ec2:'"$REGION"':'"$ACCOUNT_ID"':security-group/*",
      "Condition": {
        "StringEquals": { "ec2:ResourceTag/purpose": "test-env" }
      }
    }
  ]
}'

if aws iam get-role --role-name "$ROLE_NAME" &>/dev/null; then
  log "IAM role '$ROLE_NAME' already exists."
else
  log "Creating IAM role '$ROLE_NAME'..."
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "EC2 role for agentweb test environments" > /dev/null
  log "IAM role created."
fi

# Always update the inline policy to ensure it covers all secrets
log "Updating IAM policy on '$ROLE_NAME'..."
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "test-env-secrets-access" \
  --policy-document "$PERMISSIONS_POLICY"
log "IAM policy updated (Secrets Manager read access)."

if aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" &>/dev/null; then
  log "Instance profile '$PROFILE_NAME' already exists."
else
  log "Creating instance profile '$PROFILE_NAME'..."
  aws iam create-instance-profile \
    --instance-profile-name "$PROFILE_NAME" > /dev/null

  aws iam add-role-to-instance-profile \
    --instance-profile-name "$PROFILE_NAME" \
    --role-name "$ROLE_NAME"

  log "Instance profile created."
  warn "Note: IAM propagation may take ~10 seconds before launch works."
fi
echo ""

###############################################################################
# 3. Security groups (info only — created per-instance at launch time)
###############################################################################
log "=== Security Groups ==="
log "Per-instance security groups are created at launch time, locked to the"
log "developer's IP. No shared security group is needed."
echo ""

###############################################################################
# Summary
###############################################################################
log "========================================="
log " Infrastructure setup complete!"
log "========================================="
echo ""
echo "  Secret:           $SECRET_NAME"
echo "  IAM Role:         $ROLE_NAME"
echo "  Instance Profile: $PROFILE_NAME"
echo "  Security Groups:  Created per-instance at launch (IP-restricted)"
echo ""
echo "Next steps for developers:"
echo "  1. Create .test-env.config with their SSH key pair:"
echo "       KEY_NAME=my-keypair"
echo "       KEY_FILE=~/.ssh/my-keypair.pem"
echo "  2. Run: ./test-env/test-env.sh launch"
echo ""
