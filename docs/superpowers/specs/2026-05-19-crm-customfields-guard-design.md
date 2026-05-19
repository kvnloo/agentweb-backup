# CRM `customFields` Corruption Guard — Design

**Date:** 2026-05-19
**Author:** harshit
**Branch:** `harshit/bug-crm-character-indexed-leads`
**Status:** Approved (design phase)

## Background

A CRM lead list (`list_1775001347573_e45x9md6x`, "Fangfang Tan outreach list") contains ~141 leads whose `customFields` is stored as a character-indexed object — keys `"0", "1", "2", ...` each mapping to a single character. Example:

```json
{ "customFields": { "0": "{", "1": "\"", "2": "f", "3": "i", ... } }
```

Affected window: leads created roughly 2026-04-10 → 2026-04-25. Impact: those leads return empty `firstName`/`lastName`/`title` over the API and could not be migrated during a list merge (276 of 417 leads were copied).

The corruption signature exactly matches the result of object-spreading a string in JavaScript:

```js
const s = '{"firstName":"David",...}';
{ ...s } // → { "0": "{", "1": "\"", "2": "f", ... }
```

## Root-cause class

`Lead.customFields` is typed `Record<string, any>`, but at runtime nothing enforces it. Several code paths merge `customFields` with the spread operator:

| File | Line | Pattern |
| --- | --- | --- |
| `backend/src/services/db.ts` | 5565–5569 | `{ ...existingCustomFields, ...newCustomFields }` (batchCreateLeads merge branch) |
| `backend/src/services/crmEnrichmentServiceV3.ts` | 454 | `{ ...enrichedLead.customFields, [f.field]: f.value }` |
| `backend/src/services/crmAutoSyncService.ts` | 145 | `{ ...(existingLead.customFields || {}), ...customFieldsPatch }` |
| `backend/src/routes/webhooks.ts` | 783 | `{ ...lead.customFields, ...customFieldUpdates }` (HubSpot legacy) |
| `backend/src/routes/crmWebhook.ts` | 190 | `{ ...(lead.customFields || {}), ...customFieldUpdates }` (CRM webhook) |
| `backend/src/services/agentModeService.ts` | 22230 | `{ ...(lead.customFields ?? {}), location: item.location }` (importLeadsFromSearch) |

If any of these reads a lead where `customFields` is a string (e.g., a webhook or external CRM adapter previously persisted it stringified), the spread produces the character-indexed object and writes it back. The corruption is then sticky — the next merge re-spreads it. TypeScript does not catch this because all reads come back as `any` from DynamoDB.

A write-boundary check alone would not prevent this: the corrupted shape is a plain object by the time it reaches the DB layer, so `typeof === 'object'` passes. The guard must execute **at the merge point**.

## Goal

Prevent this class of corruption from being generated again. Out of scope: recovering the existing 141 corrupted leads (manual fix per user).

Non-goals:

- No read-time auto-heal — corrupt rows continue to return what is in DDB until manually fixed.
- No backfill / repair migration script.
- No throw-on-detect behavior — silent sanitize + error-log only.

## Design

### 1. New module — `backend/src/utils/customFieldsGuard.ts`

A pure-function module (no I/O, no async) with three exports:

```ts
type LogContext = { listId?: string; leadId?: string; source: string };

/** Returns true iff value is a plain Object whose prototype is Object.prototype.
 *  False for: null, undefined, primitives, strings, arrays, Buffers, Maps,
 *  Sets, class instances. */
export function isPlainCustomFieldsObject(v: unknown): v is Record<string, any>;

/** Returns v if it is a plain object; otherwise logs an error (with caller
 *  stack) and returns {}.  Write proceeds normally — never throws. */
export function sanitizeCustomFields(v: unknown, ctx: LogContext): Record<string, any>;

/** Safe replacement for `{ ...existing, ...patch }` when one or both sides
 *  may have been corrupted upstream.  Runs each side through
 *  sanitizeCustomFields before spreading. */
export function mergeCustomFields(
  existing: unknown,
  patch: unknown,
  ctx: LogContext,
): Record<string, any>;
```

**Predicate:** `isPlainCustomFieldsObject` uses `typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype`. Rejects strings (the bug source) and arrays (a different class of accidental corruption) without false positives on legitimate objects whose keys happen to be numeric strings.

**Log shape:** `console.error('[customFieldsGuard] non-object customFields coerced to {}', { source, listId, leadId, type: typeof v, isArray: Array.isArray(v), stack: new Error().stack })`. Stack trace makes the offending caller identifiable in Elastic Beanstalk logs.

### 2. Replace inline spreads (call-site layer)

Six known spread sites — replace `{ ...lead.customFields, ...patch }` with `mergeCustomFields(lead.customFields, patch, { listId, leadId, source: '<short tag>' })`:

