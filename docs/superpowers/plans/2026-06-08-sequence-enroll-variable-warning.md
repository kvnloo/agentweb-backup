# Sequence Enroll Missing-Variable Warning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn the user at list-enroll time when a sequence's email/LinkedIn message variables can't be filled for the leads in the chosen list, and let them proceed anyway.

**Architecture:** Fold the variable check into the existing `POST /enrollments/by-list` endpoint via a `confirm` flag (one lead read, one code path). Couple in two validated bug fixes: forward `title` in the worker so the check reflects real substitution, and paginate lead loading so counts are correct. Frontend gates the "Enroll All Leads" button: first click checks, shows a warning panel if needed, and relabels to "Enroll Anyway."

**Tech Stack:** Node/TypeScript (Express, DynamoDB), Jest; React/TypeScript (customer-portal).

**Spec:** `docs/superpowers/specs/2026-06-08-sequence-enroll-variable-warning-design.md`

---

## File Structure

- `backend/src/services/dripSequenceWorker.ts` — add `title` to `msgVars` (Task 1).
- `backend/src/utils/emailVariables.ts` — export supported-variable helper (Task 2).
- `backend/src/services/db.ts` — add `getAllLeadsByListId` paginated loader (Task 3).
- `backend/src/routes/sequences.ts` — `confirm` flag + ownership check + coverage on the by-list endpoint (Task 4).
- `backend/src/__tests__/dripSequenceWorker.customFields.test.ts` — extend for `title` (Task 1).
- `backend/src/__tests__/emailVariables.supported.test.ts` — new (Task 2).
- `backend/src/__tests__/sequences.enrollByListConfirm.test.ts` — new (Task 4).
- `customer-portal/src/components/crm/SequencesTab.tsx` — gate-on-click + warning panel (Task 5).

**Parallelization:** Tasks 1, 2, 3 are independent. Task 4 depends on 2 + 3. Task 5 depends on 4's response shape.

---

## Task 1: Worker forwards `title`

**Files:**
- Modify: `backend/src/services/dripSequenceWorker.ts` (the `msgVars` object, ~line 111)
- Test: `backend/src/__tests__/dripSequenceWorker.customFields.test.ts`

- [ ] **Step 1: Add a failing test for `{{title}}` substitution**

Append inside the `describe('dripSequenceWorker - custom field substitution', …)` block:

```typescript
  it('substitutes {{title}} (a standard field) into the email subject', async () => {
    const sequence = {
      sequenceId: 'seq-1', userId: 'user-1', name: 'Test Sequence', status: 'active',
      campaignType: 'custom', enrollmentTrigger: { type: 'manual' },
      exitConditions: { onUnsubscribe: true },
      steps: [{
        stepId: 'step-1', stepNumber: 1, name: 'Step 1', delayDays: 0, channel: 'email',
        subject: 'Hello {{title}} {{firstName}}', bodyHtml: '<p>hi</p>',
      }],
    };
    mockDripSequenceDb.getAllDueEnrollments.mockResolvedValue([baseEnrollment as any]);
    mockDripSequenceDb.getSequence.mockResolvedValue(sequence as any);
    mockCrmDb.getLeadById.mockResolvedValue({
      leadId: 'lead-1', email: 'lead@example.com', firstName: 'Pat', title: 'CTO',
    } as any);
    mockResendService.sendEmail.mockResolvedValue({ id: 'email-1' } as any);
    mockDripSequenceDb.completeEnrollment.mockResolvedValue(undefined as any);

    await processDueEnrollments();

    const sendArg = mockResendService.sendEmail.mock.calls[0][0];
    expect(sendArg.subject).toBe('Hello CTO Pat');
  });
```

- [ ] **Step 2: Run it; verify FAIL**

Run: `cd backend && npx jest src/__tests__/dripSequenceWorker.customFields.test.ts -t "title"`
Expected: FAIL — `Received: "Hello  Pat"` (title blank).

- [ ] **Step 3: Add `title` to `msgVars`**

In `dripSequenceWorker.ts`, change the `msgVars` object to include `title`:

