## ENG-673: the Smartlead push engine (PR-C1, 2026-10-28)

The worker loop of a push run: walks a CRM lead list and adds the eligible leads to the customer's own Smartlead campaign, in batches of up to 400, resumably. Nothing calls it yet (routes, the resumer cron and the kill switch are PR-C2), so there is no runtime change.

- `smartleadPushEngine.ts`: `executeRun(run, deps)`. Everything it touches is injected (run store, lead reads, marker writes, Smartlead calls, clock), so it is tested without a network or a database.
- Per batch: read the campaign and its sequence fresh (pause for a human if the campaign is gone, archived, started under a DRAFTED approval, or the sequence changed or became unreadable); build a batch from whole pages so the cursor is exactly the last lead examined; re-read the leads about to be sent with a consistent read (an opt-out recorded a moment ago is honoured); read the run strongly; POST; mark every lead (`system.smartlead_<campaignId>`) BEFORE the fenced cursor write; record the batch.
- The markers, not the lock, stop a lead being pushed twice. After a crash the batch is rebuilt and resent; Smartlead answers per lead which already exist, so the run converges. After a resend `added` undercounts and `alreadyInCampaign` carries the leads (the total is right).
- After a POST the leads are ALWAYS marked, even if the run was paused or the lease lost meanwhile: an unmarked lead would be invisible to the own-sender skip and the opt-out withdrawal. Only the cursor write is fenced. (Found by the real-store test.)
- The approved count is a hard ceiling. A batch that fails (error, or an outcome we cannot know) does not move the cursor; three in a row make the run `partial`. A 401 or 403 pauses with `key_rejected`. A reply with no per-lead map pauses (nothing can be marked). A store error propagates: fail closed.
- `smartleadService.ts`: `getCampaign` and `getCampaignSequences`. Verified on a real account (2026-10-28): a campaign id that does not exist returns HTTP 200 with an EMPTY body (so `getCampaign` gives null), and its sequences return an `{error: ...}` object (so `getCampaignSequences` throws rather than reading it as an empty sequence).

### Tests
`smartleadPushEngine.test.ts` (30, runs everywhere): batching and exact cursors, every skip reason, the ceiling, the opt-out re-check, crash and retry, partial after three failures, the fence, every pause reason, and what Smartlead does not accept. `smartleadPushEngine.dynamodbLocal.test.ts` (opt-in, `DYNAMODB_LOCAL_ENDPOINT`) drives the engine through the real fenced store: completion, a crash with a second worker claiming the lapsed lease, a worker that lost its lease, and pause then resume without re-sending. Eleven deliberate breakages each fail a test.

### Known limits (for the next PRs)
- Not in this PR: preview and the signed token, routes, the resumer cron, the kill switch, rate limits, audit (PR-C2); own-sender skip and the withdrawal sweep (PR-D, before the first real push); the portal (PR-E).
- Emails seen so far are kept in memory per execution; after a resume a duplicate across the restart boundary is possible and Smartlead de-duplicates it.
- Leads Smartlead did not account for are counted `unconfirmed` and left unmarked.
