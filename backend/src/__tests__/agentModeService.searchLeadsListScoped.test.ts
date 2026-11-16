/**
 * ENG-2360: search_leads must allow list-scoped reads with no filters/search,
 * still reject a fully empty query, and deleteLeadsByFilter's filter-free
 * guard must stay unchanged.
 */
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    getLeadsByListId: jest.fn(),
    canOrgMemberAccessList: jest.fn(),
  },
}));
jest.mock('../services/crmAccessControl', () => ({
  ...jest.requireActual('../services/crmAccessControl'),
  canDestructiveCrmList: jest.fn().mockResolvedValue(true),
}));

import { searchLeads, deleteLeadsByFilter } from '../emma/impl/leads';
import { crmDb } from '../services/db';

const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const userId = 'user-1';
const lead = (listId: string, i: number) => ({
  leadId: `${listId}-${i}`, listId, email: `${listId}-${i}@x.com`,
  firstName: 'F', lastName: 'L', company: 'Co', title: 'T', customFields: {},
});

describe('searchLeads list-scoped reads (ENG-2360)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockCrmDb.canOrgMemberAccessList as jest.Mock).mockResolvedValue(true);
    mockCrmDb.getLeadListById.mockImplementation(async (id: string) => ({ listId: id, userId, name: `Name ${id}` }) as any);
    // Honours the exclusive start key like DynamoDB: resume after leadId.
    mockCrmDb.getLeadsByListId.mockImplementation(async (id: string, _limit?: number, start?: any) => {
      const all = Array.from({ length: 5 }, (_, i) => lead(id, i));
      const from = start?.leadId ? all.findIndex((l) => l.leadId === start.leadId) + 1 : 0;
      return { items: all.slice(from), lastEvaluatedKey: null } as any;
    });
  });

  it('list_ids only with filters: [] returns the first page and a next_cursor', async () => {
    const result = await searchLeads(undefined, [], userId, 3, { listIds: ['list-A', 'list-B'] });
    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(3);
    expect(result.next_cursor).toBeTruthy();

    const page2 = await searchLeads(undefined, [], userId, 3, { listIds: ['list-A', 'list-B'], cursor: result.next_cursor });
    expect(page2.success).toBe(true);
    expect(page2.leads.length).toBeGreaterThan(0);
    const ids1 = result.leads.map((l: any) => l.leadId ?? l.id);
    const ids2 = page2.leads.map((l: any) => l.leadId ?? l.id);
    expect(ids2.some((id: string) => ids1.includes(id))).toBe(false);
  });

  it('single list_id with undefined filters returns leads', async () => {
    const result = await searchLeads('list-A', undefined as any, userId, 10);
    expect(result.success).toBe(true);
    expect(result.leads).toHaveLength(5);
  });

  it('rejects a call with no filters, no search and no list scope', async () => {
    const result = await searchLeads(undefined, [], userId, 10, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/filter criterion/);
    expect(result.error).toMatch(/list_id/);
    expect(mockCrmDb.getLeadsByListId).not.toHaveBeenCalled();
  });

  it('deleteLeadsByFilter still rejects filter-free bulk deletion', async () => {
    const result = await deleteLeadsByFilter('list-A', [], userId, true);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Provide at least one filter criterion to identify leads to delete');
  });
});
