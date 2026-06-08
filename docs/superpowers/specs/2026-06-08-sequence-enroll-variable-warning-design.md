# Sequence Enroll: Missing-Variable Warning

**Date:** 2026-06-08
**Branch:** harshit/crm-sequence-bug-fixes
**Status:** Approved design — ready for implementation plan

## Problem

When a user enrolls a lead list into a drip sequence via the "Enroll Leads from a
list" dialog, the sequence's email and LinkedIn message templates may reference
variables (e.g. `{{firstName}}`, `{{customFields.region}}`) that aren't populated
on the leads in that list. Today enrollment happens immediately with no feedback,
so those leads silently receive messages with blank variables.

We want to **check the sequence's template variables against the selected list's
leads at enroll time, warn the user about any gaps, and let them proceed anyway**.

## Scope

**In scope:** the by-list "Enroll Leads from a list" dialog in
`customer-portal/src/components/crm/SequencesTab.tsx` (the `EnrollmentDetail`
enroll flow → `handleEnrollFromList` → `POST /enrollments/by-list`).

**Out of scope:**
- Background **auto-enroll** (no human present to see a warning).
- The per-lead **"Add to Sequence"** flow from the CRM list view.
- Changing how variables are substituted at send time (already fixed separately —
  `customFields` now flow through `msgVars` in `dripSequenceWorker.ts`).

## Confirmed Decisions

1. **Trigger:** a variable is "missing" if it is empty/absent for **any** lead in
   the list. Warn with **per-variable counts** ("missing for N of M leads").
2. **Timing:** **gate on click.** When the user clicks "Enroll All Leads", run the
   check first. If anything is missing, **hold** enrollment and show the warning;
   the button becomes **"Enroll Anyway"**. A second click performs the real enroll.
   If nothing is missing, enroll immediately (no added friction).
3. **Channels:** check email `subject` + `bodyHtml` **and** LinkedIn `messageText`
   across **all** steps of the sequence.
4. **Excluded variables:** sender-sourced vars (`senderName`, `senderEmail`) are
   excluded from the coverage check — they come from the user, not the lead, so
   checking them against leads would be a false positive. `unsubscribeUrl` /
   `unsubscribe_url` are already excluded by `extractVariables`.

## Existing Building Blocks (reused, not rebuilt)

In `backend/src/utils/emailVariables.ts`:
- `extractVariables(template: string): string[]` — pulls `{{...}}` tokens; already
  skips `unsubscribeUrl`/`unsubscribe_url`.
- `leadHasVariable(lead, varName): boolean` — true if the lead has a non-empty value
  for the variable; understands `customFields.*` dot-paths.

There is also an existing single-step endpoint
`POST /:sequenceId/steps/verify-variables` used during step editing. We will **not**
overload it — it is wired to single email subject/body editing. A dedicated
enrollment-check endpoint keeps responsibilities clean and independently testable.

## Design

### Backend — new endpoint

`POST /api/crm/sequences/:sequenceId/enrollments/by-list/check-variables`

Request body: `{ listId: string }`

Logic:
1. Auth (same `authenticateToken` as siblings); 401 if no user.
2. Load the sequence (`dripSequenceDb.getSequence`); 404 if missing.
3. Gather templates from every step across channels:
   - email steps: `step.subject` + `step.bodyHtml`
   - LinkedIn steps: `step.messageText`
   - (A step that is email-only won't have `messageText`, and vice-versa — just
     concatenate whatever string fields are present.)
4. `extractVariables()` over the concatenated template text → unique variable list.
5. Remove sender-sourced vars: filter out anything in
   `SENDER_VARS = new Set(['senderName', 'senderEmail'])`.
6. Load the list's leads (`crmDb.getLeadsByListId`, handling the array/`items`/`leads`
   shapes the existing verify-variables endpoint already handles).
7. For each remaining variable, count `present` / `missing` across leads via
   `leadHasVariable`.
