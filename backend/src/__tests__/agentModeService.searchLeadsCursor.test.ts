/**
 * Unit tests for AgentModeService.searchLeads cursor pagination.
 *
 * The original implementation advanced the cursor to the END of the underlying
 * DynamoDB page even when the inner loop broke early after hitting the caller's
 * limit. The next cursor call therefore skipped leads that were never scanned.
 *
 * The fix uses a lead-level cursor: when we break early, we emit the leadId of
 * the last lead actually scanned, and the next call resumes after that leadId.
 */

jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  }
}));

import { AgentModeService } from '../services/agentModeService';
import { crmDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

describe('AgentModeService.searchLeads — cursor pagination', () => {
  let service: AgentModeService;
  const userId = 'user-1';
  const listId = 'list-1';

  const mockList = { listId, userId, name: 'Test List' };

  // Build N leads that all match a simple "is_not_empty" filter on email.
  const buildLeads = (count: number, prefix = 'lead') =>
    Array.from({ length: count }, (_, i) => ({
      leadId: `${prefix}-${String(count - i).padStart(4, '0')}`, // descending IDs (matches ScanIndexForward:false)
      listId,
      email: `user${i}@example.com`,
      firstName: `First${i}`,
      lastName: `Last${i}`,
      company: `Co${i}`,
      title: 'Engineer',
      customFields: {},
    }));

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    mockCrmDb.getLeadListById.mockResolvedValue(mockList as any);
  });

  it('returns next_cursor anchored to last scanned leadId when limit is hit mid-page', async () => {
    // 50 matching leads in a single underlying page; caller asks for limit 10.
    const leads = buildLeads(50);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: leads,
      lastEvaluatedKey: { listId, leadId: leads[leads.length - 1].leadId },
    } as any);

    const result = await service.searchLeads(
      listId,
      [{ field: 'email', operator: 'is_not_empty' }],
      userId,
      10,
    );

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(10);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).toBeTruthy();

    // Decode and verify the cursor anchors at the LAST SCANNED lead (#10 in the
    // descending order), not the end of the 50-lead page.
    const decoded = JSON.parse(Buffer.from(result.next_cursor, 'base64').toString('utf8'));
    // Cursor must reference lead #10 (the 10th scanned), not the 50th.
    expect(decoded.leadId).toBe(leads[9].leadId);
  });

  it('paging through sparse matches yields each match exactly once (no duplicates, no drops)', async () => {
    // 60 leads total, first 30 match, rest don't. Caller pages with limit=5.
    // First call should return the first 5 matches and a cursor to scan more.
    const allLeads = Array.from({ length: 60 }, (_, i) => ({
      leadId: `lead-${String(60 - i).padStart(4, '0')}`,
      listId,
      email: i < 30 ? `match${i}@example.com` : '',
      firstName: 'X',
      lastName: 'Y',
      company: 'Z',
      title: 'T',
      customFields: {},
    }));

    // Simulate DynamoDB: queries return slices based on ExclusiveStartKey.
    mockCrmDb.getLeadsByListId.mockImplementation(async (_lid: string, _limit?: number, exclusiveStartKey?: any) => {
      let startIdx = 0;
      if (exclusiveStartKey?.leadId) {
        startIdx = allLeads.findIndex((l: any) => l.leadId === exclusiveStartKey.leadId) + 1;
      }
      const slice = allLeads.slice(startIdx, startIdx + 200);
      const last = slice[slice.length - 1];
      const hasMore = startIdx + slice.length < allLeads.length;
      return {
        items: slice,
        lastEvaluatedKey: hasMore && last ? { listId, leadId: last.leadId } : null,
      } as any;
    });

    const allMatched: string[] = [];
    let cursor: string | undefined;
    let safety = 20;
    do {
      const r: any = await service.searchLeads(
        listId,
        [{ field: 'email', operator: 'is_not_empty' }],
        userId,
        5,
        cursor ? { cursor } : undefined,
      );
      expect(r.success).toBe(true);
      for (const lead of r.leads) {
        allMatched.push(lead.leadId);
      }
      cursor = r.has_more ? r.next_cursor : undefined;
      safety -= 1;
    } while (cursor && safety > 0);

    expect(safety).toBeGreaterThan(0);
    // 30 matches expected, each exactly once.
    expect(allMatched).toHaveLength(30);
    expect(new Set(allMatched).size).toBe(30);
  });

  it('returns has_more=false and no next_cursor when total matches < limit', async () => {
    const leads = buildLeads(3);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: leads,
      lastEvaluatedKey: null,
    } as any);

    const result = await service.searchLeads(
      listId,
      [{ field: 'email', operator: 'is_not_empty' }],
      userId,
      20,
    );

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(3);
    expect(result.has_more).toBe(false);
    expect(result.next_cursor).toBeUndefined();
  });

  it('treats invalid cursor string as start of list', async () => {
    const leads = buildLeads(2);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: leads,
      lastEvaluatedKey: null,
    } as any);

    const result = await service.searchLeads(
      listId,
      [{ field: 'email', operator: 'is_not_empty' }],
      userId,
      10,
      { cursor: 'not-valid-base64-json!!!' },
    );

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(2);
    // First underlying call must have been made with no ExclusiveStartKey.
    expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledWith(listId, expect.any(Number), undefined);
  });

  it('accepts legacy page-end cursor format ({listId, leadId}) for back-compat', async () => {
    // Old code emitted pageResult.lastEvaluatedKey directly as the cursor.
    // After upgrade, in-flight cursors of that shape must still work.
    const leads = buildLeads(2);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: leads,
      lastEvaluatedKey: null,
    } as any);

    const legacyCursor = Buffer.from(JSON.stringify({ listId, leadId: 'lead-9999' })).toString('base64');

    const result = await service.searchLeads(
      listId,
      [{ field: 'email', operator: 'is_not_empty' }],
      userId,
      10,
      { cursor: legacyCursor },
    );

    expect(result.success).toBe(true);
    // Underlying call must have used the legacy cursor's {listId, leadId} key.
    expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledWith(
      listId,
      expect.any(Number),
      expect.objectContaining({ listId, leadId: 'lead-9999' }),
    );
  });
});
