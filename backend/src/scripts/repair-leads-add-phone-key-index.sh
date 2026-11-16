#!/usr/bin/env bash
# ENG-2123: create the sparse PhoneKeyIndex on AW-Leads (HASH listId, RANGE phoneKey, KEYS_ONLY).
#
# This is a production schema change: it needs dynamodb:UpdateTable on the table. Idempotent - safe to
# re-run; it skips an index that is already ACTIVE and just waits for one that is still building.
#
# Run it AFTER the PR that writes `phoneKey` is deployed everywhere and AFTER the attribute backfill
# (backend/src/scripts/backfill-lead-phone-key.ts --apply): DynamoDB then indexes every item that already
# carries phoneKey in a single pass and the index is complete the moment it turns ACTIVE.
#
# Usage:
#   DRY_RUN=1 ./repair-leads-add-phone-key-index.sh                    # print the command, change nothing
#   TABLE=Dev-AW-Leads ./repair-leads-add-phone-key-index.sh           # the shared dev table
#   ./repair-leads-add-phone-key-index.sh                              # prod (TABLE=AW-Leads)
#
# Env: TABLE (default AW-Leads), AWS_REGION (default us-west-2), POLL_SECS (default 30), DRY_RUN (1 = no changes)
#
# Notes from the DynamoDB docs: only one GSI can be created per UpdateTable call and no other index can be
# added or removed while it builds; the table stays available; an item whose phoneKey is "" is silently left
# out of the index and, once the index is ACTIVE, writes that violate the key schema are REJECTED - the
# application never writes an empty phoneKey. The base-table reads for the build are not billed.

set -euo pipefail

TABLE="${TABLE:-AW-Leads}"
AWS_REGION="${AWS_REGION:-us-west-2}"
POLL_SECS="${POLL_SECS:-30}"
DRY_RUN="${DRY_RUN:-0}"
INDEX="PhoneKeyIndex"

aws_dynamodb() { aws dynamodb --region "$AWS_REGION" "$@"; }

index_status() {
  aws_dynamodb describe-table --table-name "$TABLE" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='${INDEX}'].IndexStatus | [0]" --output text
}
index_backfilling() {
  aws_dynamodb describe-table --table-name "$TABLE" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='${INDEX}'].Backfilling | [0]" --output text
}
billing_mode() {
  local mode
  mode=$(aws_dynamodb describe-table --table-name "$TABLE" --query 'Table.BillingModeSummary.BillingMode' --output text 2>/dev/null || true)
  if [[ -z "$mode" || "$mode" == "None" ]]; then echo "PROVISIONED"; else echo "$mode"; fi
}

wait_active() {
  while :; do
    local s b
    s=$(index_status); b=$(index_backfilling)
    if [[ "$s" == "ACTIVE" && ( "$b" == "False" || "$b" == "None" || -z "$b" ) ]]; then
      echo "  ✓ $INDEX ACTIVE"; return 0
    fi
    echo "  $INDEX status: $s backfilling=$b - waiting ${POLL_SECS}s..."
    sleep "$POLL_SECS"
  done
}

existing=$(index_status)
if [[ "$existing" == "ACTIVE" ]]; then
  echo "✓ $INDEX already exists on $TABLE - nothing to do"; wait_active; exit 0
fi
if [[ "$existing" == "CREATING" || "$existing" == "UPDATING" ]]; then
  echo "ℹ $INDEX is $existing - waiting"; wait_active; exit 0
fi

throughput=""
if [[ "$(billing_mode)" == "PROVISIONED" ]]; then
  throughput=',"ProvisionedThroughput":{"ReadCapacityUnits":5,"WriteCapacityUnits":5}'
fi

update_payload=$(cat <<EOF
[
  {
    "Create": {
      "IndexName": "${INDEX}",
      "KeySchema": [
        {"AttributeName": "listId",   "KeyType": "HASH"},
        {"AttributeName": "phoneKey", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "KEYS_ONLY"}${throughput}
    }
  }
]
EOF
)
attr_defs='[{"AttributeName":"listId","AttributeType":"S"},{"AttributeName":"phoneKey","AttributeType":"S"}]'

echo "→ Creating $INDEX (HASH=listId, RANGE=phoneKey, KEYS_ONLY) on $TABLE in $AWS_REGION"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN=1 - would run:"
  echo "aws dynamodb --region $AWS_REGION update-table --table-name $TABLE --attribute-definitions '$attr_defs' --global-secondary-index-updates '$(echo "$update_payload" | tr -d '\n ')'"
  exit 0
fi

aws_dynamodb update-table --table-name "$TABLE" \
  --attribute-definitions "$attr_defs" \
  --global-secondary-index-updates "$update_payload" >/dev/null
wait_active
echo "Done. Next: set the AW-Settings row LEAD_PHONE_DEDUPE_MODE (start with 'shadow')."