```typescript
  const msgVars: Record<string, any> = {
    firstName: lead?.firstName ?? '',
    lastName: lead?.lastName ?? '',
    email: enrollment.leadEmail,
    company: lead?.company ?? '',
    title: lead?.title ?? '',
    senderName: user?.displayName ?? user?.name ?? '',
    senderEmail: user?.email ?? '',
    customFields: lead?.customFields ?? {},
  };
```

- [ ] **Step 4: Run; verify PASS**

Run: `cd backend && npx jest src/__tests__/dripSequenceWorker.customFields.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: tsc + commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/services/dripSequenceWorker.ts backend/src/__tests__/dripSequenceWorker.customFields.test.ts
git commit -m "fix(crm): forward title into sequence message variables"
```

---

## Task 2: Supported-variable helper

**Files:**
- Modify: `backend/src/utils/emailVariables.ts` (export near `STANDARD_FIELDS`, line 3, and `leadHasVariable`)
- Test: `backend/src/__tests__/emailVariables.supported.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/emailVariables.supported.test.ts`:

```typescript
import { isSupportedVariable } from '../utils/emailVariables';

describe('isSupportedVariable', () => {
  it('treats standard lead fields as supported', () => {
    expect(isSupportedVariable('firstName')).toBe(true);
    expect(isSupportedVariable('title')).toBe(true);
    expect(isSupportedVariable('company')).toBe(true);
  });
  it('treats customFields.* as supported', () => {
    expect(isSupportedVariable('customFields.region')).toBe(true);
  });
  it('treats arbitrary non-standard fields as unsupported', () => {
    expect(isSupportedVariable('phone')).toBe(false);
    expect(isSupportedVariable('linkedinHeadline')).toBe(false);
  });
  it('treats sender-sourced vars as unsupported (handled separately, never lead-checked)', () => {
    expect(isSupportedVariable('senderName')).toBe(false);
    expect(isSupportedVariable('senderEmail')).toBe(false);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `cd backend && npx jest src/__tests__/emailVariables.supported.test.ts`
Expected: FAIL — `isSupportedVariable is not a function`.

- [ ] **Step 3: Implement the helper**

In `emailVariables.ts`, just after the `STANDARD_FIELDS` definition (line 3), add:

```typescript
// Standard fields that come from the LEAD (excludes sender-sourced vars, which are
// supplied from the user at send time and must not be checked against leads).
const LEAD_STANDARD_FIELDS = STANDARD_FIELDS.filter(
  (f) => f !== 'senderName' && f !== 'senderEmail',
) as readonly string[];

/**
 * True if a {{variable}} can actually be filled from a lead by substituteVariables:
 * a lead-sourced standard field, or any customFields.* path. Sender vars and
 * arbitrary unknown tokens return false.
 */
export function isSupportedVariable(varName: string): boolean {
  if (varName.startsWith('customFields.')) return true;
  return LEAD_STANDARD_FIELDS.includes(varName);
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `cd backend && npx jest src/__tests__/emailVariables.supported.test.ts`
Expected: PASS.

- [ ] **Step 5: tsc + commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/utils/emailVariables.ts backend/src/__tests__/emailVariables.supported.test.ts
git commit -m "feat(crm): add isSupportedVariable helper for enroll-time variable checks"
```

---

## Task 3: Paginated lead loader

**Files:**
- Modify: `backend/src/services/db.ts` (add method next to `getLeadsByListId`, ~line 4712)
- Test: `backend/src/__tests__/getAllLeadsByListId.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/getAllLeadsByListId.test.ts`:

```typescript
const mockQuery = jest.fn();
jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({ query: (...a: any[]) => ({ promise: () => mockQuery(...a) }) })) },
  config: { update: jest.fn() },
}));

import { crmDb } from '../services/db';

