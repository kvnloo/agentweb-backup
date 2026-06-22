# HubSpot Push Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show live "Pushing to HubSpot — N / M (P%)" progress in a floating card on the CRM page during a large full-list push, surviving dialog-close and page refresh.

**Architecture:** Backend writes per-chunk progress (`processedCount`/`totalCount`) onto the already-persisted-and-polled `PushJob`. A new provider-agnostic status route lets the CRM page re-discover an in-flight push after refresh. Frontend adds a floating `CrmSyncPushProgressCard` (modeled on the enrichment `EmailJobProgressCard`) mounted at the CRM page level; the sync dialog just triggers the push and hands tracking to the card.

**Tech Stack:** TypeScript, Express, DynamoDB (backend); React + axios + Vite (customer-portal). Jest for backend tests.

**Spec:** `docs/superpowers/specs/2026-06-19-hubspot-push-progress-design.md`

---

## File Structure

**Backend:**
- Modify `backend/src/services/externalCrmSyncService.ts` — extend `PushJob`, add per-chunk progress in `runPush`, add `reportPushProgress` + `getRunningPushJobForList`.
- Modify `backend/src/routes/crmSync.ts` — add `GET /push/:listId/status`.
- Modify `backend/src/__tests__/externalCrmSync.pushLock.test.ts` — progress + resume-lookup tests (sibling new file also acceptable).

**Frontend (customer-portal):**
- Create `customer-portal/src/components/crm/CrmSyncPushProgressCard.tsx` — floating push-progress card.
- Modify `customer-portal/src/pages/CRM.tsx` — `activePushJob` state, mount card, resume-on-mount effect, pass `onPushStarted`/`pushActive` to the dialog.
- Modify `customer-portal/src/components/crm/ExternalCrmSyncDialog.tsx` — add `onPushStarted`/`pushActive` props, remove in-dialog poller, route `handlePush`/`handleChangePipeline` through `onPushStarted`.

---

## Task 1: Extend `PushJob` with progress fields

**Files:**
- Modify: `backend/src/services/externalCrmSyncService.ts:39-46`

- [ ] **Step 1: Add the two optional fields to the interface**

Change the `PushJob` interface (currently lines 39-46) to:

```ts
export interface PushJob {
  jobId: string;
  status: 'running' | 'completed' | 'error';
  startedAt: string;
  finishedAt?: string;
  result?: SyncResult;
  error?: string;
  // Live progress, written per 500-lead chunk while running (push-only).
  processedCount?: number;  // leads pushed so far (authoritative — sum of real chunk sizes)
  totalCount?: number;      // best-effort denominator from list.leadCount (may drift)
}
```

- [ ] **Step 2: Verify compilation**

Run: `cd backend && npx tsc`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/externalCrmSyncService.ts
git commit -m "feat(hubspot): add progress fields to PushJob"
```

---

## Task 2: Write per-chunk progress in `runPush` (TDD)

**Files:**
- Modify: `backend/src/services/externalCrmSyncService.ts` (`runPush` ~`:794`, add `reportPushProgress`)
- Test: `backend/src/__tests__/externalCrmSync.pushProgress.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/externalCrmSync.pushProgress.test.ts`. This mirrors the mock surface of `externalCrmSync.pushLock.test.ts`. It drives a full push via `startPushJob`, mocks two lead pages, and asserts `setLeadListCrmSyncConfig` is persisted with increasing `processedCount` and a seeded `totalCount`.

```ts
import { ExternalCrmSyncService, ExternalCrmSyncConfig } from '../services/externalCrmSyncService';

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    getLeadById: jest.fn(),
    updateLead: jest.fn().mockResolvedValue(undefined),
    setLeadListCrmSyncConfig: jest.fn().mockResolvedValue(undefined),
  },
  userDb: { getUserById: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../utils/crypto', () => ({
  encryptPassword: jest.fn((pw: string) => `enc:${pw}`),
  decryptPassword: jest.fn(() => ({ password: 'pat', userId: 'user1' })),
}));
const mockHubSpotServiceInstance = {
  testConnection: jest.fn().mockResolvedValue({ valid: true }),
  ensureContactProperty: jest.fn().mockResolvedValue('aw_notes'),
  ensureDealProperty: jest.fn().mockResolvedValue('amount'),
  upsertContact: jest.fn().mockResolvedValue({ contactId: 'c1', isNew: false }),
  createContact: jest.fn().mockResolvedValue({ contactId: 'c1' }),
  updateContact: jest.fn().mockResolvedValue({ contactId: 'c1' }),
  createDeal: jest.fn().mockResolvedValue('d1'),
  updateDeal: jest.fn().mockResolvedValue(undefined),
  associateContactToDeal: jest.fn().mockResolvedValue(undefined),
  getContactDealAssociations: jest.fn().mockResolvedValue([]),
  getDeal: jest.fn().mockResolvedValue(null),
  getDealPipelineStages: jest.fn().mockResolvedValue([]),
  createDealStage: jest.fn().mockResolvedValue({ id: 'stage_1', label: 'S', displayOrder: 0, metadata: { probability: 0.1 } }),
  listDealPipelines: jest.fn().mockResolvedValue([]),
  listContactProperties: jest.fn().mockResolvedValue([]),
  listDealProperties: jest.fn().mockResolvedValue([]),
};
jest.mock('../services/hubspotService', () => ({
  HubSpotService: { create: jest.fn(), fromToken: jest.fn() },
}));

