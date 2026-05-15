/**
 * Unit tests for enqueueFindEmailJobForNewLeads — the post-import auto-enrich
 * glue. Verifies the empty-input guard, idempotency, quota clamping,
 * happy-path delegation to startEmailJob + findEmailsForLeadsInBackground,
 * and that the runner kick-off is fire-and-forget.
 *
 * Mocks all external dependencies (db, runner, quota tracker) so the test is
 * pure. Patterns mirror crm.enrichSoRoutes.test.ts.
 */

// ─── Mocks (must be set before importing the module under test) ──────────────

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: jest.fn(),
  },
}));

jest.mock('../services/crmFindEmailRunner', () => ({
  findEmailsForLeadsInBackground: jest.fn(),
}));

import {
  enqueueFindEmailJobForNewLeads,
  setQuotaTrackerForAutoEnrich,
} from '../services/agentModeService.autoEnrich';
import { crmDb } from '../services/db';
import { findEmailsForLeadsInBackground } from '../services/crmFindEmailRunner';
import {
  __resetJobsForTesting,
  startEmailJob,
} from '../services/emailJobTracker';
import { DEFAULT_DAILY_LIMITS, type QuotaTracker, type UsageRow } from '../services/enrichSoQuota';

const mockGetLeadById = crmDb.getLeadById as jest.Mock;
const mockRunner = findEmailsForLeadsInBackground as jest.Mock;

// Build a per-test fake QuotaTracker that returns whatever findCount we set.
function buildFakeTracker(findCount: number): QuotaTracker {
  return {
    async checkQuota() { /* unused */ },
    async recordUsage() { /* unused */ },
    async getUsage(): Promise<UsageRow> {
      return {
        date: '2026-05-08',
        validateCount: 0,
        findCount,
        reverseCount: 0,
        lookupByEmailCount: 0,
      };
    },
    async checkLookupByEmailQuota() { /* unused */ },
    async recordLookupByEmailUsage() { /* unused */ },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetJobsForTesting();
  setQuotaTrackerForAutoEnrich(null);
  // Default: runner resolves quickly. Tests can override to test fire-and-forget.
  mockRunner.mockResolvedValue(undefined);
});

afterEach(() => {
  __resetJobsForTesting();
  setQuotaTrackerForAutoEnrich(null);
});

