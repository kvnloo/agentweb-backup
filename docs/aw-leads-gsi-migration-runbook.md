# AW-Leads GSI Migration — Admin Runbook

This runbook adds three new Global Secondary Indexes to an **existing** `AW-Leads` DynamoDB table and backfills two new attributes. Required for the Tier 0 cross-tenant sibling enrichment feature shipped in PR #1495.

> **Fresh environments do not need this runbook.** The three lookup GSIs are already declared in `backend/src/scripts/create-tables.ts` (search for `EmailLookupIndex`). Any environment whose `AW-Leads` table is created via `create-tables.ts` after that change merged gets the GSIs for free, and the backfill is a no-op because there's nothing to migrate. Use this runbook **only** for environments where `AW-Leads` already exists with data: prod, staging, dev.

You will be given **one shell script** by the engineering team:

- `repair-leads-add-lookup-indexes.sh` (lives at `backend/src/scripts/repair-leads-add-lookup-indexes.sh`)

The script does **both** steps end-to-end: creates the GSIs, waits for each to be `ACTIVE`, then runs the backfill. Run it once per environment (prod, then staging, then dev). Total wall-clock time depends on table size — plan for several hours on prod.

> **Important:** the script needs access to the agentweb repo to run the backfill step (it invokes `npx ts-node backend/src/scripts/backfillLeadsUserId.ts` after the GSIs are ready). Run from inside a checkout of the repo, or set `REPO_ROOT=/path/to/agentweb`.

---

## Pre-flight (do this before starting — paste outputs into the deploy ticket)

Run these on each environment **before** kicking off the migration. The numbers drive your time estimate and your throughput risk.

1. **Confirm the right account / region**
   ```bash
   aws sts get-caller-identity
   aws configure get region
   ```

2. **Confirm PITR (point-in-time recovery) is enabled** — this is your one-button rollback if the backfill writes something unexpected.
   ```bash
   aws dynamodb describe-continuous-backups \
     --table-name AW-Leads --region us-west-2 \
     --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus'
   ```
   Expected: `"ENABLED"`. If it returns `DISABLED`, **stop** and enable it first:
   ```bash
   aws dynamodb update-continuous-backups \
     --table-name AW-Leads --region us-west-2 \
     --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
   ```

3. **Confirm billing mode** — this affects how the new GSIs are throughput-provisioned.
   ```bash
   aws dynamodb describe-table --table-name AW-Leads --region us-west-2 \
     --query 'Table.BillingModeSummary.BillingMode' --output text
   ```
   - `PAY_PER_REQUEST` → the script just works.
   - `PROVISIONED` → **see "Capacity guidance" below before continuing.** The script hardcodes `WCU=5/RCU=5` on each new GSI, which will throttle the backfill on any non-trivial table.

4. **Item count + size** — drives time estimate.
   ```bash
   aws dynamodb describe-table --table-name AW-Leads --region us-west-2 \
     --query 'Table.{Items:ItemCount,Bytes:TableSizeBytes}' --output table
   ```
   Rule of thumb: each GSI build takes ~1 hour per 100k items on a quiet table, longer if the table is under load. With three GSIs built sequentially, multiply by 3.

5. **Confirm the read-side code is already deployed** — Tier 0 enrichment code must tolerate a missing/empty GSI, otherwise users will see errors while the indexes are building. The grep below should return at least one hit on each environment's deployed backend:
   ```bash
   # On a deployed backend / from the repo at the deployed commit:
   grep -rn "EmailLookupIndex" backend/src
   ```
   The Tier 0 read path returns empty (no errors) when the index is missing — that's the safety contract this migration relies on. **If you're not sure the read-side code is deployed, stop and check with engineering before running step 1.**

6. **Set up CloudWatch monitoring** for the run. Open these in a tab each before you start:
   - `WriteThrottleEvents` on `AW-Leads`
   - `ReadThrottleEvents` on `AW-Leads`
   - `ConsumedWriteCapacityUnits` on `AW-Leads` (per-GSI breakdown)

7. **Announce in `#deploy`:**
   > Starting AW-Leads GSI migration on **<env>**. Item count: **<N>**. Billing mode: **<MODE>**. Expected wall-clock: **<H>h**. Owner: **<your handle>**. Reference: PR #1495.

---

## What this migration does

Adds three sparse GSIs to `AW-Leads`:

