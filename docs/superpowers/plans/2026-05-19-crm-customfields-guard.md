# CRM `customFields` Corruption Guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the char-indexed `customFields` corruption (observed on list `list_1775001347573_e45x9md6x`) by introducing a sanitize/merge utility, swapping every inline `{ ...lead.customFields, ...patch }` spread to use it, and sanitizing at the DynamoDB write boundary in `db.ts`.

**Architecture:** New pure-function module `backend/src/utils/customFieldsGuard.ts` exposes `isPlainCustomFieldsObject`, `sanitizeCustomFields`, and `mergeCustomFields`. Call-site swaps eliminate the corruption-at-the-spread vector. Write-boundary sanitizers in `createLead`/`batchCreateLeads`/`updateLead`/`setLeadFields` block any future caller that bypasses the merge helper. Detection rule: non-plain-object → coerce to `{}` + `console.error` with caller stack trace. Never throws.

**Tech Stack:** TypeScript, Jest, DynamoDB (aws-sdk v2 doc-client), Node.js/Express.

**Spec:** `docs/superpowers/specs/2026-05-19-crm-customfields-guard-design.md`

**Branch:** `harshit/bug-crm-character-indexed-leads` (already created from `origin/main`).

---

## File Structure

**New files:**
- `backend/src/utils/customFieldsGuard.ts` — three pure functions, no I/O, no async.
- `backend/src/__tests__/customFieldsGuard.test.ts` — unit tests covering the predicate, sanitizer, and merge helper.

**Modified files (call-site spread → helper):**
- `backend/src/services/db.ts` — `batchCreateLeads` merge branch (~L5565).
- `backend/src/services/crmEnrichmentServiceV3.ts` — `enrichedLead.customFields = { ... }` at L454.
- `backend/src/services/crmAutoSyncService.ts` — `syncUserUpdateToLeadList` at L145.
- `backend/src/routes/webhooks.ts` — HubSpot legacy webhook at L783.
- `backend/src/routes/crmWebhook.ts` — external CRM webhook at L190.
- `backend/src/services/agentModeService.ts` — `importLeadsFromSearch` location patch at L22230.

**Modified files (DB write-boundary sanitize):**
- `backend/src/services/db.ts` — `createLead` (L4334), `batchCreateLeads` new-lead path (L5360), `updateLead` (L4956), `setLeadFields` (L6522).

**Conventions to honor:**
- Project Rule 2 (TDD for backend logic): each behavior-changing task writes failing tests first, observes failure, then implements.
- Project Rule 5 (Simplicity First): the helper is three small functions, no class.
- Project commit-granularity rule: separate commits per logical change. Plan groups commits as: (1) utility + tests, (2) merge call-site swaps, (3) DB write-boundary sanitizers, (4) verification.
- Pre-commit checks: run `npx tsc` and `npm test` after each behavior change.

---

## Task 1: Create `customFieldsGuard` utility (TDD)

**Files:**
- Create: `backend/src/utils/customFieldsGuard.ts`
- Test: `backend/src/__tests__/customFieldsGuard.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `backend/src/__tests__/customFieldsGuard.test.ts` with this exact content:

```ts
import {
  isPlainCustomFieldsObject,
  sanitizeCustomFields,
  mergeCustomFields,
} from '../utils/customFieldsGuard';

