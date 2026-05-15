# AW-Leads GSI Migration — Admin Runbook

This runbook adds three new Global Secondary Indexes to the `AW-Leads` DynamoDB table and backfills two new attributes. Required for the Tier 0 cross-tenant sibling enrichment feature shipped in PR #1495.

You will be given **one shell script** by the engineering team:

- `repair-leads-add-lookup-indexes.sh`

The script does **both** steps end-to-end: creates the GSIs, waits for them to be ACTIVE, then runs the backfill. Run it once per environment (prod, then staging). Total wall-clock time depends on table size — plan for several hours.

> **Important:** the script needs access to the agentweb repo to run the backfill step (it invokes `npx ts-node backend/src/scripts/backfillLeadsUserId.ts` after the GSIs are ready). Place the script inside a checkout of the repo (at `backend/src/scripts/`) or set `REPO_ROOT=/path/to/agentweb` when running.

---

## Prerequisites

1. **AWS CLI v2** installed
   ```bash
   aws --version
   # expected: aws-cli/2.x...
   ```
2. **AWS credentials** with these permissions on `AW-Leads`:
   - `dynamodb:DescribeTable`
   - `dynamodb:UpdateTable`
   - `dynamodb:Query`, `dynamodb:Scan`, `dynamodb:UpdateItem` (needed for Step 2)

   Use either `AWS_PROFILE` or exported `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.
3. **Node.js 18+** and a clone of the `agentweb` repo (only needed for Step 2 — the backfill script lives in the repo).
4. **Region:** `us-west-2` (unless engineering tells you otherwise).
5. **Run inside `tmux` or `screen`** — each GSI build can take hours; you don't want an SSH disconnect to interrupt it.

---

## What this migration does

Adds three sparse GSIs to `AW-Leads`:

| IndexName | HASH | RANGE | Notes |
|---|---|---|---|
| `EmailLookupIndex` | `email` | `updatedAt` | sparse, projection ALL |
| `LinkedinLookupIndex` | `linkedin` | `updatedAt` | sparse, projection ALL |
| `NameCompanyLookupIndex` | `nameCompanyKey` | `updatedAt` | sparse, projection ALL |

Then backfills `userId` and `nameCompanyKey` on legacy rows.

**No downtime.** App traffic continues to serve normally. Tier 0 enrichment queries return empty (no errors) until each index reaches `ACTIVE`.

---

## Run the script

The script is **idempotent and resumable** — safe to re-run if interrupted, safe to leave running for hours. It creates each GSI one at a time (DynamoDB only allows one GSI `Create` per `UpdateTable` call), polling every 30 seconds until each is `ACTIVE` and finished backfilling before starting the next. After all three indexes are ready, it automatically runs the data backfill.

### Run for production

```bash
chmod +x backend/src/scripts/repair-leads-add-lookup-indexes.sh

AWS_PROFILE=<prod-profile> AWS_REGION=us-west-2 \
  ./backend/src/scripts/repair-leads-add-lookup-indexes.sh
```

### Run for staging

```bash
AWS_PROFILE=<staging-profile> AWS_REGION=us-west-2 \
  ./backend/src/scripts/repair-leads-add-lookup-indexes.sh
```

> The staging table name is also `AW-Leads` (no prefix). The AWS profile is what targets the correct account.

### Optional environment variables

| Var | Default | Purpose |
|---|---|---|
| `TABLE` | `AW-Leads` | Override table name (e.g. `Dev-AW-Leads` for dev) |
| `AWS_REGION` | `us-west-2` | AWS region |
| `POLL_SECS` | `30` | Seconds between status polls |
| `SKIP_BACKFILL` | `0` | Set to `1` to run GSI creation only (skip backfill) |
| `SKIP_GSI` | `0` | Set to `1` to run backfill only (skip GSI creation — only if GSIs are already ACTIVE) |
| `REPO_ROOT` | auto-detected | Path to agentweb repo root (override if script is moved) |

### What you'll see

```
Repairing AW-Leads in us-west-2 (billing=PROVISIONED)

→ Creating EmailLookupIndex (HASH=email, RANGE=updatedAt) on AW-Leads
  EmailLookupIndex status: CREATING backfilling=True — waiting 30s...
  EmailLookupIndex status: ACTIVE backfilling=True — waiting 30s...
  ...
  ✓ EmailLookupIndex ACTIVE
→ Creating LinkedinLookupIndex (HASH=linkedin, RANGE=updatedAt) on AW-Leads
  ...
  ✓ LinkedinLookupIndex ACTIVE
→ Creating NameCompanyLookupIndex (HASH=nameCompanyKey, RANGE=updatedAt) on AW-Leads
  ...
  ✓ NameCompanyLookupIndex ACTIVE

==================================================
✅ All lookup indexes ready on AW-Leads
==================================================

==================================================
Step 2 — backfill userId + nameCompanyKey
==================================================
→ Running backfill from <repo>/backend
   (NODE_ENV=production — backfill uses un-prefixed table name; AWS profile selects account)
...
==================================================
✅ Migration complete on AW-Leads
==================================================
```

### Verify manually (after script completes)

GSIs:
```bash
aws dynamodb describe-table --table-name AW-Leads --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`EmailLookupIndex` || IndexName==`LinkedinLookupIndex` || IndexName==`NameCompanyLookupIndex`].[IndexName,IndexStatus,Backfilling]' \
  --output table
