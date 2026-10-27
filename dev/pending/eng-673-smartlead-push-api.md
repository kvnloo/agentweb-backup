## ENG-673: Smartlead push API (PR-C2, 2026-10-28)

The routes, the signed approval, the service and the resumer that make the push engine (PR-C1) usable. OFF unless `SMARTLEAD_PUSH_ENABLED=true`; nothing in the portal calls it yet (PR-E).

### Routes (`/api/crm/smartlead-push`, all authenticated)
- `GET /campaigns`: the user's own Smartlead campaigns for a picker, each with `pushable` and `needsConfirmation` (ACTIVE).
- `POST /preview {listId, campaignId, includeUnverified?, mapping?, acknowledgedTags?, cohort?}`: evaluates the WHOLE list with the run's own eligibility rules, reads the campaign and its sequence, shows what would be sent for three real leads, an advisory days-to-send estimate, and returns a signed 30-minute token. Nothing is stored. The first push into a campaign defaults to a 50-lead test cohort; every eligible lead is one choice away (`cohort`).
- `POST /start {token, acknowledgements:{lawfulBasis, activeConfirmed?}}`: 202 when a run starts (a background worker takes it), 200 `started:false` with the live run when the list and campaign already have one. Re-checks the world against the approval: same sequence hash, a draft campaign not started under the approval, no new blocks, ACTIVE needs a separate confirmation.
- `GET /runs/:id`, `GET /lists/:listId/runs`, `POST /runs/:id/pause|resume|cancel`. A stranger is told a run does not exist.
- Limits: previews 30 and starts 10 per user per 15 minutes.

### Rules
- Needs edit access to the list (`canDestructiveCrmList`: owner, org owner or CRM editor). Uses ONLY the pusher's own Smartlead connection; a teammate's shared key is never used (`keyOwnerId` on the run is the seam).
- Kill switch: `SMARTLEAD_PUSH_ENABLED` must be exactly `true`; otherwise preview, start, resume and campaigns return 503, the resumer idles, and a running run pauses at its next batch (`disabled_by_operator`). Pause and cancel always work.
- Fails closed: if the run table is missing or access is denied, start returns 503 and nothing is sent.
- The resumer runs every minute (`server.ts`, `cronJobRegistry`, active only when the flag is on): it claims runs whose worker is gone and cancels runs left paused for a week. At most 4 workers per process. A run paused for `smartlead_lead_limit` is only resumed by a user.
- Audit: each run records who pushed, with which key, the options, the warnings shown and the acknowledgements; start, resume, cancel and the resumer log one line each (no lead data, no key).

### Tests
`smartleadPushToken.test.ts` (8), `smartleadPushPreview.test.ts` (10), `routes/__tests__/smartleadPush.test.ts` (16, supertest with the service mocked), and `smartleadPushService.dynamodbLocal.test.ts` (23, opt-in with `DYNAMODB_LOCAL_ENDPOINT`: the real run store with in-memory CRM and Smartlead fakes, including a two-starter race and the resumer taking over a dead worker). Live on env1 (real HTTP, real Smartlead, real tables): preview, start, completion, a second preview showing everything already pushed, a replayed token sending nothing, and cleanup.

### Known limits
- The kill switch is an environment variable: changing it on a deployed environment needs a restart. A runtime toggle is a tracked follow-up.
- Preview reads a whole list into memory (refused above 50,000 leads).
- Paused/partial runs are cancelled after a week counted from the run's last lease.
- Not yet: the Emma push tool, the portal dialog (PR-E), the opt-out safeguards for AgentWeb's own senders and the withdrawal sweep (PR-D, which must merge before the first real push).
