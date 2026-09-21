/**
 * Tests for multi-list support in AgentModeService.searchLeads.
 *
 * search_leads accepts list_ids: string[] (capped at 5) in addition to the
 * legacy single list_id. Cursor freezes the list set so paging is stable
 * even if lists are added/removed between calls. Output leads carry their
 * listId/listName so Emma can attribute results.
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

describe('AgentModeService.searchLeads — multi-list (list_ids)', () => {
  let service: AgentModeService;
  const userId = 'user-1';

  const listA = { listId: 'list-A', userId, name: 'List A' };
  const listB = { listId: 'list-B', userId, name: 'List B' };

  const buildLead = (listId: string, leadId: string, email: string) => ({
    leadId,
    listId,
    email,
    firstName: 'F',
    lastName: 'L',
    company: 'Co',
    title: 'T',
    customFields: {},
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
  });

  it('searches across two lists and returns results with listId/listName attribution', async () => {
    mockCrmDb.getLeadListById.mockImplementation(async (id: string) => {
      if (id === 'list-A') return listA as any;
      if (id === 'list-B') return listB as any;
      return null as any;
    });
    mockCrmDb.getLeadsByListId.mockImplementation(async (id: string) => {
      if (id === 'list-A') {
        return { items: [buildLead('list-A', 'a-1', 'a1@x.com'), buildLead('list-A', 'a-2', 'a2@x.com')], lastEvaluatedKey: null } as any;
      }
      if (id === 'list-B') {
        return { items: [buildLead('list-B', 'b-1', 'b1@x.com')], lastEvaluatedKey: null } as any;
      }
      return { items: [], lastEvaluatedKey: null } as any;
    });

    const result = await service.searchLeads(
      undefined as any, // legacy listId not used
      [{ field: 'email', operator: 'is_not_empty' }],
      userId,
      10,
      { listIds: ['list-A', 'list-B'] }
    );

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(3);
    // Every lead must carry its listId and listName.
    const fromA = result.leads.filter((l: any) => l.listId === 'list-A');
    const fromB = result.leads.filter((l: any) => l.listId === 'list-B');
    expect(fromA).toHaveLength(2);
    expect(fromB).toHaveLength(1);
    expect(fromA[0].listName).toBe('List A');
    expect(fromB[0].listName).toBe('List B');
  });

  it('rejects more than 5 list_ids', async () => {
    const result = await service.searchLeads(
      undefined as any,
      [{ field: 'email', operator: 'is_not_empty' }],
      userId,
      10,
      { listIds: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] }
    );

    expect(result.success).toBe(false);
    expect(String(result.message || result.error || '').toLowerCase()).toMatch(/5|too many|limit/);
  });

  it('cursor freezes list set: round-trip resumes on the same list set even with limit', async () => {
    // 4 leads in A, 4 leads in B, limit=3, paged through.
    const aLeads = [1, 2, 3, 4].map((n) => buildLead('list-A', `a-${n}`, `a${n}@x.com`));
    const bLeads = [1, 2, 3, 4].map((n) => buildLead('list-B', `b-${n}`, `b${n}@x.com`));

    mockCrmDb.getLeadListById.mockImplementation(async (id: string) => {
      if (id === 'list-A') return listA as any;
      if (id === 'list-B') return listB as any;
      return null as any;
    });
    mockCrmDb.getLeadsByListId.mockImplementation(async (id: string, _limit?: number, esk?: any) => {
      const src = id === 'list-A' ? aLeads : bLeads;
      let startIdx = 0;
      if (esk?.leadId) {
        startIdx = src.findIndex((l) => l.leadId === esk.leadId) + 1;
      }
      return { items: src.slice(startIdx), lastEvaluatedKey: null } as any;
    });

    const seen: string[] = [];
    let cursor: string | undefined;
    let safety = 10;
    do {
      const r: any = await service.searchLeads(
        undefined as any,
        [{ field: 'email', operator: 'is_not_empty' }],
        userId,
        3,
        { listIds: ['list-A', 'list-B'], cursor }
      );
      expect(r.success).toBe(true);
      for (const l of r.leads) seen.push(`${l.listId}:${l.leadId}`);
      cursor = r.has_more ? r.next_cursor : undefined;
      safety -= 1;
    } while (cursor && safety > 0);

    expect(safety).toBeGreaterThan(0);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8); // no duplicates
    // First 4 from A (descending by mock insert order), then 4 from B.
    expect(seen.slice(0, 4).every((s) => s.startsWith('list-A:'))).toBe(true);
    expect(seen.slice(4).every((s) => s.startsWith('list-B:'))).toBe(true);
  });

  it('skips lists the user cannot access without throwing', async () => {
    mockCrmDb.getLeadListById.mockImplementation(async (id: string) => {
      if (id === 'list-A') return listA as any;
      if (id === 'list-B') return listB as any;
      return null as any;
    });
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockImplementation(async (_uid: string, list: any) => {
      return list.listId === 'list-A'; // deny B
    });
    mockCrmDb.getLeadsByListId.mockImplementation(async (id: string) => {
      if (id === 'list-A') return { items: [buildLead('list-A', 'a-1', 'a1@x.com')], lastEvaluatedKey: null } as any;
      return { items: [buildLead('list-B', 'b-1', 'b1@x.com')], lastEvaluatedKey: null } as any;
    });

    const result = await service.searchLeads(
      undefined as any,
      [{ field: 'email', operator: 'is_not_empty' }],
      userId,
      10,
      { listIds: ['list-A', 'list-B'] }
    );

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0].listId).toBe('list-A');
  });

  it('legacy single list_id call still works (no listId in lead output is required)', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(listA as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [buildLead('list-A', 'a-1', 'a1@x.com')],
      lastEvaluatedKey: null,
    } as any);

    const result = await service.searchLeads(
      'list-A',
      [{ field: 'email', operator: 'is_not_empty' }],
      userId,
      10,
    );

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(1);
    expect(result.listName).toBe('List A');
  });

  it('accepts a non-empty keyword search without structured filters', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(listA as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [buildLead('list-A', 'a-1', 'founder@openrouter.ai')],
      lastEvaluatedKey: null,
    } as any);

    const result = await service.searchLeads(
      'list-A',
      [],
      userId,
      10,
      { search: 'openrouter.ai' },
    );

    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0].email).toBe('founder@openrouter.ai');
  });

  it('keeps filter-free bulk deletion blocked', async () => {
    mockCrmDb.getLeadListById.mockResolvedValue(listA as any);

    const result = await service.deleteLeadsByFilter('list-A', [], userId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/filter criterion/i);
  });

  it('still rejects search_leads with neither filters nor a search term', async () => {
    const result = await service.searchLeads('list-A', [], userId);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/filter criterion/i);
    expect(mockCrmDb.getLeadListById).not.toHaveBeenCalled();
  });
});
