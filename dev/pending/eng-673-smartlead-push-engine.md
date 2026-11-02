## ENG-673: the Smartlead push engine — PR-C1 (2026-10-28)

The worker loop of a push run: walks a CRM lead list and adds the eligible leads to the customer's own Smartlead campaign, in batches of up to 400, resumably. Nothing calls it yet (routes, the resumer cron and the kill switch are PR-C2), so there is no runtime change.

- `smartleadPushEngine.ts`: `executeRun(run, deps)`. Everything it touches is injected (run store, lead reads, marker writes, Smartlead calls, clock), so it is tested without a network or a database.
- Per batch: read the campaign and its sequence fresh (pause for a human if the campaign is gone, archived, started under a DRAFTED approval, or the sequence changed or became unreadable); build a batch from whole pages so the cursor is exactly the last lead examined; re-read the leads about to be sent with a consistent read (an opt-out recorded a moment ago is honoured); read the run strongly; POST; mark every lead (`system.smartlead_<campaignId>`) BEFORE the fenced cursor write; record the batch.
- The markers, not the lock, stop a lead being pushed twice. After a crash the batch is rebuilt and resent; Smartlead answers per lead which already exist, so the run converges. After a resend `added` undercounts and `alreadyInCampaign` carries the leads (the total is right).
- After a POST the leads are ALWAYS marked, even if the run was paused or the lease lost meanwhile: an unmarked lead would be invisible to the own-sender skip and the opt-out withdrawal. Only the cursor write is fenced. (Found by the real-store test.)
- The approved count is a hard ceiling, and it counts leads THIS run already marked but never recorded (a crash, a lost lease, a failed batch): they are in Smartlead and the cursor has not passed them, so a rebuilt batch cannot fill the ceiling a second time. A batch that fails (error, or an outcome we cannot know) does not move the cursor; three in a row make the run `partial`. A 401 or 403 pauses with `key_rejected`. A reply with no per-lead map pauses (nothing can be marked). A store error propagates: fail closed.
- `smartleadService.ts`: `getCampaign` and `getCampaignSequences`. Verified on a real account (2026-10-28): a campaign id that does not exist returns HTTP 200 with an EMPTY body (so `getCampaign` gives null), and its sequences return an `{error: ...}` object (so `getCampaignSequences` throws rather than reading it as an empty sequence).

### Tests
`smartleadPushEngine.test.ts` (30, runs everywhere): batching and exact cursors, every skip reason, the ceiling, the opt-out re-check, crash and retry, partial after three failures, the fence, every pause reason, and what Smartlead does not accept. `smartleadPushEngine.dynamodbLocal.test.ts` (opt-in, `DYNAMODB_LOCAL_ENDPOINT`) drives the engine through the real fenced store: completion, a crash with a second worker claiming the lapsed lease, a worker that lost its lease, and pause then resume without re-sending. Eleven deliberate breakages each fail a test.

### Known limits (for the next PRs)
- Not in this PR: preview and the signed token, routes, the resumer cron, the kill switch, rate limits, audit (PR-C2); own-sender skip and the withdrawal sweep (PR-D, before the first real push); the portal (PR-E).
- Each execution first reads the WHOLE list once (about 40 reads for 8,000 leads) to collect every opted-out email, so a second record with the same address is never emailed, on either side of the cursor or of a restart. A list over 100,000 leads pauses with `list_too_large`.
- A lead Smartlead does not name in its per-lead answer is accepted only when Smartlead's own tallies explain it (block list, bounce, duplicate, import stopped...); otherwise it may be in the campaign without a marker, so the batch is retried and, after three tries, the run stops as `partial`. A lead listed under "existing in other campaigns" is marked only up to the number Smartlead says it added or already had.
- A lead Smartlead lists under "existing in other campaigns" and the engine could not mark is NEVER accepted as explained: the run pauses with `other_campaign_leads` for a human, because whether Smartlead added it is unverified and an added-but-unmarked lead would be invisible to the opt-out safeguards. (Verify `skipped_in_other_campaign_count` on a real started campaign, then this can be relaxed.)
- Smartlead's account lead limit pauses the run WITHOUT moving the cursor, so a resume after the limit is raised rebuilds the batch, skips what is marked and sends the rest.
- Just before each POST the whole eligibility check is run again on a consistent re-read of the leads (an opt-out, a bounce or an edited address recorded after the page read is honoured).

- The run's counts include only batches that were recorded. A run that stops as `partial` can already have many leads in Smartlead (marked, and counted when a resume passes them): the markers, not the counts, are the truth, and the status page should say so.
- A lead this run pushed that has since become do-not-contact is not counted toward the ceiling; PR-D's withdrawal (unsubscribing it in Smartlead) is what keeps the ceiling true.

### For PR-C2
- The resumer must not auto-resume a run paused for `smartlead_lead_limit` (each resume POSTs once); resume that one on user action only.
- `readLeads` must page the list with no filter, newest first, with the hand-built `{listId, leadId}` as `ExclusiveStartKey`; the engine treats an empty page as the end of the list.
- The bound `addLeads` should use a small `maxRetries` (a POST that backs off for minutes outlives the 90 s lease; the markers make a second worker's resend safe, but it wastes the run).