| IndexName | HASH | RANGE | Notes |
|---|---|---|---|
| `EmailLookupIndex` | `email` | `updatedAt` | sparse, projection ALL |
| `LinkedinLookupIndex` | `linkedin` | `updatedAt` | sparse, projection ALL |
| `NameCompanyLookupIndex` | `nameCompanyKey` | `updatedAt` | sparse, projection ALL |

Then backfills `userId` and `nameCompanyKey` on legacy rows via `backfillLeadsUserId.ts`. The backfill is idempotent (uses `if_not_exists`) and resumable (re-running re-scans but skips already-touched rows).

**No downtime.** App traffic continues to serve normally. Tier 0 enrichment queries return empty (no errors) until each index reaches `ACTIVE` — see pre-flight step 5.

---

## Capacity guidance (PROVISIONED tables only)

Skip this section if `BillingMode == PAY_PER_REQUEST`.

The repair script provisions each new GSI at `WCU=5, RCU=5`. DynamoDB's GSI backfill uses the index's *write* capacity, so on a table with even modest item counts the backfill will burn through 5 WCU instantly and then throttle. You will see the GSI sit in `Backfilling: true` for hours longer than necessary.

**Recommended:** before running, bump the GSI capacity right after the script creates each one. Easiest path is to run the script with `SKIP_BACKFILL=1`, then for each created index:

```bash
aws dynamodb update-table \
  --table-name AW-Leads --region us-west-2 \
  --global-secondary-index-updates '[{
    "Update": {
      "IndexName": "EmailLookupIndex",
      "ProvisionedThroughput": {"ReadCapacityUnits": 25, "WriteCapacityUnits": 100}
    }
  }]'
```

Then run the backfill (`SKIP_GSI=1 ./repair-leads-add-lookup-indexes.sh`). Once `Backfilling=False`, **scale back down** to your steady-state numbers (likely `RCU=5/WCU=5` for sparse lookup GSIs) — leaving 100 WCU provisioned costs real money.

---

## Run the script

The script is **idempotent and resumable** — safe to re-run if interrupted. It creates each GSI one at a time, polling every 30 seconds until each is `ACTIVE` and finished backfilling before starting the next. After all three indexes are ready, it automatically runs the data backfill.

### Dry-run the backfill first (recommended)

