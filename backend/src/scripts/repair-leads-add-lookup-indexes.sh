#!/usr/bin/env bash
# End-to-end AW-Leads migration:
#   1. Create the three lookup GSIs sequentially (DynamoDB only allows one GSI
#      Create per UpdateTable, and each must reach ACTIVE before the next).
#   2. Once all GSIs are ACTIVE, run the userId + nameCompanyKey backfill.
# Both steps are idempotent — safe to re-run if interrupted.
#
# Usage:
#   ./repair-leads-add-lookup-indexes.sh                       # prod (TABLE=AW-Leads)
#   TABLE=Dev-AW-Leads ./repair-leads-add-lookup-indexes.sh
#   AWS_PROFILE=staging ./repair-leads-add-lookup-indexes.sh
#   SKIP_BACKFILL=1 ./repair-leads-add-lookup-indexes.sh       # GSIs only
#   SKIP_GSI=1      ./repair-leads-add-lookup-indexes.sh       # backfill only
#   DRY_RUN=1 SKIP_GSI=1 ./repair-leads-add-lookup-indexes.sh  # dry-run backfill
#
# Env:
#   TABLE         — table name (default: AW-Leads)
#   AWS_REGION    — region (default: us-west-2)
#   POLL_SECS     — seconds between status polls (default: 30)
#   SKIP_BACKFILL — set to 1 to skip the backfill step
#   SKIP_GSI      — set to 1 to skip GSI creation (run backfill only)
#   DRY_RUN       — set to 1 to pass --dry-run to the backfill (no writes)
#   REPO_ROOT     — path to agentweb repo root (auto-detected from script path)

set -euo pipefail

TABLE="${TABLE:-AW-Leads}"
AWS_REGION="${AWS_REGION:-us-west-2}"
POLL_SECS="${POLL_SECS:-30}"
SKIP_BACKFILL="${SKIP_BACKFILL:-0}"
SKIP_GSI="${SKIP_GSI:-0}"
DRY_RUN="${DRY_RUN:-0}"

# Resolve the script's own directory so we can find backfillLeadsUserId.ts
# even when the admin runs the script from somewhere else.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Script lives at backend/src/scripts/, repo root is three levels up.
REPO_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REPO_ROOT="${REPO_ROOT:-$REPO_ROOT_DEFAULT}"
BACKFILL_TS="$REPO_ROOT/backend/src/scripts/backfillLeadsUserId.ts"

# index_name : hash_attribute  (SK is always updatedAt; projection ALL; sparse)
INDEXES=(
  "EmailLookupIndex:email"
  "LinkedinLookupIndex:linkedin"
  "NameCompanyLookupIndex:nameCompanyKey"
)

aws_dynamodb() {
  aws dynamodb --region "$AWS_REGION" "$@"
}

table_status() {
  aws_dynamodb describe-table --table-name "$TABLE" \
    --query 'Table.TableStatus' --output text
}

index_status() {
  local name="$1"
  aws_dynamodb describe-table --table-name "$TABLE" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='${name}'].IndexStatus | [0]" \
    --output text
}

index_backfilling() {
  local name="$1"
  aws_dynamodb describe-table --table-name "$TABLE" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='${name}'].Backfilling | [0]" \
    --output text
}

billing_mode() {
  # Returns PAY_PER_REQUEST or PROVISIONED. If BillingModeSummary is absent
  # the table is provisioned by default.
  local mode
  mode=$(aws_dynamodb describe-table --table-name "$TABLE" \
    --query 'Table.BillingModeSummary.BillingMode' --output text 2>/dev/null || true)
  if [[ -z "$mode" || "$mode" == "None" ]]; then
    echo "PROVISIONED"
  else
    echo "$mode"
  fi
}

wait_table_active() {
  while :; do
    local s
    s=$(table_status)
    if [[ "$s" == "ACTIVE" ]]; then return 0; fi
    echo "  table status: $s — waiting ${POLL_SECS}s..."
    sleep "$POLL_SECS"
  done
}

wait_index_active() {
  local name="$1"
  while :; do
    local s b
    s=$(index_status "$name")
    b=$(index_backfilling "$name")
    if [[ "$s" == "ACTIVE" && ( "$b" == "False" || "$b" == "None" || -z "$b" ) ]]; then
      echo "  ✓ $name ACTIVE"
      return 0
    fi
    echo "  $name status: $s backfilling=$b — waiting ${POLL_SECS}s..."
    sleep "$POLL_SECS"
  done
}

