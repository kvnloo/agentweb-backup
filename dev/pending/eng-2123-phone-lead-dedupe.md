## ENG-2123: phone-only lead dedupe, shipped dark behind a settings row (2026-10-15)

**Problem.** An email-less form capture takes an ordinary timestamp `leadId` and is never deduped: the same person submitting twice makes two leads. A deterministic `lead_ph_<sha>` id was tried and withdrawn because `getLeadsByListId` pages `leadId` descending and assumes it is time-prefixed (`'p'` sorts above every digit and pins those rows to the top of the list forever).

**What this PR adds. With no settings row it changes nothing the customer can see.**
- `LEAD_PHONE_DEDUPE_MODE` (AW-Settings row, read through `settingsService`, cached 30 s, **any missing row, unknown value or read failure means `off`**): `off` (today) | `create` | `shadow` | `on`. It is a settings row, not an env var, because an env-var change is an environment update on an Immutable environment (about 10-25 minutes to roll back).
- `create`: the phone twin of ENG-2321. An email-less form capture with a specific number gets `lead_<5s-bucket>_<12 hex HMAC(listId:"phone:"+digits)>` written in a transaction that also condition-checks the neighbouring buckets, so concurrent same-number submissions collapse to one row and the id stays time-prefixed (list ordering preserved). A loser gets a typed `duplicatePhone` carrying the winner. Same person: it adopts the winner through the existing merge. A **different** first or last name: it creates its own row on an ordinary id (a shared household or office line must not overwrite the first person).
- `shadow`: `create` plus a lookup on `PhoneKeyIndex` and one log line per capture, `[phone-dedupe] mode=… list=… decision=… candidates=… valid=…`. No phone number, name or lead id is logged. Nothing is merged.
- `on`: `shadow` plus actually merging a repeat visitor into the OLDEST compatible row (by `createdAt`).
- `phoneKey`: a sparse string attribute, digits only, never `""`, written on every email-less **form capture** whose number passes `phoneDedupeKey` (regardless of mode, so the key exists before the index does). Not written for other origins, rows with an email, a linkedin url or sync metadata.

**Safety rules baked in** (`utils/phoneLeadDedupe.ts`): at least 10 digits, at most 15; not all one digit; not an ascending or descending run; a 10-digit number must look like NANP (area code and exchange cannot start with 0 or 1). This is stricter than `isDedupablePhone` (7 digits, length only), which the portal mirrors and which is untouched. More than 5 rows on one key is treated as a shared line and never merged. Candidates from the index are never trusted: each is re-read consistently and must still have no email and the same normalised number, so a stale entry costs a missed dedupe, never a wrong merge. `updateLead` is deliberately not modified. Smoke-test numbers, session lists and any capture that carries an email are excluded.

**Failure handling.** A missing index (`ValidationException … specified index`) or `AccessDenied` is a miss, logged once and not retried for 10 minutes; any other `ValidationException` propagates (a bad expression must not silently disable dedupe). A lookup that throws never fails the capture.

**Operator steps (a human with write access; the autofix role is read-only).**
1. Deploy this to every environment.
2. `NODE_ENV=production npx ts-node src/scripts/backfill-lead-phone-key.ts` (dry run, read-only). Read the counts; the number of eligible rows is not known today because `Scan` on `AW-Leads` is denied to the assistant's role.
3. Same command with `--apply --confirm-table=AW-Leads --rate=25`. It sets `phoneKey` only, conditionally, never touches `updatedAt`, and REMOVEs a legacy `email:""` in the same write.
4. `src/scripts/repair-leads-add-phone-key-index.sh` creates `PhoneKeyIndex` (HASH listId, RANGE phoneKey, KEYS_ONLY) and waits for ACTIVE. It also runs on `Dev-AW-Leads` (`TABLE=Dev-AW-Leads`).
5. Set the AW-Settings row `LEAD_PHONE_DEDUPE_MODE` to `create`, then `shadow`; read the `[phone-dedupe]` lines (name-conflict and shared-line rates) for a week or so; only then `on`.
To roll back at any step, set the row to `off`. `phoneKey` attributes and the index are inert when off.

**Not verified / limits.**
- Not run against a real index: the dev index could not be created from the assistant's role. All lookup behaviour is tested against a fake; the first real query happens in shadow mode.
- The production phone-only population is unknown (the card's 17.5k figure is from 2026-09).
- Rows created by `batchCreateLeads` (CSV, HubSpot and Attio imports) get no `phoneKey` from the write path; the backfill covers existing ones but later imports stay invisible to the lookup.
- A phone edit or an added email after capture leaves a stale key; the validate step makes it harmless, but that lead no longer dedupes.
- Two names that differ only by nickname ("Bob" / "Robert") count as different people: it errs toward keeping two rows.
- A person who submits again WITH an email still gets their own row (unchanged).