8. Respond:
   ```json
   {
     "leadCount": 40,
     "variables": ["firstName", "customFields.region"],
     "missing": [
       { "variable": "customFields.region", "missing": 12, "present": 28 }
     ]
   }
   ```
   `missing` contains only variables with `missing > 0` (the warning list). An empty
   `missing` array means "all clear".

Response shape note: we return a pre-filtered `missing` array (only vars with gaps)
so the frontend can treat "warn?" as simply `missing.length > 0`, while still
exposing full `variables` for completeness.

### Frontend — `EnrollmentDetail` enroll dialog

State additions:
- `checking: boolean` — check request in flight.
- `varWarning: { variable: string; missing: number; present: number }[] | null` —
  populated when the check finds gaps; drives the warning panel.
- `leadCount: number | null` — for "N of M leads" phrasing.

Flow change in the dialog footer button:
- **First click ("Enroll All Leads")** → call `check-variables`.
  - On `missing.length === 0` → proceed straight to the existing `handleEnrollFromList`.
  - On `missing.length > 0` → set `varWarning`, render the warning panel, change the
    button label to **"Enroll Anyway"**. Do **not** enroll yet.
- **Second click ("Enroll Anyway")** → call the existing `handleEnrollFromList`
  (real `POST /enrollments/by-list`), then show the existing success summary.
- Selecting a different list resets `varWarning` (back to first-click behavior).
- Cancel/close resets all the new state.

Warning panel content (inside the existing dialog, above the footer):
- A short heading, e.g. "Some message variables aren't filled in for this list."
- A list of rows: `{{customFields.region}}` — "missing for 12 of 40 leads".
- A one-line note that those leads will receive blank values for those variables.

No new design-system components are needed — reuse existing alert/border styling
already present in the file.

### Error handling

- Check endpoint failure (network/500): don't block the user. Log it and fall back
  to the current behavior (allow enroll). Rationale: the warning is advisory; a
  check outage shouldn't prevent enrollment.
- Empty list (0 leads): `leadCount = 0`, `missing = []` → no warning, normal enroll.

## Testing

### Backend (TDD — write failing tests first)
New file `backend/src/__tests__/sequences.checkVariables.test.ts` (or extend
`sequences.test.ts` following its existing style):
1. **Custom field missing** → a `{{customFields.region}}` referenced in a step is
   absent on some leads → response `missing` includes it with correct counts. (FAIL)
2. **LinkedIn messageText variable** → a var only present in a LinkedIn step's
   `messageText` is included in the check. (FAIL)
3. **Sender vars excluded** → `{{senderName}}`/`{{senderEmail}}` in a template never
   appear in `missing` even though no lead has them. (FAIL)
4. **All present** → every referenced var populated on all leads → `missing` empty. (SUCCESS)
5. **Empty list** → 0 leads → `missing` empty, `leadCount` 0, 200 response.
6. **Sequence not found** → 404.

### Frontend
Follow existing component-test conventions in `customer-portal`:
- Clicking "Enroll All Leads" with missing vars shows the warning and does **not**
  call the enroll endpoint; button becomes "Enroll Anyway".
- Clicking "Enroll Anyway" calls the enroll endpoint.
- Clean list (no missing vars) enrolls on first click without a warning.

## Known Limitations (acceptable for v1)

- **Aliased variables** (e.g. `{{first name}}` resolved via `VARIABLE_ALIASES` at
  send time) are returned verbatim by `extractVariables` and won't be resolved by
  `leadHasVariable`, so they could show as false-positive "missing". Standard
  canonical tokens (`{{firstName}}`) and `{{customFields.*}}` — the common cases —
  work correctly. Alias resolution can be a follow-up if needed.
- The check counts a variable as "present" when the lead field is a non-empty value;
  it does not validate format/content.

## Files Touched

- `backend/src/routes/sequences.ts` — new `check-variables` endpoint.
- `backend/src/__tests__/sequences.checkVariables.test.ts` — new tests.
- `customer-portal/src/components/crm/SequencesTab.tsx` — gate-on-click flow + warning panel.
- (Frontend test file per existing conventions.)
- Reuses `backend/src/utils/emailVariables.ts` (`extractVariables`, `leadHasVariable`) unchanged.
