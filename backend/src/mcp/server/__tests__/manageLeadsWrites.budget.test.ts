/**
 * ENG-2840 PR B: one add or delete call has a time budget. Each row is one or two self-calls and the caller's connection has its own timeout,
 * so past the budget the remaining rows are NOT attempted and are reported as such: the caller sends only those again, instead of retrying
 * rows that already went through. The clock is controlled here (each call advances it), so no test waits.
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));
jest.mock('../../../services/leadImportFollowups', () => ({
  applyLeadImportFollowups: jest.fn().mockResolvedValue({ inheritedDoNotContact: [], doNotContactCheckFailed: 0 }),
}));

import { mcpFetch } from '../httpClient';
import { applyLeadImportFollowups } from '../../../services/leadImportFollowups';
import { executeLeadAdd, executeLeadDelete, ROW_WORK_BUDGET_MS } from '../manageLeadsWrites';

const mockFetch = mcpFetch as jest.Mock;
const ctxA = { userId: 'user-a1', agentUserId: 'user-a1' };

let now = 0;
const STEP_MS = 40_000; // each row's write takes this long on the controlled clock

beforeEach(() => {
  now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockFetch.mockReset();
  (applyLeadImportFollowups as jest.Mock).mockReset().mockResolvedValue({ inheritedDoNotContact: [], doNotContactCheckFailed: 0 });
});
afterEach(() => jest.restoreAllMocks());

describe('add: time budget', () => {
  it('stops starting new rows once the budget is spent, and says which rows were not touched', async () => {
    let created = 0;
    mockFetch.mockImplementation(async ({ method, path }: any) => {
      if (method === 'POST') {
        now += STEP_MS;
        return { leadId: `lead-${++created}` };
      }
      if (method === 'GET' && /\/lists\/[^/]+$/.test(path)) return { userId: 'user-a1' };
      throw new Error(`unexpected call ${method} ${path}`);
    });
    const leads = Array.from({ length: 6 }, (_, i) => ({ email: `r${i}@alpha.test` }));

    const out = await executeLeadAdd({ list_id: 'list-a1', leads }, ctxA);
    const summary = JSON.parse(out.content[0].text);

    // 90 s budget, 40 s per row: rows start at 0, 40 and 80 s, the fourth would start at 120 s.
    expect(ROW_WORK_BUDGET_MS).toBe(90_000);
    expect(summary).toMatchObject({ requested: 6, created: 3, failed: 0, notAttempted: 3 });
    expect(summary.results.map((r: any) => r.status)).toEqual(['created', 'created', 'created', 'not_attempted', 'not_attempted', 'not_attempted']);
    expect(summary.note).toContain('Send only those again');
    expect(mockFetch.mock.calls.filter(([o]: any) => o.method === 'POST')).toHaveLength(3);
    // The do-not-contact follow-up gets exactly the leads that were created: not the rows that were skipped, and it runs once, for the owner of the list.
    expect(applyLeadImportFollowups).toHaveBeenCalledTimes(1);
    expect(applyLeadImportFollowups).toHaveBeenCalledWith(
      'list-a1',
      'user-a1',
      [{ leadId: 'lead-1', email: 'r0@alpha.test' }, { leadId: 'lead-2', email: 'r1@alpha.test' }, { leadId: 'lead-3', email: 'r2@alpha.test' }],
      { actingUserId: 'user-a1', validate: false },
    );
  });

  it('a call inside its budget touches every row and reports no notAttempted', async () => {
    mockFetch.mockImplementation(async ({ method }: any) => (method === 'POST' ? { leadId: 'l' } : { userId: 'user-a1' }));
    const out = await executeLeadAdd({ list_id: 'list-a1', leads: [{ email: 'a@alpha.test' }, { email: 'b@alpha.test' }] }, ctxA);
    const summary = JSON.parse(out.content[0].text);
    expect(summary).toMatchObject({ requested: 2, created: 2 });
    expect(summary.notAttempted).toBeUndefined();
  });

  it('the budget is a parameter, so a short one stops the call at once', async () => {
    mockFetch.mockImplementation(async ({ method }: any) => {
      if (method === 'POST') now += 10;
      return method === 'POST' ? { leadId: 'l' } : { userId: 'user-a1' };
    });
    const out = await executeLeadAdd({ list_id: 'list-a1', leads: [{ email: 'a@alpha.test' }, { email: 'b@alpha.test' }, { email: 'c@alpha.test' }] }, ctxA, { budgetMs: 5 });
    const summary = JSON.parse(out.content[0].text);
    expect(summary).toMatchObject({ created: 1, notAttempted: 2 });
  });
});

describe('delete: time budget', () => {
  it('stops starting new rows once the budget is spent; the rows it did delete are counted', async () => {
    mockFetch.mockImplementation(async ({ method }: any) => {
      if (method === 'DELETE') now += STEP_MS;
      return { ok: true };
    });
    const out = await executeLeadDelete({ list_id: 'list-a1', lead_ids: ['1', '2', '3', '4', '5'] }, ctxA);
    const summary = JSON.parse(out.content[0].text);
    expect(summary).toMatchObject({ requested: 5, deleted: 3, failed: 0, notAttempted: 2 });
    expect(summary.results.slice(3).map((r: any) => r.status)).toEqual(['not_attempted', 'not_attempted']);
    expect(mockFetch.mock.calls.filter(([o]: any) => o.method === 'DELETE')).toHaveLength(3);
  });
});