describe('enqueueFindEmailJobForNewLeads', () => {
  it('returns null on empty leadIds (no DB or tracker calls)', async () => {
    const result = await enqueueFindEmailJobForNewLeads('u1', 'list-1', []);
    expect(result).toBeNull();
    expect(mockGetLeadById).not.toHaveBeenCalled();
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('returns null when applicable list is empty (all leads have email or no name+org)', async () => {
    // Lead 1 has email already; lead 2 has nothing actionable; lead 3 has only firstName.
    mockGetLeadById.mockImplementation((_listId: string, leadId: string) => {
      if (leadId === 'L1') {
        return Promise.resolve({ leadId: 'L1', email: 'a@b.com', firstName: 'A', company: 'X' });
      }
      if (leadId === 'L2') {
        return Promise.resolve({ leadId: 'L2' });
      }
      if (leadId === 'L3') {
        return Promise.resolve({ leadId: 'L3', firstName: 'C' }); // no company / website / linkedin
      }
      return Promise.resolve(null);
    });

    setQuotaTrackerForAutoEnrich(buildFakeTracker(0));
    const result = await enqueueFindEmailJobForNewLeads('u1', 'list-1', ['L1', 'L2', 'L3']);

    expect(result).toBeNull();
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it("returns null with reason 'quota-exhausted' when remaining quota is 0", async () => {
    mockGetLeadById.mockResolvedValue({ leadId: 'L1', firstName: 'A', lastName: 'B', company: 'Acme' });
    // findCount maxed → remaining is 0.
    setQuotaTrackerForAutoEnrich(buildFakeTracker(DEFAULT_DAILY_LIMITS.find));

    const result = await enqueueFindEmailJobForNewLeads('u1', 'list-1', ['L1']);
    expect(result).toEqual({ jobId: '', queued: 0, reason: 'quota-exhausted' });
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('clamps applicable to remaining quota when applicable > remaining (returns clamped: true)', async () => {
    // 3 applicable leads, but only 2 quota left.
    mockGetLeadById.mockImplementation((_listId: string, leadId: string) =>
      Promise.resolve({ leadId, firstName: 'F' + leadId, lastName: 'L', company: 'C' }),
    );
    setQuotaTrackerForAutoEnrich(buildFakeTracker(DEFAULT_DAILY_LIMITS.find - 2));

    const result = await enqueueFindEmailJobForNewLeads('u1', 'list-1', ['L1', 'L2', 'L3']);
    expect(result).not.toBeNull();
    expect(result!.queued).toBe(2);
    expect(result!.clamped).toBe(true);
    expect(result!.reason).toBe('quota-clamped');
    expect(typeof result!.jobId).toBe('string');
    expect(result!.jobId).toMatch(/^find_/);
    expect(mockRunner).toHaveBeenCalledTimes(1);
    // The leads passed to the runner should have length 2 (clamped).
    const passedLeads = mockRunner.mock.calls[0][1];
    expect(passedLeads).toHaveLength(2);
  });

  it("idempotency: returns existing jobId when an active 'find' job for the listId already exists, and does NOT call findEmailsForLeadsInBackground again", async () => {
    // Pre-seed an active 'find' job for this list.
    const existing = startEmailJob({ kind: 'find', listId: 'list-1', userId: 'u1', total: 5 });

    mockGetLeadById.mockResolvedValue({ leadId: 'L1', firstName: 'A', lastName: 'B', company: 'Acme' });
    setQuotaTrackerForAutoEnrich(buildFakeTracker(0));

    const result = await enqueueFindEmailJobForNewLeads('u1', 'list-1', ['L1']);

    expect(result).toEqual({
      jobId: existing.jobId,
      queued: 0,
      reason: 'in-progress',
    });
    // Critically: no second runner call, no second startEmailJob.
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('happy path: returns { jobId, queued } and calls startEmailJob + findEmailsForLeadsInBackground', async () => {
    mockGetLeadById.mockImplementation((_listId: string, leadId: string) =>
      Promise.resolve({ leadId, firstName: 'F', lastName: 'L', company: 'Acme' }),
    );
    setQuotaTrackerForAutoEnrich(buildFakeTracker(0));

    const result = await enqueueFindEmailJobForNewLeads('u1', 'list-1', ['L1', 'L2']);

    expect(result).not.toBeNull();
    expect(result!.queued).toBe(2);
    expect(result!.clamped).toBeUndefined();
    expect(result!.reason).toBeUndefined();
    expect(result!.jobId).toMatch(/^find_/);

    // Runner was called once with (listId, applicable leads, userId, jobId).
    expect(mockRunner).toHaveBeenCalledTimes(1);
    const [callListId, callLeads, callUserId, callJobId] = mockRunner.mock.calls[0];
    expect(callListId).toBe('list-1');
    expect(callLeads).toHaveLength(2);
    expect(callUserId).toBe('u1');
    expect(callJobId).toBe(result!.jobId);
  });

  it('findEmailsForLeadsInBackground is fire-and-forget — function returns before the runner promise settles', async () => {
    mockGetLeadById.mockImplementation((_listId: string, leadId: string) =>
      Promise.resolve({ leadId, firstName: 'F', lastName: 'L', company: 'Acme' }),
    );
    setQuotaTrackerForAutoEnrich(buildFakeTracker(0));

    // Runner returns a never-resolving promise — if our function awaits it,
    // this test will time out (jest default 5s).
    // Using a single-element tuple sidesteps TS's narrowing of variables that
    // are only assigned inside a Promise constructor callback (would narrow to
    // `never` and reject `resolveRunner?.()`).
    const runnerResolver: { fn: (() => void) | null } = { fn: null };
    mockRunner.mockImplementation(
      () => new Promise<void>((resolve) => { runnerResolver.fn = resolve; }),
    );

    const start = Date.now();
    const result = await enqueueFindEmailJobForNewLeads('u1', 'list-1', ['L1']);
    const elapsed = Date.now() - start;

    // Should return promptly (well under 1s) even though runner never resolved.
    expect(elapsed).toBeLessThan(1000);
    expect(result).not.toBeNull();
    expect(result!.queued).toBe(1);
    expect(mockRunner).toHaveBeenCalledTimes(1);

    // Cleanup: let the runner resolve so jest doesn't hang on open promises.
    runnerResolver.fn?.();
  });
});
