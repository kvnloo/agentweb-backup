# Sequence Enroll: Missing-Variable Warning

**Date:** 2026-06-08
**Branch:** harshit/crm-sequence-bug-fixes
**Status:** Approved design (revised post-CTO review) — ready for implementation plan

## Problem

When a user enrolls a lead list into a drip sequence via the "Enroll Leads from a
list" dialog, the sequence's email and LinkedIn message templates may reference
variables (e.g. `{{firstName}}`, `{{customFields.region}}`) that aren't populated
on the leads in that list. Today enrollment happens immediately with no feedback,
so those leads silently receive messages with blank variables.

We want to **check the sequence's template variables against the selected list's
leads at enroll time, warn the user about any gaps, and let them proceed anyway.**

## Scope

**In scope:** the by-list "Enroll Leads from a list" dialog in
`customer-portal/src/components/crm/SequencesTab.tsx` (`EnrollmentDetail` →
`handleEnrollFromList` → `POST /enrollments/by-list`).

**Coupled fixes pulled in (see CTO review below):**
- Worker variable forwarding (`dripSequenceWorker.ts`) — so the check reflects what
  actually gets substituted.
- Paginated lead loading (`db.ts`) — so counts are correct and the existing enroll
  stops silently truncating large lists.

**Out of scope:** background **auto-enroll** (no human present — see Known Gaps),
the per-lead **"Add to Sequence"** flow, and supporting arbitrary lead fields beyond
the substitution engine's known set.

## CTO Review Findings (validated against code, now folded in)

1. **The check must validate what is actually substituted, not raw lead fields.**
   `STANDARD_FIELDS` (`emailVariables.ts:3`) =
   `['firstName','lastName','email','company','title','senderName','senderEmail']`,
   but the worker's `msgVars` (`dripSequenceWorker.ts:111`) only forwards
   `firstName,lastName,email,company,senderName,senderEmail,customFields` — **`title`
   is missing**, so `{{title}}` always renders blank even when the lead has a title.
   Validating with `leadHasVariable` against raw lead fields would therefore give a
   false "all clear." **Fix:** forward all engine-supported standard fields in the
   worker (add `title`), and scope the check to the engine's known variable set.
2. **Lead loading truncates large lists.** `getLeadsByListId` (`db.ts:4683`) is a
   single ~1MB-capped DynamoDB query returning `LastEvaluatedKey`; the enroll path
   (`sequences.ts:208`) consumes `.items` with no pagination loop, so large lists are
   silently under-enrolled today, and any "N of M" count would be wrong. **Fix:**
   paginate (pattern already exists at `db.ts:4254`).
3. **One round-trip, one lead read.** Rather than a separate check endpoint that
   re-loads all leads, fold the check into the existing enroll endpoint via a
   `confirm` flag (details below). Avoids double DynamoDB cost and time-of-check/
   time-of-use drift.
4. **List ownership is unchecked.** Enroll verifies `sequence.userId`
   (`sequences.ts:202`) but not that the list belongs to the caller. **Fix:** verify
   via `getLeadListById` + `list.userId === userId` (helper near `db.ts:3819`).
5. **Auto-enroll gap** is accepted for v1 and documented under Known Gaps.

## Confirmed Product Decisions

1. **Trigger:** a *supported* variable is "missing" if it is empty/absent for **any**
   lead in the list. Warn with per-variable counts ("missing for N of M leads").
2. **Severity split (added):** distinguish two cases so the warning stays honest and
   doesn't cry wolf with a single bucket:
   - **Unsupported variable** — a token the engine cannot fill for *anyone*
     (not a standard field and not `customFields.*`). Always blank/literal. Strong
     warning.
   - **Missing data** — a supported variable empty on some leads. Counted warning.
3. **Timing:** **gate on click.** Clicking "Enroll All Leads" runs the check; if
   anything is flagged, **hold** enrollment and show the warning; the button becomes
   **"Enroll Anyway."** A second click performs the real enroll. Clean lists enroll
   on first click (no friction).
4. **Channels:** check email `subject` + `bodyHtml` **and** LinkedIn `messageText`
   across **all** steps.
5. **Excluded from the lead check:** `senderName`, `senderEmail` (user-sourced) and
   `unsubscribeUrl`/`unsubscribe_url` (already excluded by `extractVariables`).

## Existing Building Blocks (reused)

`backend/src/utils/emailVariables.ts`:
- `extractVariables(template)` — pulls `{{...}}` tokens; already skips unsubscribe vars.
- `leadHasVariable(lead, varName)` — non-empty check, understands `customFields.*`.
- `STANDARD_FIELDS` — the engine's known standard variable set.

We will export/derive a **supported-variable set** = `STANDARD_FIELDS` minus
`senderName`/`senderEmail`, plus any `customFields.*`. A token not in this set is
classified "unsupported."

## Design

### A. Worker fix — forward `title` (and align with `STANDARD_FIELDS`)

In `dripSequenceWorker.ts`, add the engine-supported standard fields that are
currently dropped so substitution is truthful:

```js
const msgVars: Record<string, any> = {
  firstName: lead?.firstName ?? '',
  lastName:  lead?.lastName ?? '',
  email:     enrollment.leadEmail,
  company:   lead?.company ?? '',
  title:     lead?.title ?? '',        // ← was missing; {{title}} rendered blank
  senderName: user?.displayName ?? user?.name ?? '',
  senderEmail: user?.email ?? '',
  customFields: lead?.customFields ?? {},
};
```

This is a real bug fix in its own right and makes the enroll check meaningful.
Supporting arbitrary non-standard fields (e.g. `{{phone}}`) would require changing
`substituteVariables` itself and is explicitly out of scope.

### B. Paginated lead loading