1. `services/db.ts` — batchCreateLeads update-merge branch (~line 5565)
2. `services/crmEnrichmentServiceV3.ts:454` — tier0b sibling-fill
3. `services/crmAutoSyncService.ts:145` — user → lead auto-sync
4. `routes/webhooks.ts:783` — HubSpot legacy webhook
5. `routes/crmWebhook.ts:190` — external CRM webhook handler
6. `services/agentModeService.ts:22230` — importLeadsFromSearch location patch

For (6), the existing pattern is `{ ...(lead.customFields ?? {}), location }`. The replacement is `mergeCustomFields(lead.customFields, { location: item.location }, { source: 'importLeadsFromSearch' })`.

### 3. Sanitize at DB write boundary (defense-in-depth)

In `services/db.ts`, sanitize `customFields` immediately before it is written into the DDB item:

- `createLead` (~line 4334) — wrap `leadData.customFields || {}` with `sanitizeCustomFields(..., { listId, source: 'createLead' })`.
- `batchCreateLeads` (~line 5360, in the new-lead `writeRequests` map) — same wrap per lead.
- `updateLead` / `setLeadFields` — wherever `customFields` is placed into `ExpressionAttributeValues[':customFields']`, sanitize first.

This catches any future caller that writes `customFields` directly (bypassing the merge helper) with a non-object value, including third-party-supplied JSON strings flowing through webhook handlers.

### 4. Tests (TDD per project Rule 2)

New file: `backend/src/__tests__/customFieldsGuard.test.ts`.

**FAIL cases (predicate must reject):**

1. String input (`'{"firstName":"x"}'`) → `isPlainCustomFieldsObject === false`; `sanitizeCustomFields` returns `{}`; `console.error` called.
2. Array input (`['a','b']`) → coerced to `{}`.
3. `null` input → coerced to `{}`.
4. `undefined` input → coerced to `{}`.
5. Number input (`42`) → coerced to `{}`.
6. `mergeCustomFields(stringValue, patch)` → result equals `patch`; the corrupted side is dropped.
7. `mergeCustomFields(existingCharIndexedObject, patch)` — already-corrupted plain object (`{"0":"{","1":"\"",...}`) — predicate currently passes it (it IS a plain object), but a follow-up explicit test documents that already-corrupt rows are NOT auto-healed; merge result still contains the numeric keys. This is intentional per "no read-time auto-heal" non-goal.

**SUCCESS cases:**

1. Normal object → `isPlainCustomFieldsObject === true`; `sanitizeCustomFields` returns same reference.
2. Empty object → unchanged.
3. `mergeCustomFields({a:1}, {b:2})` → `{a:1, b:2}`.
4. Key collision: `mergeCustomFields({a:1}, {a:2})` → `{a:2}` (patch wins, matches native spread).
5. Numeric-string keys with non-char values (`{"1": "Yes", "2": "No"}`) → preserved as-is (no false positive).

**Integration tests:** extend the existing test files to cover the corrupted-existing case:

- `crmAutoSyncService.test.ts` — existing lead with `customFields: '{"x":1}'` (string) + patch `{subscriptionType: 'Pro'}` → resulting write contains `customFields: { subscriptionType: 'Pro' }` only (corrupted side cleared).
- `crmEnrichmentService` / V3 — tier0b path where lead.customFields was previously a string → enrichment writes a clean object with only the sibling-filled fields.

Per Rule 2, all FAIL tests must be authored first and observed to fail before any implementation lands.

### 5. Verification

- `npx tsc` clean.
- `npm test` — new + existing all pass.
- No production behavior change for non-corrupt rows (the predicate is a no-op fast path for plain objects).

### 6. Operational

After deploy: watch EB logs for `[customFieldsGuard] non-object customFields coerced to {}`. Each occurrence prints the stack trace of the upstream caller and the listId / leadId. Use these to identify and fix the original source of corrupted writes (likely a webhook adapter or an LLM-tool argument that JSON-stringified by mistake).

## File summary

**New:**

- `backend/src/utils/customFieldsGuard.ts`
- `backend/src/__tests__/customFieldsGuard.test.ts`

**Modified (call-site swaps):**

- `backend/src/services/db.ts` (3 sites: createLead, batchCreateLeads new + merge branches, updateLead/setLeadFields)
- `backend/src/services/crmEnrichmentServiceV3.ts`
- `backend/src/services/crmAutoSyncService.ts`
- `backend/src/routes/webhooks.ts`
- `backend/src/routes/crmWebhook.ts`
- `backend/src/services/agentModeService.ts`

**Modified (integration test extensions):**

The plan will identify the existing test files that cover `crmAutoSyncService` and `crmEnrichmentServiceV3` and add the corrupted-existing-customFields case to each. If a coherent test file does not yet exist for one of them, the plan creates a minimal one.

## Decision log

- Module location: `utils/` rather than `services/` — pure functions, no I/O.
- Behavior on detection: silent sanitize to `{}` + `console.error` with stack trace. Not throw, not env-dependent.
- Detection rule: non-plain-object → coerce. Char-indexed-pattern detection NOT implemented (would risk false positives on legitimate numeric-keyed customFields).
- Scope: write/merge prevention only. No backfill, no read-time healing.
