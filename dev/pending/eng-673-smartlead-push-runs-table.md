## ENG-673: DynamoDB table for Smartlead push runs (PR-B, 2026-10-27)

The state store for the background Smartlead push (PR-C builds the engine on it). Nothing calls it yet; the only runtime effect is that the backend creates the table at boot.

- Table `AW-SmartleadPushRuns` (`Dev-` prefix in development), keys `pk`/`sk`, on-demand, point-in-time recovery, TTL attribute `ttl`. Registered in `ensureCriticalTables.ts` (created at boot) and copied into `scripts/create-tables.ts`; `smartleadPushRunsTable.test.ts` fails if the two differ. No deletion protection yet (add once proven; the boot reconcile does it for an existing table).
- Two item kinds. Run (`pk` = run id, `sk` = `RUN`): status, who and what, cursor, counts, lease. Lock (`pk` = `LOCK#<listId>#<campaignId>`, `sk` = `LOCK`): the one live run for that list and campaign. Nothing sensitive is stored (no key, no lead content, no emails). Runs live 400 days, locks 15.
- Every write is one conditional item write. No transactions (the app role was denied them, ENG-2321). `leaseEpoch` rises on each claim and the cursor-advancing write is conditioned on it and on `status = running`, so a worker that lost its lease, or whose run was paused or canceled, cannot move the run on.
- Fails closed: a missing table or denied access throws `SmartleadPushRunStoreError`; callers must return 503 and push nothing.
- Four sparse indexes with INCLUDE projections: by list, by owner, by time, and active-by-lease (the resumer). A run drops out of the resume index when it finishes.

### Tests
`smartleadPushRunDb.dynamodbLocal.test.ts` runs the real repository against DynamoDB Local when `DYNAMODB_LOCAL_ENDPOINT` is set (skipped otherwise, like `paygOverage.dynamodbLocal.test.ts`): start races (five and four simultaneous starters, exactly one wins), lease claim race, fence, pause/cancel stopping a worker, partial after 3 failed batches, lock takeover rules, index queries, tolerant readers, fail-closed. Six deliberate breakages of the conditions each make it fail. No CI job is added here (CI is infra's); gap: these tests do not run in CI. Snippet for infra: start `amazon/dynamodb-local` on 8000 and run jest with `DYNAMODB_LOCAL_ENDPOINT=http://localhost:8000`.
`ensureCriticalTables.test.ts` now records only the attempt journal's TTL and recovery calls, because a second table has settings.

### How to extend
- New field on a run: add it to `PushRun`, `toRunItem`, `fromRunItem`. Readers ignore unknown attributes; bump `SCHEMA_VERSION` only if old readers must stop. An unknown `status` is refused on purpose.
- New record kind (batch results, event log): a new `sk` prefix under the same run id; no key change.
- New way to search runs: needs a new index. Boot only creates a missing table, so an index on an existing table is a one-off `UpdateTable` (add the GSI, then the spec and `create-tables.ts`). The four indexes were picked to make that rare.
- Business rules (what to push, when to pause) belong in the engine, not in `smartleadPushRunDb.ts`.

### Before this is used in production
The app's IAM role must allow Get/Put/Update/DeleteItem and Query on the table and its indexes (infra). Until then boot logs the create failure and the push route must return 503.
