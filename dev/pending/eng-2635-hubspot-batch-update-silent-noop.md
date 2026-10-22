## ENG-2635: HubSpot batch update of a merged-away contact id is a silent no-op (2026-10-22)

**What a real HubSpot does** (recorded on the argusoft.com test portal while running ENG-2464's live check):
`POST /crm/v3/objects/contacts/batch/update` with the id of a *merged-away* contact returns **HTTP 200,
`results: []`, no `errors`**. Nothing is updated. GET and PATCH of the same id are redirected to the survivor
and do apply; only the batch endpoint ignores it. HubSpot also mints a **new** contact id on merge (neither
input id survives), which is why the `contact.merge` handler uses `newObjectId`.

**The bug.** `HubSpotService.batchUpdateContacts` returned `void`, and `HubspotAdapter.updateContactsByStoredId`
added every id in the batch to `updated`. A lead whose stored `hubspot_contact_id` was a merged-away id was
marked `synced` while HubSpot ignored the update. Only reachable when the `contact.merge` rewrite (ENG-2465)
did not run (lost delivery, a merge that predates the subscription).

**The fix.** `batchUpdateContacts` now returns the ids HubSpot echoed in `results` (`undefined` when the body
has no `results` array, meaning "no information"). The adapter treats a requested id that was not echoed as
*gone*, so it falls back to upsert-by-email, which finds the survivor and stores its id. Two lifecycle-stage
callers still ignore the return value (best-effort, unchanged).

**Script.** `backend/scripts/hubspot-live-check.mjs` probed with `@eng2171.example.invalid`, which HubSpot
rejects (`INVALID_EMAIL`), so it could not create its first probe on any real portal. Now
`@eng2171.example.com`; the offline fake rejects `.invalid` like the real thing. The script's refusal to run
on a STANDARD portal is intentional and unchanged.