describe('customFieldsGuard', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('isPlainCustomFieldsObject', () => {
    it('returns true for plain objects', () => {
      expect(isPlainCustomFieldsObject({})).toBe(true);
      expect(isPlainCustomFieldsObject({ a: 1, b: 'x' })).toBe(true);
    });

    it('returns true for objects with numeric-string keys (no false positive)', () => {
      expect(isPlainCustomFieldsObject({ '1': 'Yes', '2': 'No' })).toBe(true);
    });

    it('returns false for strings', () => {
      expect(isPlainCustomFieldsObject('{"a":1}')).toBe(false);
      expect(isPlainCustomFieldsObject('')).toBe(false);
    });

    it('returns false for arrays', () => {
      expect(isPlainCustomFieldsObject(['a', 'b'])).toBe(false);
      expect(isPlainCustomFieldsObject([])).toBe(false);
    });

    it('returns false for null and undefined', () => {
      expect(isPlainCustomFieldsObject(null)).toBe(false);
      expect(isPlainCustomFieldsObject(undefined)).toBe(false);
    });

    it('returns false for numbers and booleans', () => {
      expect(isPlainCustomFieldsObject(42)).toBe(false);
      expect(isPlainCustomFieldsObject(true)).toBe(false);
    });

    it('returns false for class instances (non-plain objects)', () => {
      class Foo { x = 1; }
      expect(isPlainCustomFieldsObject(new Foo())).toBe(false);
    });

    it('returns false for Map and Set', () => {
      expect(isPlainCustomFieldsObject(new Map())).toBe(false);
      expect(isPlainCustomFieldsObject(new Set())).toBe(false);
    });
  });

  describe('sanitizeCustomFields', () => {
    it('returns input unchanged when it is a plain object', () => {
      const input = { a: 1 };
      const result = sanitizeCustomFields(input, { source: 'test' });
      expect(result).toBe(input);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('coerces a string to {} and logs an error', () => {
      const result = sanitizeCustomFields('{"a":1}', { source: 'test', listId: 'L1', leadId: 'X1' });
      expect(result).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [msg, ctx] = errorSpy.mock.calls[0];
      expect(msg).toContain('[customFieldsGuard]');
      expect(ctx).toMatchObject({ source: 'test', listId: 'L1', leadId: 'X1', type: 'string' });
      expect(typeof ctx.stack).toBe('string');
    });

    it('coerces an array to {} and logs an error', () => {
      const result = sanitizeCustomFields(['a', 'b'], { source: 'test' });
      expect(result).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][1]).toMatchObject({ isArray: true });
    });

    it('coerces null to {}', () => {
      expect(sanitizeCustomFields(null, { source: 'test' })).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('coerces undefined to {}', () => {
      expect(sanitizeCustomFields(undefined, { source: 'test' })).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('coerces a number to {}', () => {
      expect(sanitizeCustomFields(42, { source: 'test' })).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('mergeCustomFields', () => {
    it('merges two plain objects with patch winning on collision', () => {
      const result = mergeCustomFields({ a: 1, b: 2 }, { b: 3, c: 4 }, { source: 'test' });
      expect(result).toEqual({ a: 1, b: 3, c: 4 });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('drops a corrupted (string) existing side and keeps only the patch', () => {
      const result = mergeCustomFields('{"firstName":"David"}', { newKey: 'newVal' }, {
        source: 'test', listId: 'L1', leadId: 'X1',
      });
      expect(result).toEqual({ newKey: 'newVal' });
      // No numeric-string keys from the corrupted string
      expect(Object.keys(result).some((k) => /^\d+$/.test(k))).toBe(false);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('drops a corrupted (string) patch side and keeps only existing', () => {
      const result = mergeCustomFields({ a: 1 }, 'corrupt', { source: 'test' });
      expect(result).toEqual({ a: 1 });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('returns {} when both sides are corrupted', () => {
      const result = mergeCustomFields('a', 'b', { source: 'test' });
      expect(result).toEqual({});
      expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT auto-heal an already-corrupted char-indexed object (documents non-goal)', () => {
      // The corrupted-row pattern that ended up in DDB — a plain object whose
      // keys happen to be numeric strings each mapping to a single character.
      // The predicate passes it (it IS a plain object), so the merge spreads it.
      // This documents the intentional non-goal: no read-time auto-heal.
      const corruptObj = { '0': '{', '1': '"', '2': 'a' };
      const result = mergeCustomFields(corruptObj, { newKey: 'v' }, { source: 'test' });
      expect(result).toEqual({ '0': '{', '1': '"', '2': 'a', newKey: 'v' });
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run the test file to verify all tests fail**

Run:

```bash
cd backend && npx jest src/__tests__/customFieldsGuard.test.ts
```

Expected: All tests fail with `Cannot find module '../utils/customFieldsGuard'`.

- [ ] **Step 3: Create the utility module**

Create `backend/src/utils/customFieldsGuard.ts` with this exact content:

```ts
/**
 * Guard utilities for CRM lead `customFields`.
 *
 * Prevents the char-indexed corruption pattern (e.g. `{"0":"{","1":"\"",…}`)
 * that arises when a code path object-spreads a string into customFields.
 * Detection rule: anything that is not a plain `Object.prototype`-prototyped
 * object is coerced to `{}` and logged via console.error with a stack trace.
 * Never throws — corruption recovery is intentionally silent so writes
 * proceed and the upstream bug source is identifiable from logs.
 *
 * Non-goals: no read-time auto-heal of already-corrupted DDB rows; no
 * JSON-recovery attempts; no env-dependent behavior.
 */

export type LogContext = {
  source: string;
  listId?: string;
  leadId?: string;
};

export function isPlainCustomFieldsObject(v: unknown): v is Record<string, any> {
  if (v === null || v === undefined) return false;
  if (typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  return Object.getPrototypeOf(v) === Object.prototype;
}

export function sanitizeCustomFields(
  v: unknown,
  ctx: LogContext,
): Record<string, any> {
  if (isPlainCustomFieldsObject(v)) return v;
  console.error('[customFieldsGuard] non-object customFields coerced to {}', {
    source: ctx.source,
    listId: ctx.listId,
    leadId: ctx.leadId,
    type: typeof v,
    isArray: Array.isArray(v),
    stack: new Error().stack,
  });
  return {};
}

export function mergeCustomFields(
  existing: unknown,
  patch: unknown,
  ctx: LogContext,
): Record<string, any> {
  return {
    ...sanitizeCustomFields(existing, ctx),
    ...sanitizeCustomFields(patch, ctx),
  };
}
```

- [ ] **Step 4: Run tests again — verify all pass**

```bash
cd backend && npx jest src/__tests__/customFieldsGuard.test.ts
```

Expected: All tests pass (≈ 20 assertions across 3 describe blocks).

- [ ] **Step 5: Run `tsc` for type-safety**

```bash
cd backend && npx tsc
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/customFieldsGuard.ts backend/src/__tests__/customFieldsGuard.test.ts
git commit -m "$(cat <<'EOF'
feat(crm): add customFieldsGuard utility

Pure-function module that prevents char-indexed customFields corruption
(the {"0":"{","1":"\"",…} pattern caused by object-spreading a string).
Three exports: isPlainCustomFieldsObject, sanitizeCustomFields,
mergeCustomFields. Coerce-to-{} + console.error on detection; never
throws.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Swap merge call site — `db.ts` batchCreateLeads merge branch

**Files:**
- Modify: `backend/src/services/db.ts` (around L5565)

- [ ] **Step 1: Read the surrounding context first**

Read `backend/src/services/db.ts` lines 5550–5575 to confirm the current code matches:

```ts
const existingCustomFields = existingLead.customFields || {};
const newCustomFields = newData.customFields || {};
// …normalizeCustomFields helper + diff logic…
const mergedCustomFields = {
  ...existingCustomFields,
  ...newCustomFields,
};
updates.customFields = mergedCustomFields;
```

- [ ] **Step 2: Add the import at the top of `db.ts`**

Find the existing import block near the top of `backend/src/services/db.ts` and add:

```ts
import { mergeCustomFields } from '../utils/customFieldsGuard';
```

Place it next to other utility imports (alphabetically with other `../utils/` imports).

- [ ] **Step 3: Replace the merge spread**

In `backend/src/services/db.ts` around L5565, change:

```ts
              const mergedCustomFields = {
                ...existingCustomFields,
                ...newCustomFields,
              };
              updates.customFields = mergedCustomFields;
```

to:

```ts
              const mergedCustomFields = mergeCustomFields(
                existingCustomFields,
                newCustomFields,
                { source: 'db.batchCreateLeads.merge', listId, leadId: existingLead.leadId },
              );
              updates.customFields = mergedCustomFields;
```

- [ ] **Step 4: Run `tsc`**

```bash
cd backend && npx tsc
```

Expected: No errors.

- [ ] **Step 5: Run the existing db / crm test suite**

```bash
cd backend && npx jest src/__tests__ --testPathPattern='(crm|db)'
```

Expected: All previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/db.ts
git commit -m "$(cat <<'EOF'
fix(crm): use mergeCustomFields in batchCreateLeads merge path

Replaces inline {...existing, ...new} spread that would corrupt the
row if existing.customFields had drifted to a non-object shape.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Swap merge call site — `crmEnrichmentServiceV3.ts` tier0b fill

**Files:**
- Modify: `backend/src/services/crmEnrichmentServiceV3.ts` (around L454)

- [ ] **Step 1: Add the import**

In `backend/src/services/crmEnrichmentServiceV3.ts`, add to the existing import block:

```ts
import { mergeCustomFields } from '../utils/customFieldsGuard';
```

- [ ] **Step 2: Replace the spread**

Around L454, change:

```ts
        enrichedLead.customFields = { ...enrichedLead.customFields, [f.field]: f.value };
```

to:

```ts
        enrichedLead.customFields = mergeCustomFields(
          enrichedLead.customFields,
          { [f.field]: f.value },
          { source: 'crmEnrichmentV3.tier0b', listId: input.listId, leadId: lead.leadId },
        );
```

- [ ] **Step 3: Run `tsc`**

```bash
cd backend && npx tsc
```

Expected: No errors.

- [ ] **Step 4: Run related tests**

```bash
cd backend && npx jest src/__tests__ --testPathPattern='enrichmentV3|crmEnrichment'
```

Expected: All previously-passing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/crmEnrichmentServiceV3.ts
git commit -m "fix(crm): use mergeCustomFields in V3 tier0b sibling fill

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Swap merge call site — `crmAutoSyncService.ts`

**Files:**
- Modify: `backend/src/services/crmAutoSyncService.ts` (around L145)

- [ ] **Step 1: Add the import**

In `backend/src/services/crmAutoSyncService.ts`, add to the existing imports:

```ts
import { mergeCustomFields } from '../utils/customFieldsGuard';
```

- [ ] **Step 2: Replace the spread**

Around L144–146, change:

```ts
    await crmDb.updateLead(parsed.listId, existingLead.leadId, {
      customFields: { ...(existingLead.customFields || {}), ...customFieldsPatch },
    });
```

to:

```ts
    await crmDb.updateLead(parsed.listId, existingLead.leadId, {
      customFields: mergeCustomFields(
        existingLead.customFields,
        customFieldsPatch,
        { source: 'crmAutoSync.syncUserUpdate', listId: parsed.listId, leadId: existingLead.leadId },
      ),
    });
```

- [ ] **Step 3: Run `tsc`**

```bash
cd backend && npx tsc
```

Expected: No errors.

- [ ] **Step 4: Run related tests**

```bash
cd backend && npx jest src/__tests__ --testPathPattern='crmAutoSync|autoSync'
```

Expected: All previously-passing tests still pass (some may not exist — that is fine; `tsc` clean is the gate).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/crmAutoSyncService.ts
git commit -m "fix(crm): use mergeCustomFields in syncUserUpdateToLeadList

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Swap merge call site — `routes/webhooks.ts` HubSpot legacy

**Files:**
- Modify: `backend/src/routes/webhooks.ts` (around L783)

- [ ] **Step 1: Add the import**

In `backend/src/routes/webhooks.ts`, add to the existing imports:

```ts
import { mergeCustomFields } from '../utils/customFieldsGuard';
```

- [ ] **Step 2: Replace the spread**

Around L782–784, change:

```ts
          if (Object.keys(customFieldUpdates).length > 0) {
            updates.customFields = { ...lead.customFields, ...customFieldUpdates };
          }
```

to:

```ts
          if (Object.keys(customFieldUpdates).length > 0) {
            updates.customFields = mergeCustomFields(
              lead.customFields,
              customFieldUpdates,
              { source: 'webhooks.hubspot.legacy', listId: list.listId, leadId: lead.leadId },
            );
          }
```

- [ ] **Step 3: Run `tsc`**

```bash
cd backend && npx tsc
```

Expected: No errors.

- [ ] **Step 4: Run related tests**

```bash
cd backend && npx jest src/__tests__ --testPathPattern='webhook|hubspot'
```

Expected: All previously-passing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/webhooks.ts
git commit -m "fix(crm): use mergeCustomFields in HubSpot legacy webhook

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Swap merge call site — `routes/crmWebhook.ts`

**Files:**
- Modify: `backend/src/routes/crmWebhook.ts` (around L190)

- [ ] **Step 1: Add the import**

In `backend/src/routes/crmWebhook.ts`, add to the existing imports:

```ts
import { mergeCustomFields } from '../utils/customFieldsGuard';
```

- [ ] **Step 2: Replace the spread**

Around L188–191, change:

```ts
      const mergedCustomFields = Object.keys(customFieldUpdates).length > 0
        ? { ...(lead.customFields || {}), ...customFieldUpdates }
        : undefined;
```

to:

```ts
      const mergedCustomFields = Object.keys(customFieldUpdates).length > 0
        ? mergeCustomFields(
            lead.customFields,
            customFieldUpdates,
            { source: 'crmWebhook.hubspot', listId, leadId: lead.leadId },
          )
        : undefined;
```

- [ ] **Step 3: Run `tsc`**

```bash
cd backend && npx tsc
```

Expected: No errors.

- [ ] **Step 4: Run related tests**

```bash
cd backend && npx jest src/__tests__ --testPathPattern='crmWebhook|webhook'
```

Expected: All previously-passing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/crmWebhook.ts
git commit -m "fix(crm): use mergeCustomFields in CRM webhook handler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Swap merge call site — `agentModeService.ts` importLeadsFromSearch

**Files:**
- Modify: `backend/src/services/agentModeService.ts` (around L22230)

- [ ] **Step 1: Add the import**

In `backend/src/services/agentModeService.ts`, add to the existing imports near the top of the file:

```ts
import { mergeCustomFields } from '../utils/customFieldsGuard';
```

- [ ] **Step 2: Replace the spread**

Around L22229–22231 (inside the `items.map((item: any) => { … })` block in `importLeadsFromSearch`), change:

```ts
        if (item.location) {
          lead.customFields = { ...(lead.customFields ?? {}), location: item.location };
        }
```

to:

```ts
        if (item.location) {
          lead.customFields = mergeCustomFields(
            lead.customFields,
            { location: item.location },
            { source: 'agentMode.importLeadsFromSearch' },
          );
        }
```

(No `listId` / `leadId` available at this point — the lead has not yet been persisted. The `source` is sufficient to identify the path in logs.)

- [ ] **Step 3: Run `tsc`**

```bash
cd backend && npx tsc
```

Expected: No errors.

- [ ] **Step 4: Run related tests**

```bash
cd backend && npx jest src/__tests__ --testPathPattern='importLeadsFromSearch|agentModeService'
```

Expected: All previously-passing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/agentModeService.ts
git commit -m "fix(crm): use mergeCustomFields in importLeadsFromSearch location patch

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: DB write-boundary sanitizer — `createLead` (TDD)

**Files:**
- Modify: `backend/src/services/db.ts` (around L4334)
- Test: extend an existing `crmDb.createLead*` test file or create a focused one.

- [ ] **Step 1: Find the existing createLead test file**

Run:

```bash
ls backend/src/__tests__ | grep -i 'createLead\|crmDb'
```

Use the file that already exercises `createLead` (e.g. `crmDb.createLead.userId.test.ts`). If none has the right harness, create `backend/src/__tests__/crmDb.createLead.customFieldsGuard.test.ts` mirroring the pattern of `crmDb.createLead.userId.test.ts`.

- [ ] **Step 2: Write the failing test**

Append (or place in the new test file) a test case using the same mock-`dynamodb` pattern other crmDb tests already use:

```ts
import { crmDb } from '../services/db';

// Mocks for `aws-sdk` dynamodb.put / .get must follow the existing pattern
// in crmDb.createLead.userId.test.ts. The test below captures the `Item`
// passed to `dynamodb.put` and asserts that customFields was sanitized.

it('createLead coerces string customFields to {} and logs an error', async () => {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const captured: any = {};
  // …mock dynamodb.put to capture params (follow existing helper)…

  await crmDb.createLead('list-1', {
    email: 'a@b.com',
    // @ts-expect-error — intentionally pass a string to simulate upstream corruption
    customFields: '{"x":1}',
  });

  expect(captured.Item.customFields).toEqual({});
  expect(errorSpy).toHaveBeenCalledWith(
    expect.stringContaining('[customFieldsGuard]'),
    expect.objectContaining({ source: 'db.createLead', type: 'string' }),
  );
  errorSpy.mockRestore();
});
```

(Match the surrounding tests' mocking style — they typically import `aws-sdk` and assign a `DocumentClient.prototype.put = jest.fn(...)` or use `jest.mock('aws-sdk', ...)` at file top. Read the sibling test to confirm before writing.)

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd backend && npx jest src/__tests__/crmDb.createLead.customFieldsGuard.test.ts
```

Expected: FAIL — the assertion that `captured.Item.customFields` equals `{}` fails because today the code stores the string as-is.

- [ ] **Step 4: Apply the sanitizer in `createLead`**

In `backend/src/services/db.ts`, the `import` was already added in Task 2. Update the import to include `sanitizeCustomFields`:

```ts
import { mergeCustomFields, sanitizeCustomFields } from '../utils/customFieldsGuard';
```

Around L4334, change:

```ts
        customFields: leadData.customFields || {},
```

to:

```ts
        customFields: sanitizeCustomFields(leadData.customFields, { source: 'db.createLead', listId }),
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd backend && npx jest src/__tests__/crmDb.createLead.customFieldsGuard.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run `tsc` and the broader test suite**

```bash
cd backend && npx tsc && npx jest src/__tests__ --testPathPattern='createLead|crmDb'
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/db.ts backend/src/__tests__/crmDb.createLead.customFieldsGuard.test.ts
git commit -m "$(cat <<'EOF'
fix(crm): sanitize customFields at createLead write boundary

Coerces non-object customFields to {} and logs the caller, so a
direct corrupted write (bypassing mergeCustomFields) can never
persist.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: DB write-boundary sanitizer — `batchCreateLeads` new-lead path (TDD)

**Files:**
- Modify: `backend/src/services/db.ts` (around L5360)
- Test: new file `backend/src/__tests__/crmDb.batchCreateLeads.customFieldsGuard.test.ts` or extend an existing batchCreate test.

- [ ] **Step 1: Find an existing batchCreateLeads test for mocking pattern**

```bash
grep -rln "batchCreateLeads" backend/src/__tests__ | head -5
```

- [ ] **Step 2: Write the failing test**

Mirror the existing batchCreateLeads test's `aws-sdk` mocks. The new test must assert that when a lead in the input batch has `customFields: 'someString'`, the `Item` written to DDB has `customFields: {}`, and `console.error` was called with `source: 'db.batchCreateLeads.newLead'`.

Exact assertion shape:

```ts
expect(capturedBatchItems[0].customFields).toEqual({});
expect(errorSpy).toHaveBeenCalledWith(
  expect.stringContaining('[customFieldsGuard]'),
  expect.objectContaining({ source: 'db.batchCreateLeads.newLead', type: 'string' }),
);
```

- [ ] **Step 3: Run the test — verify failure**

```bash
cd backend && npx jest src/__tests__/crmDb.batchCreateLeads.customFieldsGuard.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Apply the sanitizer**

In `backend/src/services/db.ts` around L5360 (inside the `batch.map(lead => { … })` block), change:

```ts
            customFields: lead.customFields || {},
```

to:

```ts
            customFields: sanitizeCustomFields(lead.customFields, { source: 'db.batchCreateLeads.newLead', listId, leadId }),
```

- [ ] **Step 5: Verify pass**

```bash
cd backend && npx jest src/__tests__/crmDb.batchCreateLeads.customFieldsGuard.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run `tsc` + adjacent suite**

```bash
cd backend && npx tsc && npx jest src/__tests__ --testPathPattern='batchCreate|crmDb'
```

Expected: All pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/db.ts backend/src/__tests__/crmDb.batchCreateLeads.customFieldsGuard.test.ts
git commit -m "fix(crm): sanitize customFields at batchCreateLeads new-lead boundary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: DB write-boundary sanitizer — `updateLead` (TDD)

**Files:**
- Modify: `backend/src/services/db.ts` (around L4956)
- Test: new file `backend/src/__tests__/crmDb.updateLead.customFieldsGuard.test.ts`

- [ ] **Step 1: Write the failing test**

Mock `dynamodb.update` to capture `ExpressionAttributeValues`. Call `crmDb.updateLead('list-1', 'lead-1', { customFields: 'oops' as any })`. Assert:

```ts
expect(captured.ExpressionAttributeValues[':customFields']).toEqual({});
expect(errorSpy).toHaveBeenCalledWith(
  expect.stringContaining('[customFieldsGuard]'),
  expect.objectContaining({ source: 'db.updateLead', listId: 'list-1', leadId: 'lead-1', type: 'string' }),
);
```

- [ ] **Step 2: Verify failure**

```bash
cd backend && npx jest src/__tests__/crmDb.updateLead.customFieldsGuard.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Apply the sanitizer**

In `backend/src/services/db.ts` around L4955–4958, change:

```ts
      if (updates.customFields !== undefined) {
        setExpressions.push('customFields = :customFields');
        expressionAttributeValues[':customFields'] = updates.customFields;
      }
```

to:

```ts
      if (updates.customFields !== undefined) {
        setExpressions.push('customFields = :customFields');
        expressionAttributeValues[':customFields'] = sanitizeCustomFields(
          updates.customFields,
          { source: 'db.updateLead', listId, leadId },
        );
      }
```

- [ ] **Step 4: Verify pass**

```bash
cd backend && npx jest src/__tests__/crmDb.updateLead.customFieldsGuard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run `tsc` + adjacent suite**

```bash
cd backend && npx tsc && npx jest src/__tests__ --testPathPattern='updateLead|crmDb'
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/db.ts backend/src/__tests__/crmDb.updateLead.customFieldsGuard.test.ts
git commit -m "fix(crm): sanitize customFields at updateLead write boundary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: DB write-boundary sanitizer — `setLeadFields` (TDD)

**Files:**
- Modify: `backend/src/services/db.ts` (around L6522)
- Test: new file `backend/src/__tests__/crmDb.setLeadFields.customFieldsGuard.test.ts`

**Why this differs from updateLead:** `setLeadFields` writes per-key (`customFields.#cf0 = :cf0`) using `Object.entries(options.customFields ?? {})`. If a caller passes a string for `options.customFields`, `Object.entries('xyz')` yields `[['0','x'],['1','y'],['2','z']]` — i.e., it directly produces the char-indexed corruption. The sanitize must occur *before* `Object.entries` runs.

- [ ] **Step 1: Write the failing test**

Capture the DDB update params and assert that when `options.customFields` is a string, no `customFields.#cf*` clauses appear in the `UpdateExpression`, and `console.error` was called with `source: 'db.setLeadFields'`.

Example assertion:

```ts
await crmDb.setLeadFields('list-1', 'lead-1', { customFields: 'corrupt' as any });

expect(captured.UpdateExpression || '').not.toMatch(/customFields\.#cf/);
expect(errorSpy).toHaveBeenCalledWith(
  expect.stringContaining('[customFieldsGuard]'),
  expect.objectContaining({ source: 'db.setLeadFields', listId: 'list-1', leadId: 'lead-1', type: 'string' }),
);
```

(The function early-returns if no write keys remain — that is the desired behavior when the only field provided was corrupt.)

- [ ] **Step 2: Verify failure**

```bash
cd backend && npx jest src/__tests__/crmDb.setLeadFields.customFieldsGuard.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Apply the sanitizer**

In `backend/src/services/db.ts` around the start of `setLeadFields` (just after the early-exit guard near L6440 where `hasCustomKeys` is computed), normalize `options.customFields` once:

Find:

```ts
    const hasMetaKeys = Object.keys(options.enrichmentMetadata ?? {}).length > 0;
    const hasCustomKeys = Object.keys(options.customFields ?? {}).length > 0;
```

Replace with:

```ts
    const safeCustomFields = options.customFields === undefined
      ? undefined
      : sanitizeCustomFields(options.customFields, { source: 'db.setLeadFields', listId, leadId });
    const hasMetaKeys = Object.keys(options.enrichmentMetadata ?? {}).length > 0;
    const hasCustomKeys = Object.keys(safeCustomFields ?? {}).length > 0;
```

Then around L6522, change:

```ts
    for (const [k, v] of Object.entries(options.customFields ?? {})) {
```

to:

```ts
    for (const [k, v] of Object.entries(safeCustomFields ?? {})) {
```

- [ ] **Step 4: Verify pass**

```bash
cd backend && npx jest src/__tests__/crmDb.setLeadFields.customFieldsGuard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run `tsc` + adjacent suite**

```bash
cd backend && npx tsc && npx jest src/__tests__ --testPathPattern='setLeadFields|crmDb'
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/db.ts backend/src/__tests__/crmDb.setLeadFields.customFieldsGuard.test.ts
git commit -m "fix(crm): sanitize customFields at setLeadFields write boundary

Object.entries(string) yields char-indexed entries, producing the
exact corruption pattern this PR is preventing. Sanitize once at the
top so the per-key write loop is safe.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full TypeScript compile**

```bash
cd backend && npx tsc
```

Expected: No errors.

- [ ] **Step 2: Full test suite**

```bash
cd backend && npm test
```

Expected: All tests pass.

- [ ] **Step 3: Coverage check (CI requires ≥95% on stmts/branches/funcs/lines)**

```bash
cd backend && npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary
```

Inspect the printed summary. `backend/src/utils/customFieldsGuard.ts` should report 100% on all four metrics. Overall numbers must not drop below 95%.

If any guard branch is uncovered, add the missing test case to `customFieldsGuard.test.ts` and re-run.

- [ ] **Step 4: Confirm commit log**

```bash
git log --oneline origin/main..HEAD
```

Expected output (exact order, exact subjects):

```
<sha> fix(crm): sanitize customFields at setLeadFields write boundary
<sha> fix(crm): sanitize customFields at updateLead write boundary
<sha> fix(crm): sanitize customFields at batchCreateLeads new-lead boundary
<sha> fix(crm): sanitize customFields at createLead write boundary
<sha> fix(crm): use mergeCustomFields in importLeadsFromSearch location patch
<sha> fix(crm): use mergeCustomFields in CRM webhook handler
<sha> fix(crm): use mergeCustomFields in HubSpot legacy webhook
<sha> fix(crm): use mergeCustomFields in syncUserUpdateToLeadList
<sha> fix(crm): use mergeCustomFields in V3 tier0b sibling fill
<sha> fix(crm): use mergeCustomFields in batchCreateLeads merge path
<sha> feat(crm): add customFieldsGuard utility
<sha> docs(crm): design — customFields corruption guard
```

- [ ] **Step 5: Done — ready for PR**

The work is complete. No release notes update is required (this is a defensive backend fix with no user-visible behavior change). The branch is ready to be opened as a PR with the spec and plan documents already included.

---

## Notes for the implementer

- **No production behavior change for non-corrupt rows.** The predicate is a one-step fast path; the merge helper is a thin wrapper around `{...a, ...b}` when both sides are plain objects.
- **Stack traces in EB logs are the post-deploy observability hook.** After merge, watch for `[customFieldsGuard] non-object customFields coerced to {}` to identify the original source of corrupted writes.
- **Do not extend scope** to: a backfill script for the 141 existing corrupt leads, a read-time auto-heal, or a throw-on-detect behavior. Those were explicitly ruled out in the spec.
- **Mock pattern for new tests:** mirror an existing crmDb test (e.g. `backend/src/__tests__/crmDb.createLead.userId.test.ts`) — do NOT introduce a new mocking style.