Add `getAllLeadsByListId(listId)` to `db.ts` (or an inline loop) that pages until
`lastEvaluatedKey` is null, reusing the pattern at `db.ts:4254`. Use it in the
enroll endpoint in place of the single-page `getLeadsByListId` call, fixing the
existing truncation. The same loaded array feeds both coverage and enrollment.

### C. Enroll endpoint — `confirm` flag (no separate endpoint)

Extend `POST /api/crm/sequences/:sequenceId/enrollments/by-list`.
Request body adds: `confirm?: boolean`.

Flow:
1. Existing auth + `sequence.userId` check (unchanged).
2. **New:** verify list ownership (`getLeadListById` + `list.userId === userId`) → 403 otherwise.
3. Load **all** leads (paginated, B).
4. Gather templates across all steps and channels (email `subject`+`bodyHtml`,
   LinkedIn `messageText`); `extractVariables` over the combined text.
5. Partition variables into **supported** vs **unsupported** (per the supported set).
   For supported vars, compute `present`/`missing` over the leads via `leadHasVariable`.
6. Build `warnings = { unsupported: string[], missing: [{variable, missing, present}] }`.
7. **If** (`unsupported.length || missing.length`) **and not** `confirm` → return
   **without enrolling**:
   ```json
   { "enrolled": false, "needsConfirmation": true,
     "leadCount": 40, "warnings": { "unsupported": ["phone"],
       "missing": [{ "variable": "customFields.region", "missing": 12, "present": 28 }] } }
   ```
8. **Else** (clean, or `confirm: true`) → proceed with the existing `bulkEnroll`
   + auto-enroll-list update, and return the normal result (optionally echoing
   `warnings` for display).

This keeps a single code path and a single lead read per click.

### D. Frontend — `EnrollmentDetail` enroll dialog

State additions: `checking`, `warnings` (`{ unsupported, missing } | null`), `leadCount`.

Footer button behavior:
- **First click** → POST enroll **without** `confirm`.
  - `needsConfirmation` true → store `warnings`/`leadCount`, render warning panel,
    relabel button **"Enroll Anyway."** No enrollment yet.
  - Otherwise (normal result) → show existing success summary.
- **Second click ("Enroll Anyway")** → POST enroll with `confirm: true` → success summary.
- Changing the selected list or closing the dialog resets `warnings`.

Warning panel (inside the dialog, above the footer), two sections when present:
- **"These variables can't be filled"** (unsupported) — list tokens; note they will
  appear blank/literal for every lead.
- **"Missing for some leads"** — rows like `{{customFields.region}}` — "missing for
  12 of 40 leads."

Reuse existing alert/border styling in the file; no new design-system components.

### E. Error handling

- Enroll/check failure (network/500): surface the existing error path; do not
  invent a blocking state. (The check now lives inside enroll, so there is no
  separate advisory call to fail open on.)
- Empty list (0 leads): `leadCount = 0`, no missing-data warnings; unsupported-token
  warnings still apply (they're list-independent) — enroll proceeds on confirm.

## Testing

### Backend (TDD — failing tests first)
Extend `backend/src/__tests__/sequences.test.ts` (or a new
`sequences.enrollByListConfirm.test.ts`):
1. Supported custom field missing on some leads, no `confirm` →
   `needsConfirmation:true`, correct `missing` counts, **no enrollment performed**. (FAIL)
2. Variable only in a LinkedIn `messageText` step is included in the check. (FAIL)
3. Unsupported token (`{{phone}}`) → appears in `warnings.unsupported`, not in
   `missing`. (FAIL)
4. `senderName`/`senderEmail` never flagged. (FAIL)
5. `confirm:true` with gaps → enrolls and returns normal result. (SUCCESS)
6. Clean list (all supported vars populated) → enrolls on first call, no confirmation. (SUCCESS)
7. Pagination: a list spanning multiple pages is fully loaded (counts use total, not
   first page). (FAIL→fix in B)
8. List not owned by caller → 403.

Worker fix gets its own test (extends `dripSequenceWorker.customFields.test.ts` or a
sibling): `{{title}}` is substituted from the lead. (FAIL→fix in A)

### Frontend
Per existing customer-portal conventions:
- First click with gaps shows the warning and does **not** enroll; button →
  "Enroll Anyway"; second click enrolls.
- Clean list enrolls on first click with no warning.

## Known Gaps (accepted for v1, documented)

- **Auto-enroll is unguarded.** The by-list dialog enables auto-enroll by default
  (`sequences.ts:228`), so leads added to the list *later* are enrolled in the
  background with no variable check. v1 only gates the manual batch. Follow-up:
  surface the same coverage summary on the auto-enroll toggle, or run the check at
  auto-enroll time and skip/flag offending leads.
- **Aliased variables** (`{{first name}}`) returned verbatim by `extractVariables`
  are not resolved by `leadHasVariable` and may classify as unsupported/missing.
  Canonical tokens and `customFields.*` work correctly. Alias resolution is a follow-up.
- **Arbitrary non-standard fields** (`{{phone}}`) aren't substituted by the engine at
  all; they're reported as unsupported rather than newly supported.

## Files Touched

- `backend/src/services/dripSequenceWorker.ts` — forward `title` (worker fix A).
- `backend/src/services/db.ts` — paginated `getAllLeadsByListId` (B).
- `backend/src/routes/sequences.ts` — `confirm` flag, list-ownership check, coverage
  partitioning on the existing by-list enroll endpoint (C).
- `backend/src/__tests__/…` — backend tests above.
- `customer-portal/src/components/crm/SequencesTab.tsx` — gate-on-click + warning panel (D).
- Reuses `backend/src/utils/emailVariables.ts` (`extractVariables`, `leadHasVariable`,
  `STANDARD_FIELDS`); a small supported-variable-set helper may live here.