create_index() {
  local name="$1" hash_attr="$2"
  local existing
  existing=$(index_status "$name")

  if [[ "$existing" == "ACTIVE" ]]; then
    local b
    b=$(index_backfilling "$name")
    if [[ "$b" == "False" || "$b" == "None" || -z "$b" ]]; then
      echo "✓ $name already ACTIVE — skipping"
      return 0
    fi
    echo "ℹ $name ACTIVE but still backfilling — waiting"
    wait_index_active "$name"
    return 0
  fi
  if [[ "$existing" == "CREATING" || "$existing" == "UPDATING" ]]; then
    echo "ℹ $name in status $existing — waiting"
    wait_index_active "$name"
    return 0
  fi

  echo "→ Creating $name (HASH=$hash_attr, RANGE=updatedAt) on $TABLE"

  local throughput=""
  if [[ "$(billing_mode)" == "PROVISIONED" ]]; then
    throughput=',"ProvisionedThroughput":{"ReadCapacityUnits":5,"WriteCapacityUnits":5}'
  fi

  local update_payload
  update_payload=$(cat <<EOF
[
  {
    "Create": {
      "IndexName": "${name}",
      "KeySchema": [
        {"AttributeName": "${hash_attr}", "KeyType": "HASH"},
        {"AttributeName": "updatedAt",    "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}${throughput}
    }
  }
]
EOF
)

  local attr_defs
  attr_defs=$(cat <<EOF
[
  {"AttributeName": "${hash_attr}", "AttributeType": "S"},
  {"AttributeName": "updatedAt",    "AttributeType": "S"}
]
EOF
)

  wait_table_active
  aws_dynamodb update-table \
    --table-name "$TABLE" \
    --attribute-definitions "$attr_defs" \
    --global-secondary-index-updates "$update_payload" \
    >/dev/null

  wait_index_active "$name"
}

run_backfill() {
  echo
  echo "=================================================="
  echo "Step 2 — backfill userId + nameCompanyKey"
  echo "=================================================="

  if [[ ! -f "$BACKFILL_TS" ]]; then
    echo "⚠  Backfill script not found at: $BACKFILL_TS"
    echo "   Set REPO_ROOT=/path/to/agentweb and re-run, or run manually:"
    echo "   cd <repo>/backend && NODE_ENV=production npx ts-node src/scripts/backfillLeadsUserId.ts"
    return 1
  fi

  if ! command -v npx >/dev/null 2>&1; then
    echo "⚠  npx not found on PATH. Install Node.js 18+ and re-run, or run manually:"
    echo "   cd $REPO_ROOT/backend && NODE_ENV=production npx ts-node src/scripts/backfillLeadsUserId.ts"
    return 1
  fi

  local dry_flag=""
  if [[ "$DRY_RUN" == "1" ]]; then
    dry_flag="--dry-run"
    echo "→ DRY_RUN=1 — backfill will report what it WOULD write, no UpdateItem calls"
  fi

  echo "→ Running backfill from $REPO_ROOT/backend"
  echo "   (NODE_ENV=production — backfill uses un-prefixed table name; AWS profile selects account)"
  echo

  (
    cd "$REPO_ROOT/backend"
    if [[ ! -d node_modules ]]; then
      echo "→ node_modules missing — running npm install (one-time)..."
      npm install
    fi
    NODE_ENV=production npx ts-node src/scripts/backfillLeadsUserId.ts $dry_flag
  )
}

# ---------- Step 1: GSI creation ----------
if [[ "$SKIP_GSI" == "1" ]]; then
  echo "⏭  SKIP_GSI=1 — skipping GSI creation"
else
  echo "Repairing $TABLE in $AWS_REGION (billing=$(billing_mode))"
  echo

  for entry in "${INDEXES[@]}"; do
    name="${entry%%:*}"
    hash_attr="${entry##*:}"
    create_index "$name" "$hash_attr"
  done

  echo
  echo "=================================================="
  echo "✅ All lookup indexes ready on $TABLE"
  echo "=================================================="
fi

# ---------- Step 2: backfill ----------
if [[ "$SKIP_BACKFILL" == "1" ]]; then
  echo
  echo "⏭  SKIP_BACKFILL=1 — skipping backfill"
  echo "   Run manually when ready:"
  echo "   cd $REPO_ROOT/backend && NODE_ENV=production npx ts-node src/scripts/backfillLeadsUserId.ts"
  exit 0
fi

run_backfill

echo
echo "=================================================="
echo "✅ Migration complete on $TABLE"
echo "=================================================="