import { crmDb } from '../services/db';
import { HubSpotService } from '../services/hubspotService';
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

function makeConfig(overrides: Partial<ExternalCrmSyncConfig> = {}): ExternalCrmSyncConfig {
  return {
    provider: 'hubspot', listId: 'listA', userId: 'user1', apiKeyEncrypted: 'enc:pat',
    autoSyncEnabled: false,
    contactFieldMapping: [{ agentwebField: 'email', crmProperty: 'email', direction: 'both', enabled: true }],
    dealFieldMapping: [], customFieldMapping: [],
    createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeAll(() => { process.env.HUBSPOT_BATCH_PUSH_ENABLED = 'false'; });
afterAll(() => { delete process.env.HUBSPOT_BATCH_PUSH_ENABLED; });

describe('ExternalCrmSyncService push progress', () => {
  let service: ExternalCrmSyncService;
  beforeEach(() => {
    jest.clearAllMocks();
    (HubSpotService.create as jest.Mock).mockResolvedValue(mockHubSpotServiceInstance);
    (HubSpotService.fromToken as jest.Mock).mockReturnValue(mockHubSpotServiceInstance);
    // List with leadCount=3 and a hubspot config.
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'listA', userId: 'user1', name: 'List A', leadCount: 3,
      externalCrmSyncConfigs: { hubspot: makeConfig() },
    } as any);
    // Two pages: [lead1, lead2] then [lead3].
    mockCrmDb.getLeadsByListId
      .mockResolvedValueOnce({ items: [{ leadId: 'l1', email: 'a@b.com' }, { leadId: 'l2', email: 'c@d.com' }], lastEvaluatedKey: 'k1' } as any)
      .mockResolvedValueOnce({ items: [{ leadId: 'l3', email: 'e@f.com' }], lastEvaluatedKey: undefined } as any);
    service = new ExternalCrmSyncService();
  });

  it('seeds totalCount from leadCount and writes increasing processedCount', async () => {
    const { completion } = await service.startPushJob('user1', 'listA', 'hubspot');
    await completion;

    // Collect every pushJob persisted during the run.
    const jobs = (mockCrmDb.setLeadListCrmSyncConfig as jest.Mock).mock.calls
      .map((c) => (c[2] as any).pushJob)
      .filter(Boolean);

    // totalCount seeded from leadCount on the running job.
    const running = jobs.filter((j) => j.status === 'running');
    expect(running.some((j) => j.totalCount === 3)).toBe(true);

    // processedCount advances 2 then 3 (page sizes 2 + 1).
    const processed = running.map((j) => j.processedCount).filter((n) => n !== undefined);
    expect(processed).toContain(2);
    expect(processed).toContain(3);

    // Final job is completed with a result.
    const done = jobs[jobs.length - 1];
    expect(done.status).toBe('completed');
    expect(done.result.successCount).toBeGreaterThanOrEqual(0);
  });

  it('does not throw / writes no progress on the synchronous pushAllLeads path (no job)', async () => {
    await expect(service.pushAllLeads('user1', 'listA', 'hubspot')).resolves.toBeDefined();
    const jobs = (mockCrmDb.setLeadListCrmSyncConfig as jest.Mock).mock.calls
      .map((c) => (c[2] as any)?.pushJob).filter(Boolean);
    expect(jobs.length).toBe(0); // pushAllLeads sets no pushJob, so no progress writes
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest externalCrmSync.pushProgress --silent`
Expected: FAIL — `processedCount`/`totalCount` never written (no `expect(...).toContain(2)`).

- [ ] **Step 3: Add the `reportPushProgress` helper**

In `externalCrmSyncService.ts`, directly after `persistPushJob` (ends ~`:764`), add:

```ts
  /** Writes live push progress onto the running job (no-op for the synchronous
   *  pushAllLeads path, which runs runPush without a job). Cheap: one config
   *  write per 500-lead chunk. */
  private async reportPushProgress(config: ExternalCrmSyncConfig, processed: number, total?: number): Promise<void> {
    const job = config.pushJob;
    if (!job || job.status !== 'running') return;
    job.processedCount = processed;
    if (total !== undefined) job.totalCount = total;
    await this.persistPushJob(config, job);
  }
```

- [ ] **Step 4: Seed total + report per chunk in `runPush`**

In `runPush` (`:794`), the list is fetched for `listName` at `:796-799`. Replace that block so we also capture `leadCount`, and seed progress before the loop. Then report after each chunk.

Replace lines `:796-799`:
```ts
    // Attach the human-readable list name so adapters can use it when naming external lists
    if (!config.listName) {
      const list = await crmDb.getLeadListById(listId);
      if (list?.name) config.listName = list.name;
    }
```
with:
```ts
    // Attach the human-readable list name + seed the progress denominator from the
    // maintained leadCount (best-effort; used only for the % in the progress card).
    let totalCount: number | undefined;
    {
      const list = await crmDb.getLeadListById(listId);
      if (list?.name && !config.listName) config.listName = list.name;
      if (typeof (list as any)?.leadCount === 'number') totalCount = (list as any).leadCount;
    }
```

Inside the lock body, seed progress just before the `do {` loop (`:818`):
```ts
      let processed = 0;
      await this.reportPushProgress(config, 0, totalCount);
```

And after the chunk is pushed — directly after the `totalResult.errors.push(...)` accumulation block closes (after `:834`), still inside `if (chunk.length > 0) {`:
```ts
          processed += chunk.length;
          await this.reportPushProgress(config, processed, totalCount);
```

- [ ] **Step 5: Verify the test passes + compile**

Run: `cd backend && npx tsc && npx jest externalCrmSync.pushProgress --silent`
Expected: PASS.

- [ ] **Step 6: Run the existing push-lock tests (no regression)**

Run: `cd backend && npx jest externalCrmSync --silent`
Expected: PASS (pushLock + pushProgress).

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/externalCrmSyncService.ts backend/src/__tests__/externalCrmSync.pushProgress.test.ts
git commit -m "feat(hubspot): write live per-chunk push progress to the job"
```

---

## Task 3: Provider-agnostic running-push lookup + route (TDD)

**Files:**
- Modify: `backend/src/services/externalCrmSyncService.ts` (add `getRunningPushJobForList` after `getPushJob` ~`:750`)
- Modify: `backend/src/routes/crmSync.ts` (add route after the existing status route ~`:441`)
- Test: append to `backend/src/__tests__/externalCrmSync.pushProgress.test.ts`

- [ ] **Step 1: Write the failing test (append to the progress test file)**

```ts
describe('ExternalCrmSyncService.getRunningPushJobForList', () => {
  let service: ExternalCrmSyncService;
  beforeEach(() => { jest.clearAllMocks(); service = new ExternalCrmSyncService(); });

  it('returns the provider + job when a list has a running, non-stale push job', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'listA', userId: 'user1', name: 'List A',
      externalCrmSyncConfigs: {
        hubspot: makeConfig({
          pushJob: { jobId: 'j1', status: 'running', startedAt: new Date().toISOString(), processedCount: 2, totalCount: 5 },
        } as any),
      },
    } as any);
    const res = await service.getRunningPushJobForList('user1', 'listA');
    expect(res).not.toBeNull();
    expect(res!.provider).toBe('hubspot');
    expect(res!.job.jobId).toBe('j1');
  });

  it('returns null when no config has a running job', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'listA', userId: 'user1', name: 'List A',
      externalCrmSyncConfigs: { hubspot: makeConfig({ pushJob: { jobId: 'j1', status: 'completed', startedAt: new Date().toISOString() } } as any) },
    } as any);
    expect(await service.getRunningPushJobForList('user1', 'listA')).toBeNull();
  });

  it('returns null when the running job is stale (process likely died)', async () => {
    const old = new Date(Date.now() - 21 * 60 * 1000).toISOString(); // > STALE_PUSH_JOB_MS (20m)
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: 'listA', userId: 'user1', name: 'List A',
      externalCrmSyncConfigs: { hubspot: makeConfig({ pushJob: { jobId: 'j1', status: 'running', startedAt: old } } as any) },
    } as any);
    expect(await service.getRunningPushJobForList('user1', 'listA')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest externalCrmSync.pushProgress -t getRunningPushJobForList --silent`
Expected: FAIL — `getRunningPushJobForList is not a function`.

- [ ] **Step 3: Implement `getRunningPushJobForList`**

After `getPushJob` (ends ~`:750`) add:

```ts
  /** Provider-agnostic lookup: returns the first configured provider on the list
   *  whose push job is currently running (and not stale), for refresh-resume of
   *  the progress card. Returns null when none. Access-checked like getConfig. */
  async getRunningPushJobForList(
    userId: string,
    listId: string
  ): Promise<{ provider: string; job: PushJob } | null> {
    const list = await crmDb.getLeadListById(listId);
    if (!list) return null;
    const configs = (list as any).externalCrmSyncConfigs as Record<string, ExternalCrmSyncConfig> | undefined;
    if (!configs) return null;
    for (const [provider, config] of Object.entries(configs)) {
      const job = config?.pushJob;
      if (!job || job.status !== 'running' || this.isPushJobStale(job)) continue;
      if (!(await this.canAccessConfig(userId, config.userId))) continue;
      return { provider, job };
    }
    return null;
  }
```

- [ ] **Step 4: Add the route**

In `crmSync.ts`, after the existing `GET /push/:listId/:provider/status` route (ends `:441`), add:

```ts
// GET /api/crm-sync/push/:listId/status
// Provider-agnostic: returns the running push job + its provider for the list, so
// the CRM page can re-mount the progress card after a refresh without knowing the
// provider. Returns { status: 'idle' } when nothing is running.
router.get('/push/:listId/status', async (req: any, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { listId } = req.params;
    const ownership = await verifyListOwnership(userId, listId);
    if (!ownership.ok) return res.status(ownership.status!).json({ error: ownership.error });

    const running = await externalCrmSyncService.getRunningPushJobForList(userId, listId);
    if (!running) return res.json({ status: 'idle' });
    res.json({ status: 'running', provider: running.provider, job: running.job });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to get push status' });
  }
});
```

Note: Express matches `/push/:listId/status` and `/push/:listId/:provider/status` distinctly because the latter has an extra path segment. Place this new route anywhere among the push routes; ordering does not cause a conflict.

- [ ] **Step 5: Verify tests + compile**

Run: `cd backend && npx tsc && npx jest externalCrmSync.pushProgress --silent`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/externalCrmSyncService.ts backend/src/routes/crmSync.ts backend/src/__tests__/externalCrmSync.pushProgress.test.ts
git commit -m "feat(hubspot): provider-agnostic running-push lookup + route for refresh-resume"
```

---

## Task 4: Floating `CrmSyncPushProgressCard` component

**Files:**
- Create: `customer-portal/src/components/crm/CrmSyncPushProgressCard.tsx`

- [ ] **Step 1: Create the component**

Modeled on `EmailJobProgressCard.tsx`. Polls the provider-specific status endpoint; shows N/M + % while running and New/Updated/Errors on completion.

```tsx
/**
 * Floating progress card for a full-list CRM push (e.g. to HubSpot).
 *
 * Polls GET /api/crm-sync/push/:listId/:provider/status every 3s and shows:
 *   - "Pushing to {provider}" header
 *   - Progress bar (processedCount / totalCount) + %
 *   - On completion: New / Updated / Errors from job.result
 *
 * Mirrors EmailJobProgressCard: fixed bottom-right, stays ~visible after the
 * dialog closes, calls onCompleted once on terminal state.
 */

import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { buildApiUrl } from '@/config';
import { Button } from '@/components/ui/button';
import { Loader2, X, ArrowUpRight, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SyncResult {
  successCount: number;
  newCount: number;
  updatedCount: number;
  errorCount: number;
  errors: string[];
}
interface PushJob {
  jobId: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  startedAt?: string;
  finishedAt?: string;
  result?: SyncResult;
  error?: string;
  processedCount?: number;
  totalCount?: number;
}

interface Props {
  listId: string;
  provider: string;
  token: string;
  onCompleted?: (final: PushJob) => void;
  onClose: () => void;
}

export function CrmSyncPushProgressCard({ listId, provider, token, onCompleted, onClose }: Props) {
  const [job, setJob] = useState<PushJob | null>(null);
  const [pollErr, setPollErr] = useState<string | null>(null);
  const completedFiredRef = useRef(false);
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => { onCompletedRef.current = onCompleted; }, [onCompleted]);

  useEffect(() => {
    let cancelled = false;
    let timer: any = null;
    completedFiredRef.current = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const r = await axios.get<PushJob>(
          buildApiUrl(`/api/crm-sync/push/${listId}/${provider}/status`),
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (cancelled) return;
        setJob(r.data);
        setPollErr(null);
        if ((r.data.status === 'completed' || r.data.status === 'error') && !completedFiredRef.current) {
          completedFiredRef.current = true;
          onCompletedRef.current?.(r.data);
        }
        if (r.data.status === 'running' || (r.data as any).status === 'idle') {
          timer = setTimeout(poll, 3000);
        }
      } catch (err: any) {
        if (cancelled) return;
        setPollErr(err?.response?.data?.error || err?.message || 'Polling failed');
        timer = setTimeout(poll, 3000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [listId, provider, token]);

  const processed = job?.processedCount ?? 0;
  const total = job?.totalCount;
  const pct = job?.status === 'completed' ? 100
    : (total && total > 0 ? Math.min(99, Math.floor((processed / total) * 100)) : 0);
  const isDone = job && (job.status === 'completed' || job.status === 'error');
  const providerLabel = provider === 'hubspot' ? 'HubSpot' : provider.charAt(0).toUpperCase() + provider.slice(1);

  return (
    <div
      data-testid="crm-push-progress-card"
      data-job-status={job?.status ?? 'pending'}
      className="fixed bottom-24 right-6 z-50 w-[360px] rounded-xl border border-[var(--crm-border)] bg-background shadow-lg ring-1 ring-black/5 dark:ring-white/10 animate-in slide-in-from-bottom-4 fade-in duration-200"
    >
      <div className="flex items-start justify-between gap-2 px-4 pt-3">
        <div className="flex items-center gap-2 min-w-0">
          <ArrowUpRight className="h-4 w-4 text-violet-600 shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">Pushing to {providerLabel}</div>
            <div className="text-[11px] text-muted-foreground truncate">
              {!job ? 'Starting…'
                : job.status === 'running'
                  ? (total ? `${processed} / ${total} leads` : `${processed} leads pushed`)
                : job.status === 'completed' ? `Done — ${job.result?.successCount ?? processed} synced`
                : `Failed — ${job.error ?? 'unknown error'}`}
            </div>
          </div>
        </div>
        <button type="button" data-testid="crm-push-progress-close" onClick={onClose} aria-label="Close"
          className="shrink-0 text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="px-4 pt-2">
        <div className="h-1.5 rounded-full bg-[var(--crm-bg-page)] overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all duration-300',
              isDone ? (job?.status === 'error' ? 'bg-red-500' : 'bg-green-500') : 'bg-violet-500')}
            style={{ width: `${pct}%` }}
            data-testid="crm-push-progress-bar"
          />
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground text-right">{pct}%</div>
      </div>

      <div className="grid grid-cols-3 gap-2 px-4 py-3 text-xs">
        <Stat label="New" value={job?.result?.newCount ?? 0} color="text-green-700 dark:text-green-300" testid="crm-push-new" />
        <Stat label="Updated" value={job?.result?.updatedCount ?? 0} color="text-blue-700 dark:text-blue-300" testid="crm-push-updated" />
        <Stat label="Errors" value={job?.result?.errorCount ?? 0}
          color={(job?.result?.errorCount ?? 0) > 0 ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground'} testid="crm-push-errors" />
      </div>

      {pollErr && (
        <div className="px-4 pb-3" data-testid="crm-push-poll-error">
          <div className="flex items-start gap-1.5 rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-2 text-[11px] text-amber-800 dark:text-amber-200">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" /><span>{pollErr}</span>
          </div>
        </div>
      )}

      <div className="border-t border-[var(--crm-border)] px-4 py-2 flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">
          {!job ? <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Starting…</span>
            : job.status === 'running' ? <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Running…</span>
            : job.status === 'completed' ? <span>Completed</span> : <span>Failed</span>}
        </div>
        {isDone && (
          <Button size="sm" variant="outline" data-testid="crm-push-progress-dismiss" onClick={onClose} className="h-6 text-[11px] px-2">
            Close
          </Button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, color, testid }: { label: string; value: number; color: string; testid?: string }) {
  return (
    <div className="rounded border border-[var(--crm-border)] bg-[var(--crm-bg-page)] p-2 flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">{label}</span>
      <span className={cn('text-base font-semibold', color)} data-testid={testid}>{value}</span>
    </div>
  );
}

export default CrmSyncPushProgressCard;
```

- [ ] **Step 2: Verify compile/build**

Run: `cd customer-portal && npx tsc --noEmit`
Expected: no errors from this file.

- [ ] **Step 3: Commit**

```bash
git -C customer-portal add src/components/crm/CrmSyncPushProgressCard.tsx
git -C customer-portal commit -m "feat(crm): floating push-progress card"
```

---

## Task 5: Wire the card into `CRM.tsx`

**Files:**
- Modify: `customer-portal/src/pages/CRM.tsx` (state ~`:382`, import ~`:95`, mount ~`:10313`, dialog usage ~`:5660`)

- [ ] **Step 1: Import the card**

Near the `ExternalCrmSyncDialog` import (`:95`) add:
```tsx
import { CrmSyncPushProgressCard } from "@/components/crm/CrmSyncPushProgressCard";
```

- [ ] **Step 2: Add `activePushJob` state**

Next to `activeEmailJob` (`:382`) add:
```tsx
const [activePushJob, setActivePushJob] = useState<{ provider: string } | null>(null);
```

- [ ] **Step 3: Pass `onPushStarted` + `pushActive` to the dialog**

In the `<ExternalCrmSyncDialog ... />` usage (`:5660-5669`), add two props:
```tsx
                        onPushStarted={(provider) => setActivePushJob({ provider })}
                        pushActive={!!activePushJob}
```

- [ ] **Step 4: Resume-on-mount — re-discover a running push for the selected list**

After the existing effects (place near the other list-scoped effects; any top-level `useEffect` in the component body works), add:
```tsx
  // Re-mount the push progress card after a refresh / list switch if a push is
  // still running for the selected list (provider-agnostic lookup).
  useEffect(() => {
    if (!selectedList?.listId || !token) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await axios.get(buildApiUrl(`/api/crm-sync/push/${selectedList.listId}/status`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (r.data?.status === 'running' && r.data?.provider) {
          setActivePushJob({ provider: r.data.provider });
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [selectedList?.listId, token]);
```

- [ ] **Step 5: Mount the card next to `EmailJobProgressCard`**

After the `EmailJobProgressCard` block (`:10313-10337`) add:
```tsx
      {activePushJob && selectedList?.listId && token && (
        <CrmSyncPushProgressCard
          listId={selectedList.listId}
          provider={activePushJob.provider}
          token={token}
          onCompleted={(final) => {
            if (selectedList?.listId) {
              fetchLeads(selectedList.listId, currentPage, undefined, debouncedSearchQuery);
            }
            const r = final.result;
            toast({
              title: `Push to ${activePushJob.provider}: ${final.status === 'error' ? 'failed' : 'done'}`,
              description: final.status === 'error'
                ? (final.error ?? 'Push failed')
                : `${r?.newCount ?? 0} new, ${r?.updatedCount ?? 0} updated${r?.errorCount ? `, ${r.errorCount} error${r.errorCount === 1 ? '' : 's'}` : ''}.`,
              variant: final.status === 'error' ? 'destructive' : undefined,
            });
          }}
          onClose={() => setActivePushJob(null)}
        />
      )}
```

- [ ] **Step 6: Verify compile**

Run: `cd customer-portal && npx tsc --noEmit`
Expected: errors only about `onPushStarted`/`pushActive` not existing on the dialog Props — fixed in Task 6. (If you do Task 6 first, expect zero errors.)

- [ ] **Step 7: Commit**

```bash
git -C customer-portal add src/pages/CRM.tsx
git -C customer-portal commit -m "feat(crm): mount push-progress card + resume-on-refresh"
```

---

## Task 6: Refactor `ExternalCrmSyncDialog` to delegate progress to the card

**Files:**
- Modify: `customer-portal/src/components/crm/ExternalCrmSyncDialog.tsx` (Props `:127`, handlers `:879`/`:900`, remove poller `:835-877`,`:929-955`)

- [ ] **Step 1: Add the new props**

Change the `Props` interface (`:127-134`) to:
```tsx
interface Props {
  open: boolean;
  onClose: () => void;
  listId: string;
  listName: string;
  leadCount: number;
  onSyncSuccess?: () => void;
  /** Called when a full-list push starts; parent shows the floating progress card. */
  onPushStarted?: (provider: string) => void;
  /** True while the parent's push-progress card is tracking a run (disables Push). */
  pushActive?: boolean;
}
```
And destructure them where the component reads props (the signature near `:349` — add `onPushStarted, pushActive`):
```tsx
  open, onClose, listId, listName, leadCount, onSyncSuccess, onPushStarted, pushActive,
```

- [ ] **Step 2: Remove the in-dialog poller**

Delete these blocks (they are replaced by the card):
- `stopPushPolling` (`:835-840`)
- `finishPushJob` (`:842-857`)
- `startPushPolling` (`:860-877`)
- the resume-on-open effect (`:929-949`)
- the stop-on-close effect (`:951-955`)
- the `pushPollRef` declaration (`:407`)

The local `PushJob` interface (`:118-125`) is now unused — remove it too if no other reference remains (search the file for `PushJob`).

- [ ] **Step 3: Route `handlePush` through `onPushStarted`**

Replace `handlePush` (`:879-896`) with:
```tsx
  const handlePush = async () => {
    if (isDirty) {
      toast({ title: 'Unsaved changes', description: 'Please save your configuration before syncing.', variant: 'destructive' });
      return;
    }
    setPushing(true);
    setLastResult(null);
    try {
      // Kicks off a background job and returns 202 immediately; the floating
      // progress card on the CRM page takes over tracking from here.
      await axios.post(buildApiUrl(`/api/crm-sync/push/${listId}/${provider}`), {}, { headers });
      toast({ title: `Pushing leads to ${provider}…`, description: 'Progress shows in the card on the page — you can keep working.' });
      onPushStarted?.(provider);
    } catch (err: any) {
      toast({ title: 'Push failed', description: err.response?.data?.error || 'Unknown error', variant: 'destructive' });
    } finally {
      setPushing(false);
    }
  };
```

- [ ] **Step 4: Route `handleChangePipeline` through `onPushStarted`**

In `handleChangePipeline` (`:900-927`), replace the migration-push tail. Change:
```tsx
      setLastResult(null);
      setPushing(true);
      await axios.post(buildApiUrl(`/api/crm-sync/push/${listId}/${provider}`), {}, { headers });
      toast({ title: 'Pipeline updated', description: 'Moving existing deals into the new pipeline…' });
      startPushPolling();
```
to:
```tsx
      setLastResult(null);
      await axios.post(buildApiUrl(`/api/crm-sync/push/${listId}/${provider}`), {}, { headers });
      toast({ title: 'Pipeline updated', description: 'Moving existing deals into the new pipeline…' });
      onPushStarted?.(provider);
```
Also remove the now-unneeded `setPushing(true)`/`setPushing(false)` in this handler's catch if they reference the removed poller (keep `setMigratingPipeline` logic intact).

- [ ] **Step 5: Disable Push while a parent push is active**

On the Push `<Button>` (`:1725-1733`), change `disabled`:
```tsx
                    disabled={pushing || pulling || pushActive || !isConfigured || isAccountMissing}
```

- [ ] **Step 6: Verify compile**

Run: `cd customer-portal && npx tsc --noEmit`
Expected: zero errors across the dialog + CRM.tsx.

- [ ] **Step 7: Commit**

```bash
git -C customer-portal add src/components/crm/ExternalCrmSyncDialog.tsx
git -C customer-portal commit -m "refactor(crm): delegate push progress to the floating card"
```

---

## Final verification

- [ ] Backend: `cd backend && npx tsc && npx jest externalCrmSync --silent` → all pass.
- [ ] Frontend: `cd customer-portal && npx tsc --noEmit` → no errors.
- [ ] Manual (Playwright on test env): trigger a push from the CRM sync dialog → floating card appears bottom-right with N/M + %; close the dialog → card persists; refresh the page → card re-appears while running; on completion → New/Updated/Errors shown + toast.