```
All three rows should show `ACTIVE` with `Backfilling` empty or `False`.

---

## Alternative: Manual AWS CLI Commands

If you cannot run the shell script (e.g. missing Node.js, permission issues), you can create the GSIs manually via AWS CLI. Run the commands **one at a time** — DynamoDB only allows one GSI creation per `UpdateTable` call, and each must reach `ACTIVE` before starting the next.

### Step 1 — Create EmailLookupIndex

```bash
aws dynamodb update-table \
  --table-name AW-Leads \
  --region us-west-2 \
  --attribute-definitions \
    AttributeName=email,AttributeType=S \
    AttributeName=updatedAt,AttributeType=S \
  --global-secondary-index-updates '[{
    "Create": {
      "IndexName": "EmailLookupIndex",
      "KeySchema": [
        {"AttributeName":"email","KeyType":"HASH"},
        {"AttributeName":"updatedAt","KeyType":"RANGE"}
      ],
      "Projection": {"ProjectionType":"ALL"}
    }
  }]'
```

Check status (repeat until `ACTIVE` and `Backfilling` is empty/False):
```bash
aws dynamodb describe-table --table-name AW-Leads --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`EmailLookupIndex`].[IndexStatus,Backfilling]' \
  --output table
```

### Step 2 — Create LinkedinLookupIndex (only after Step 1 is ACTIVE)

```bash
aws dynamodb update-table \
  --table-name AW-Leads \
  --region us-west-2 \
  --attribute-definitions \
    AttributeName=linkedin,AttributeType=S \
    AttributeName=updatedAt,AttributeType=S \
  --global-secondary-index-updates '[{
    "Create": {
      "IndexName": "LinkedinLookupIndex",
      "KeySchema": [
        {"AttributeName":"linkedin","KeyType":"HASH"},
        {"AttributeName":"updatedAt","KeyType":"RANGE"}
      ],
      "Projection": {"ProjectionType":"ALL"}
    }
  }]'
```

Check status:
```bash
aws dynamodb describe-table --table-name AW-Leads --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`LinkedinLookupIndex`].[IndexStatus,Backfilling]' \
  --output table
```

### Step 3 — Create NameCompanyLookupIndex (only after Step 2 is ACTIVE)

```bash
aws dynamodb update-table \
  --table-name AW-Leads \
  --region us-west-2 \
  --attribute-definitions \
    AttributeName=nameCompanyKey,AttributeType=S \
    AttributeName=updatedAt,AttributeType=S \
  --global-secondary-index-updates '[{
    "Create": {
      "IndexName": "NameCompanyLookupIndex",
      "KeySchema": [
        {"AttributeName":"nameCompanyKey","KeyType":"HASH"},
        {"AttributeName":"updatedAt","KeyType":"RANGE"}
      ],
      "Projection": {"ProjectionType":"ALL"}
    }
  }]'
```

Check all three at once:
```bash
aws dynamodb describe-table --table-name AW-Leads --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`EmailLookupIndex` || IndexName==`LinkedinLookupIndex` || IndexName==`NameCompanyLookupIndex`].[IndexName,IndexStatus,Backfilling]' \
  --output table
```

### Step 4 — Run the backfill (only after all 3 are ACTIVE)

```bash
cd /path/to/agentweb/backend
NODE_ENV=production npx ts-node src/scripts/backfillLeadsUserId.ts
```

> With ~205k items, each GSI build can take **1–3 hours**. Keep re-running the check command to monitor progress.

---

## Re-running individual steps

If something interrupts the script after the GSIs are ACTIVE but during backfill, re-run only the backfill:

```bash
SKIP_GSI=1 AWS_PROFILE=<profile> AWS_REGION=us-west-2 \
  ./backend/src/scripts/repair-leads-add-lookup-indexes.sh
```

If you only want to create the GSIs and run the backfill later by hand:

```bash
SKIP_BACKFILL=1 AWS_PROFILE=<profile> AWS_REGION=us-west-2 \
  ./backend/src/scripts/repair-leads-add-lookup-indexes.sh

# later — manually
cd backend && NODE_ENV=production npx ts-node src/scripts/backfillLeadsUserId.ts
```

---

## Rollback

Not expected to be needed. If engineering asks you to remove the GSIs:

```bash
aws dynamodb update-table --table-name AW-Leads --region us-west-2 \
  --global-secondary-index-updates '[{"Delete":{"IndexName":"EmailLookupIndex"}}]'
# repeat for LinkedinLookupIndex and NameCompanyLookupIndex (one per call)
```

App continues to function with the GSIs removed — only the Tier 0 enrichment feature degrades.

---

## Troubleshooting

| Error | Meaning | Action |
|---|---|---|
| `ResourceInUseException` | Table or another GSI is busy | Script handles this — let it keep polling |
| `AccessDeniedException` | IAM is missing `dynamodb:UpdateTable` | Add permission to the principal |
| `ValidationException: ... ProvisionedThroughput ...` | Billing-mode mismatch | Capture full error, ping engineering |
| Script appears stuck | A populated table can take hours per index | Check `IndexStatus` / `Backfilling` via the verify command above |
| Backfill script errors | See stack trace | Re-run is safe; if errors persist, send the trace to engineering |

---

## Who to notify

- **Before Step 1:** post in `#deploy` (or your usual deploy channel) — "starting AW-Leads GSI migration on \<env>".
- **After all three GSIs are ACTIVE.**
- **After backfill completes** on each environment.

Tag the engineering owner of PR #1495.