describe('getAllLeadsByListId', () => {
  beforeEach(() => mockQuery.mockReset());

  it('follows pagination across multiple pages', async () => {
    mockQuery
      .mockResolvedValueOnce({ Items: [{ leadId: 'a' }], LastEvaluatedKey: { leadId: 'a' } })
      .mockResolvedValueOnce({ Items: [{ leadId: 'b' }], LastEvaluatedKey: null });

    const leads = await crmDb.getAllLeadsByListId('list-1');

    expect(leads.map((l: any) => l.leadId)).toEqual(['a', 'b']);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `cd backend && npx jest src/__tests__/getAllLeadsByListId.test.ts`
Expected: FAIL — `getAllLeadsByListId is not a function`.

- [ ] **Step 3: Implement**

In `db.ts`, immediately after the `getLeadsByListId` method (ends ~line 4712), add:

```typescript
  // Loads ALL leads for a list, following DynamoDB pagination. Use this anywhere a
  // complete list is required (enrollment, coverage counts) — getLeadsByListId
  // returns only a single ~1MB page.
  async getAllLeadsByListId(listId: string) {
    const all: any[] = [];
    let lastKey: any = undefined;
    do {
      const result = await this.getLeadsByListId(listId, 100, lastKey);
      all.push(...result.items);
      lastKey = result.lastEvaluatedKey;
    } while (lastKey);
    return all;
  },
```

- [ ] **Step 4: Run; verify PASS**

Run: `cd backend && npx jest src/__tests__/getAllLeadsByListId.test.ts`
Expected: PASS.
If the aws-sdk mock shape doesn't match the repo's test setup, mirror the mocking
style used in an existing `db`-touching test (search `src/__tests__` for `DocumentClient`).

- [ ] **Step 5: tsc + commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/services/db.ts backend/src/__tests__/getAllLeadsByListId.test.ts
git commit -m "fix(crm): add paginated getAllLeadsByListId loader"
```

---

## Task 4: Enroll endpoint — confirm flag, ownership check, coverage

**Files:**
- Modify: `backend/src/routes/sequences.ts` (the `POST /:sequenceId/enrollments/by-list` handler, ~lines 192-244)
- Test: `backend/src/__tests__/sequences.enrollByListConfirm.test.ts` (new)

Depends on Task 2 (`isSupportedVariable`) and Task 3 (`getAllLeadsByListId`).

- [ ] **Step 1: Write the failing tests**

Create `backend/src/__tests__/sequences.enrollByListConfirm.test.ts`. Mirror the mocking
style of the existing `sequences.test.ts` (check its top for how it builds the app + mocks
`dripSequenceDb`/`crmDb`). The behavioral assertions:

```typescript
// Pseudocode-level intent — adapt setup to sequences.test.ts conventions.
// Sequence has one email step: subject "Hi {{firstName}} {{customFields.region}}",
//   and references {{phone}} (unsupported) in the body.
// List has 3 leads: 2 with customFields.region, 1 without; none with phone (unsupported anyway).

describe('POST by-list enroll — confirm gating', () => {
  it('without confirm and with gaps: returns needsConfirmation and does NOT enroll', async () => {
    // expect res.body.needsConfirmation === true
    // expect res.body.warnings.unsupported contains 'phone'
    // expect res.body.warnings.missing has { variable: 'customFields.region', missing: 1, present: 2 }
    // expect bulkEnroll NOT called
  });
  it('senderName/senderEmail never appear in warnings', async () => {
    // subject "Hi {{senderName}}" → warnings.unsupported/missing both empty for it
  });
  it('with confirm:true: enrolls and returns the bulkEnroll result', async () => {
    // expect bulkEnroll called; res.body.enrolled present
  });
  it('clean list (all supported vars populated): enrolls on first call, no confirmation', async () => {
    // expect bulkEnroll called; res.body.needsConfirmation falsy
  });
  it('list not owned by caller: 403', async () => {
    // canOrgMemberAccessList → false → 403
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `cd backend && npx jest src/__tests__/sequences.enrollByListConfirm.test.ts`
Expected: FAIL (handler doesn't return `needsConfirmation` / doesn't check ownership).

- [ ] **Step 3: Implement the handler changes**

Add `isSupportedVariable` to the existing emailVariables import (line 19):

```typescript
import { extractVariables, leadHasVariable, isSupportedVariable, injectUnsubscribeUrl, inlineEmailStyles, rewriteS3ImageUrls, normalizeYoutubeUrls } from '../utils/emailVariables';
```

Replace the body of the by-list handler (keep the outer router.post wrapper and catch block) with:

```typescript
    const authReq = req as AuthenticatedRequest;
    const { listId, lifecycle, startAt, confirm } = req.body;
    if (!listId) return res.status(400).json({ error: 'listId is required' });

    try {
      const sequence = await dripSequenceDb.getSequence(req.params.sequenceId);
      if (!sequence) return res.status(404).json({ error: 'Sequence not found' });
      if (sequence.userId !== authReq.user!.userId) return res.status(403).json({ error: 'Forbidden' });
      if (sequence.steps.length === 0) return res.status(400).json({ error: 'Sequence has no steps' });

      // Verify the caller owns (or org-shares) the list before reading its leads.
      const list = await crmDb.getLeadListById(listId);
      if (!list) return res.status(404).json({ error: 'List not found' });
      if (!(await crmDb.canOrgMemberAccessList(authReq.user!.userId, list))) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Load ALL leads. Lifecycle-filtered enroll keeps its existing path; the
      // default list enroll uses the paginated loader (Task 3).
      let leadList: any[];
      if (lifecycle) {
        const r = await crmDb.getLeadsByStatus(listId, lifecycle);
        leadList = Array.isArray(r) ? r : ((r as any).items ?? (r as any).leads ?? []);
      } else {
        leadList = await crmDb.getAllLeadsByListId(listId);
      }

      // Variable coverage across all steps + channels.
      const templateText = sequence.steps
        .map((s: any) => `${s.subject ?? ''} ${s.bodyHtml ?? ''} ${s.messageText ?? ''}`)
        .join(' ');
      const vars = extractVariables(templateText)
        .filter((v) => v !== 'senderName' && v !== 'senderEmail');
      const unsupported = vars.filter((v) => !isSupportedVariable(v));
      const supported = vars.filter((v) => isSupportedVariable(v));
      const missing: { variable: string; missing: number; present: number }[] = [];
      for (const v of supported) {
        let miss = 0, pres = 0;
        for (const lead of leadList) { leadHasVariable(lead, v) ? pres++ : miss++; }
        if (miss > 0) missing.push({ variable: v, missing: miss, present: pres });
      }

      if ((unsupported.length > 0 || missing.length > 0) && !confirm) {
        return res.json({
          enrolled: false,
          needsConfirmation: true,
          leadCount: leadList.length,
          warnings: { unsupported, missing },
        });
      }

      const inputs = leadList.map((l: any) => ({
        sequenceId: req.params.sequenceId,
        userId: authReq.user!.userId,
        listId,
        leadId: l.leadId,
        leadEmail: l.email,
        startAt: startAt ?? undefined,
      }));

      const result = await dripSequenceDb.bulkEnroll(inputs);

      const existing = sequence.autoEnrollListIds ?? [];
      if (!existing.includes(listId)) {
        void dripSequenceDb.updateSequence(req.params.sequenceId, authReq.user!.userId, {
          autoEnrollListIds: [...existing, listId],
        }).catch((e) => console.error('[sequences] autoEnrollListIds update error:', e));
      }

      res.json(result);
```

- [ ] **Step 4: Run; verify PASS**

Run: `cd backend && npx jest src/__tests__/sequences.enrollByListConfirm.test.ts`
Expected: PASS. Then run the existing suite to ensure no regression:
`cd backend && npx jest sequences`

- [ ] **Step 5: tsc + commit (feature + tests as separate commits)**

```bash
cd backend && npx tsc --noEmit
git add backend/src/routes/sequences.ts
git commit -m "feat(crm): warn on missing message variables when enrolling a list"
git add backend/src/__tests__/sequences.enrollByListConfirm.test.ts
git commit -m "test(crm): cover enroll-by-list variable-warning gating"
```

---

## Task 5: Frontend gate-on-click + warning panel

**Files:**
- Modify: `customer-portal/src/components/crm/SequencesTab.tsx` (`EnrollmentDetail`: `handleEnrollFromList` ~line 178, enroll dialog ~line 250-336)

- [ ] **Step 1: Add warning state**

Near the other `EnrollmentDetail` state hooks, add:

```typescript
  const [varWarnings, setVarWarnings] = useState<
    { unsupported: string[]; missing: { variable: string; missing: number; present: number }[] } | null
  >(null);
  const [warnLeadCount, setWarnLeadCount] = useState<number>(0);
```

- [ ] **Step 2: Replace `handleEnrollFromList` with a check-then-confirm flow**

```typescript
  async function handleEnrollFromList(confirm = false) {
    if (!selectedListId) return;
    setEnrolling(true);
    try {
      const r = await axios.post(
        buildApiUrl(`/api/crm/sequences/${sequence.sequenceId}/enrollments/by-list`),
        { listId: selectedListId, confirm },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (r.data?.needsConfirmation) {
        setVarWarnings(r.data.warnings);
        setWarnLeadCount(r.data.leadCount ?? 0);
        return; // hold — user must click "Enroll Anyway"
      }
      setEnrollResult(r.data);
      setVarWarnings(null);
      setSequence((prev) => ({
        ...prev,
        autoEnrollListIds: Array.from(new Set([...(prev.autoEnrollListIds ?? []), selectedListId])),
      }));
      const r2 = await axios.get(
        buildApiUrl(`/api/crm/sequences/${sequence.sequenceId}/enrollments`),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setEnrollments(r2.data.enrollments ?? []);
      setStats(r2.data.stats ?? null);
    } catch (err: any) {
      console.error("[EnrollmentDetail] enroll error:", err);
    } finally {
      setEnrolling(false);
    }
  }
```

- [ ] **Step 3: Reset warnings when the list changes**

In the list `CommandItem` `onSelect` (where `setSelectedListId(l.listId)` is called), also add `setVarWarnings(null);`. In `openEnrollDialog`, add `setVarWarnings(null); setWarnLeadCount(0);`.

- [ ] **Step 4: Render the warning panel + relabel the button**

Insert this block in the dialog, just before the `{enrollResult && (...)}` summary:

```tsx
            {varWarnings && !enrollResult && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 space-y-2">
                <p className="text-sm font-medium">Some message variables may not fill in</p>
                {varWarnings.unsupported.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground">
                      These can't be filled for any lead and will appear blank:
                    </p>
                    <ul className="text-xs mt-0.5 list-disc list-inside">
                      {varWarnings.unsupported.map((v) => (
                        <li key={v}><code>{`{{${v}}}`}</code></li>
                      ))}
                    </ul>
                  </div>
                )}
                {varWarnings.missing.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground">Missing for some leads:</p>
                    <ul className="text-xs mt-0.5 list-disc list-inside">
                      {varWarnings.missing.map((m) => (
                        <li key={m.variable}>
                          <code>{`{{${m.variable}}}`}</code> — missing for {m.missing} of {warnLeadCount} leads
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
```

Change the footer enroll button to branch on `varWarnings`:

```tsx
            {!enrollResult && (
              <Button
                onClick={() => handleEnrollFromList(!!varWarnings)}
                disabled={!selectedListId || enrolling}
              >
                {enrolling && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {varWarnings ? "Enroll Anyway" : "Enroll All Leads"}
              </Button>
            )}
```

- [ ] **Step 5: Type-check the customer-portal**

Run: `cd customer-portal && npx tsc --noEmit` (or `npm run build` if no tsc script).
Expected: no new type errors.

- [ ] **Step 6: Commit**

```bash
git add customer-portal/src/components/crm/SequencesTab.tsx
git commit -m "feat(crm): gate list enroll with missing-variable warning"
```

---

## Final Verification

- [ ] `cd backend && npx tsc --noEmit` clean.
- [ ] `cd backend && npx jest dripSequenceWorker emailVariables getAllLeadsByListId sequences` all green.
- [ ] `cd customer-portal && npx tsc --noEmit` clean.
- [ ] `./test-env/test-env.sh sync` (test env is active).
- [ ] Playwright manual check against the test env: open a sequence whose step uses
  `{{customFields.something}}` not present on a list; click "Enroll Leads" → pick that
  list → "Enroll All Leads" → warning panel appears, button becomes "Enroll Anyway";
  clicking it enrolls. Then a clean list enrolls on first click with no warning.
