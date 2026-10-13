## ENG-2171: HubSpot batched push now updates by stored contact id instead of orphaning it (2026-10-13)

**Bug.** `pushLeadsBatched` split leads on email alone, upserted by email and overwrote `syncMetadata.hubspot_contact_id` at Stage 3. A lead first pushed without an email (contact A) and later given one produced contact B and orphaned A. #3026 fixed this only in `pushLeadsPerLead`, but `batchEnabled()` defaults true (the env var is set nowhere), so email leads never reach that path. `autoSyncLead` (the real-time `/forward-lead` sync) also takes the batched path.

**Fix** (`hubspotAdapter.ts`, Stage 1.5): an email lead with a stored id (`syncMetadata.hubspot_contact_id`, or `customFields.hubspot_contact_id` as the per-lead path reads) is updated by id through `batchUpdateContacts`, with the email in the properties, so A gains the address in place. This changes the NORMAL re-push path for every previously synced email lead, not only phone-only ones. A side effect is that an email edited in Emma now updates the contact instead of creating a second one.

**Failure rules** (HubSpot documents none of these for contact batch update, so unknowns fail closed):
- "Gone" = 404/410, or a 207 whose every error category matches `NOT_FOUND`. Only then does the lead fall back to upsert-by-email (new id replaces the stale one), as the per-lead path does.
- Anything else (409 collision, 400, other 207, merged id) is a lead error: `sync_failed`, stored id kept, nothing created.
- 429 / 423 / 5xx / no response fail the chunk once; they are not bisected.
- Duplicate stored ids collapse to one input. A lead with no stored id that shares an email with an updated stored-id lead adopts that contact (no read-after-write on an email just written).

**Kill switch.** `HUBSPOT_PUSH_BY_STORED_ID=off` restores upsert-by-email for every email lead. It is an Elastic Beanstalk env var, so changing it needs a restart.

**Not live-verified.** The only connected HubSpot credential was dead (401, last pull 2026-06-16) and no `[HubspotAdapter]` line appeared in the production log for 7 days, so there was no HubSpot to test against. HubSpot's docs are silent on: the missing-id and archived-id response, batch-update atomicity, duplicate ids in one batch, the email-collision status, merged-away ids, and read-after-write for upsert-by-email. The `OBJECT_NOT_FOUND` category does not appear in the docs at all (the existing deal handler matches it too). If the "gone" classifier is wrong, a deleted-contact lead shows `sync_failed` and stays stuck; it does not duplicate. A merged-away id has the same effect. HubSpot's `contact.merge` webhook (`primaryObjectId`, `mergedObjectIds`) is documented but not handled by `crmWebhook.ts` or `webhooks.ts`.

`HUBSPOT_BATCH_PUSH_ENABLED` is left in place; deleting it is a later change.
