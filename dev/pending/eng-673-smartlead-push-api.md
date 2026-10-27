## ENG-673: Smartlead push API (PR-C2, 2026-10-28)

The routes, the signed approval, the service and the resumer that make the push engine (PR-C1) usable. OFF unless `SMARTLEAD_PUSH_ENABLED=true`; nothing in the portal calls it yet (PR-E).

### Routes (`/api/crm/smartlead-push`, all authenticated)
- `GET /campaigns`: the user's own Smartlead campaigns for a picker, each with `pushable` and `needsConfirmation` (ACTIVE).
- `POST /preview {listId, campaignId, includeUnverified?, mapping?, acknowledgedTags?, cohort?}`: evaluates the WHOLE list with the run's own eligibility rules, reads the campaign and its sequence, shows what would be sent for three real leads, an advisory days-to-send estimate, and returns a signed 30-minute token. Nothing is stored. The first push into a campaign defaults to a 50-lead test cohort; every eligible lead is one choice away (`cohort`).
- `POST /start {token, acknowledgements:{lawfulBasis, activeConfirmed?}}`: 202 when a run starts (a background worker takes it), 200 `started:false` with the live run when the list and campaign already have one. Re-checks the world against the approval: same sequence hash, a draft campaign not started under the approval, no new blocks, ACTIVE needs a separate confirmation.
- `GET /runs/:id`, `GET /lists/:listId/runs`, `POST /runs/:id/pause|resume|cancel`. A stranger is told a run does not exist.
- Limits: previews 30 and starts 10 per user per 15 minutes.

### Rules
- **An approval is single use.** Its id (`jti`) is consumed with one conditional put in the run table (a `TOKEN#<jti>` record, expiring after two hours). Replaying an approval for a 50-lead test cohort would otherwise push 50 more each time, because earlier runs' markers do not count toward a new run's ceiling. A second submit of a used approval is shown the run it started; an approval is given back if the start did not happen. Pushing more takes a fresh preview. The approval also binds the Smartlead connection and the "send even though my sequence could not be read" acknowledgement; the start ignores those fields in its own body.
- **Only the person whose Smartlead connection a run uses can resume it** (resuming sends with that connection). Other editors of the list can still pause and cancel.
- A user with several of their own Smartlead connections must name one (`accountId`); the service never picks between them.
- A run the kill switch paused (`disabled_by_operator`) is never cancelled as stale. Smartlead failures come back as a clear 422 (key rejected), 429 or 502, never a bare 500. At most 3 previews run at once per process (a preview holds a whole list in memory).
- Needs edit access to the list (`canDestructiveCrmList`: owner, org owner or CRM editor). Uses ONLY the pusher's own Smartlead connection; a teammate's shared key is never used (`keyOwnerId` on the run is the seam).
- Kill switch: `SMARTLEAD_PUSH_ENABLED` must be exactly `true`; otherwise preview, start, resume and campaigns return 503, the resumer idles, and a running run pauses at its next batch (`disabled_by_operator`). Pause and cancel always work.
- Fails closed: if the run table is missing or access is denied, start returns 503 and nothing is sent.
- The resumer runs every minute (`server.ts`, `cronJobRegistry`, active only when the flag is on): it claims runs whose worker is gone and cancels runs left paused for a week. At most 4 workers per process. A run paused for `smartlead_lead_limit` is only resumed by a user.
- Audit: each run records who pushed, with which key, the options, the warnings shown and the acknowledgements; start, resume, cancel and the resumer log one line each (no lead data, no key).

### Tests
`smartleadPushToken.test.ts`, `smartleadPushPreview.test.ts`, `routes/__tests__/smartleadPush.test.ts` (supertest with the service mocked), and `smartleadPushService.test.ts` (33 tests, run twice: on an in-memory run store EVERYWHERE, so CI and the pre-push hook exercise the service's access, approval, start, control, worker and resumer logic, and again on the real run store when `DYNAMODB_LOCAL_ENDPOINT` is set; includes a two-starter race, approval replay and the resumer taking over a dead worker). The real conditional writes themselves are proven by `smartleadPushRunDb.dynamodbLocal.test.ts`, which is opt-in. Live on env1 (real HTTP, real Smartlead, real tables): preview, start, completion, a second preview showing everything already pushed, a replayed token sending nothing, and cleanup.

### Known limits
- The kill switch is an environment variable: changing it on a deployed environment needs a restart. A runtime toggle is a tracked follow-up.
- Preview reads a whole list into memory (refused above 50,000 leads).
- Paused/partial runs are cancelled after a week counted from the run's last lease.
- Not yet: the Emma push tool, the portal dialog (PR-E), the opt-out safeguards for AgentWeb's own senders and the withdrawal sweep (PR-D, which must merge before the first real push).
