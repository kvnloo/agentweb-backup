#!/usr/bin/env bash
# ENG-1870: provision only the dedicated evaluation table. No existing data is changed.
set -euo pipefail
region="${AWS_REGION:-us-west-2}"
case "${1:-}" in
  dev) table=Dev-AW-Evaluations ;;
  prod) table=AW-Evaluations ;;
  *) echo 'Usage: provision-evaluation-storage.sh dev|prod' >&2; exit 2 ;;
esac
evidence=$(mktemp)
errors=$(mktemp)
trap 'rm -f "$evidence" "$errors"' EXIT
if ! aws --region "$region" dynamodb describe-table --table-name "$table" --output json >"$evidence" 2>"$errors"; then
  if ! rg -q ResourceNotFoundException "$errors"; then cat "$errors" >&2; exit 1; fi
  aws --region "$region" dynamodb create-table --table-name "$table" \
    --attribute-definitions AttributeName=evaluationKey,AttributeType=S \
    --key-schema AttributeName=evaluationKey,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST --sse-specification Enabled=true \
    --deletion-protection-enabled --tags Key=Issue,Value=ENG-1870 Key=Purpose,Value=evaluation-workspaces \
    --query 'TableDescription.{Name:TableName,Status:TableStatus}' --output json
fi
aws --region "$region" dynamodb wait table-exists --table-name "$table"
aws --region "$region" dynamodb describe-table --table-name "$table" --output json >"$evidence"
python3 - "$evidence" <<'PY'
import json, sys
table = json.load(open(sys.argv[1]))['Table']
assert table['KeySchema'] == [{'AttributeName': 'evaluationKey', 'KeyType': 'HASH'}], 'Unexpected key schema'
assert table['AttributeDefinitions'] == [{'AttributeName': 'evaluationKey', 'AttributeType': 'S'}], 'Unexpected key type'
assert table['BillingModeSummary']['BillingMode'] == 'PAY_PER_REQUEST', 'Unexpected billing mode'
assert table.get('DeletionProtectionEnabled') is True, 'Deletion protection is required'
assert table.get('SSEDescription', {}).get('Status') == 'ENABLED', 'Encryption is required'
PY
aws --region "$region" dynamodb update-continuous-backups --table-name "$table" \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text
aws --region "$region" dynamodb describe-table --table-name "$table" \
  --query 'Table.{Name:TableName,Status:TableStatus,DeletionProtection:DeletionProtectionEnabled,Encryption:SSEDescription.Status}' --output json