Before the real run, do a dry-run of the backfill on each env so you know what the script is about to write. Requires the GSIs to already exist (run `SKIP_BACKFILL=1` first, or set `SKIP_GSI=1` if they're already in place):

```bash
SKIP_GSI=1 DRY_RUN=1 AWS_PROFILE=<profile> AWS_REGION=us-west-2 \
  ./backend/src/scripts/repair-leads-add-lookup-indexes.sh
```

This produces a `[backfillLeadsUserId] DONE { touched, skippedNoop, skippedOrphaned, errored }` line. Record those numbers in the migration log below. `skippedOrphaned > 0` means there are leads whose parent list is missing from `AW-LeadLists` — flag these to engineering before the real run.

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

> Staging and prod both use the un-prefixed table name `AW-Leads`. The AWS profile is what selects the account.

### Optional environment variables

| Var | Default | Purpose |
|---|---|---|
| `TABLE` | `AW-Leads` | Override table name (e.g. `Dev-AW-Leads` for dev) |
| `AWS_REGION` | `us-west-2` | AWS region |
| `POLL_SECS` | `30` | Seconds between status polls |
| `SKIP_BACKFILL` | `0` | Set to `1` to run GSI creation only |
| `SKIP_GSI` | `0` | Set to `1` to run backfill only (GSIs must already be ACTIVE) |
| `DRY_RUN` | `0` | Set to `1` to pass `--dry-run` to the backfill (no writes) |
| `REPO_ROOT` | auto-detected | Path to agentweb repo root |

### What you'll see

```
Repairing AW-Leads in us-west-2 (billing=PROVISIONED)

→ Creating EmailLookupIndex (HASH=email, RANGE=updatedAt) on AW-Leads
  EmailLookupIndex status: CREATING backfilling=True — waiting 30s...
  ...
  ✓ EmailLookupIndex ACTIVE
→ Creating LinkedinLookupIndex (HASH=linkedin, RANGE=updatedAt) on AW-Leads
  ...
  ✓ LinkedinLookupIndex ACTIVE
→ Creating NameCompanyLookupIndex (HASH=nameCompanyKey, RANGE=updatedAt) on AW-Leads
  ...
  ✓ NameCompanyLookupIndex ACTIVE

==================================================
Step 2 — backfill userId + nameCompanyKey
==================================================
→ Running backfill from <repo>/backend
[backfillLeadsUserId] starting { dryRun: false, env: 'production', ... }
[backfillLeadsUserId] loaded N lists
[backfillLeadsUserId] DONE { touched: T, skippedNoop: N, skippedOrphaned: O, errored: E, dryRun: false }
==================================================
✅ Migration complete on AW-Leads
==================================================
```

---

## Verify after completion

All four checks should pass. Paste actual outputs into the migration log.

**1. All three GSIs are ACTIVE and not backfilling:**
```bash
aws dynamodb describe-table --table-name AW-Leads --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`EmailLookupIndex` || IndexName==`LinkedinLookupIndex` || IndexName==`NameCompanyLookupIndex`].[IndexName,IndexStatus,Backfilling]' \
  --output table
```
Each row should show `ACTIVE` with `Backfilling` empty / `False` / `None`.

**2. Backfill `touched + skippedNoop + skippedOrphaned + errored` equals the table item count.** This is the sanity check that the scan saw every row. Compare against the `ItemCount` from pre-flight step 4. (DynamoDB's `ItemCount` lags by ~6h, so allow drift if writes are flowing.)

**3. `errored == 0`** in the backfill output line. If non-zero, scroll up — each failure logs `update failed for <listId>/<leadId>: <reason>`. Send the list to engineering.

**4. Re-run the dry-run — it should report `touched: 0`:**
```bash
SKIP_GSI=1 DRY_RUN=1 AWS_PROFILE=<profile> AWS_REGION=us-west-2 \
  ./backend/src/scripts/repair-leads-add-lookup-indexes.sh
```
A second pass should find nothing left to write. If `touched > 0`, the first run was interrupted or some rows changed underneath it — run the real backfill again (idempotent).

---

## Rollback

You should not need this — the GSIs are additive and the backfill is `if_not_exists`. But if engineering asks:

- **Backfilled attributes (`userId`, `nameCompanyKey`) stay on the rows.** They're harmless even if the feature is disabled. Use PITR to restore the table to a pre-migration timestamp if you genuinely need to remove them, but this is a heavy operation — discuss with engineering first.
- **Delete the GSIs** (one per `UpdateTable` call):
  ```bash
  aws dynamodb update-table --table-name AW-Leads --region us-west-2 \
    --global-secondary-index-updates '[{"Delete":{"IndexName":"EmailLookupIndex"}}]'
  # repeat for LinkedinLookupIndex and NameCompanyLookupIndex
  ```
  App continues to function — only the Tier 0 enrichment feature degrades.
- **Recreating a deleted GSI takes hours** (same as the original build). Treat deletion as one-way in practice.

---

## Troubleshooting

| Error | Meaning | Action |
|---|---|---|
| `ResourceInUseException` | Table or another GSI is busy | Script handles this — let it keep polling |
| `AccessDeniedException` | IAM is missing `dynamodb:UpdateTable` or `dynamodb:UpdateItem` | Add permission to the principal |
| `ValidationException: ... ProvisionedThroughput ...` | Billing-mode mismatch | Capture full error, ping engineering |
| GSI stuck in `Backfilling=True` for hours longer than expected | Throughput-throttled (PROVISIONED only) | See "Capacity guidance" — bump WCU on the GSI |
| `skippedOrphaned > 0` in backfill output | Leads exist whose parent `AW-LeadLists` row is missing | Flag to engineering — these rows won't get a `userId` |
| `errored > 0` in backfill output | Individual `UpdateItem` calls failed | Inspect the warn lines; re-run is safe |
| Script appears stuck mid-build | Populated table can take hours per index | Check `IndexStatus` / `Backfilling` via the verify command above |

---

## Migration log (fill in per environment, commit back to repo)

| Field | Dev | Staging | Prod |
|---|---|---|---|
| Operator | | | |
| Run start (UTC) | | | |
| Run end (UTC) | | | |
| Pre-flight item count | | | |
| Billing mode | | | |
| PITR enabled? | | | |
| Dry-run `touched` / `skippedNoop` / `skippedOrphaned` | | | |
| Real-run `touched` / `errored` | | | |
| Anomalies / notes | | | |
| Sign-off (engineering) | | | |

---

## Who to notify

- **Before pre-flight:** post in `#deploy` with the announcement template from pre-flight step 7.
- **After all three GSIs are ACTIVE** — same channel, one-line update.
- **After backfill completes** — same channel, paste the `[backfillLeadsUserId] DONE { ... }` line.
- **After verify section is green** — tag the engineering owner of PR #1495 and link to the filled-in migration log entry above.
