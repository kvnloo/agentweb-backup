/**
 * ENG-2840 PR B: create_lead_list delete never erases opt-outs. The leads of the list are read in-process (after the REST read proved access) and the
 * list is deleted only when none is marked do-not-contact and every lead could be read. Stores are mocked: the in-memory fake has no batch delete.
 */
jest.mock('../httpClient', () => ({ mcpFetch: jest.fn() }));
jest.mock('../../../services/db', () => ({ crmDb: { getLeadsByListId: jest.fn() } }));

import { mcpFetch } from '../httpClient';
import { crmDb } from '../../../services/db';
import { executeLeadListDelete } from '../manageLeadsWrites';

const mockFetch = mcpFetch as jest.Mock;
const mockPage = crmDb.getLeadsByListId as unknown as jest.Mock;
const ctxA = { userId: 'user-a1', agentUserId: 'user-a1' };
const methods = () => mockFetch.mock.calls.map(([o]: any) => `${o.method} ${o.path}`);

beforeEach(() => {
  mockFetch.mockReset().mockResolvedValue({ success: true });
  mockPage.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('executeLeadListDelete', () => {
  it('deletes a list whose leads are all contactable', async () => {
    mockPage.mockResolvedValueOnce({ items: [{ leadId: '1' }, { leadId: '2', contactStatus: 'active' }], lastEvaluatedKey: undefined });
    await executeLeadListDelete({ list_id: 'list-a1' }, ctxA);
    expect(methods()).toEqual(['GET /api/crm/lists/list-a1', 'DELETE /api/crm/lists/list-a1']);
  });

  it('reads every page, and refuses (no DELETE) when any lead is marked do-not-contact, counting them, also on a later page and by the legacy flag', async () => {
    mockPage
      .mockResolvedValueOnce({ items: [{ leadId: '1' }], lastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ items: [{ leadId: '2', contactStatus: 'do-not-contact' }, { leadId: '3', unsubscribedFromGroupEmail: true }], lastEvaluatedKey: undefined });
    await expect(executeLeadListDelete({ list_id: 'list-a1' }, ctxA)).rejects.toThrow('2 lead(s) marked do-not-contact');
    expect(methods()).toEqual(['GET /api/crm/lists/list-a1']);
    expect(mockPage).toHaveBeenCalledTimes(2);
  });

  it('fails closed: a read error, or a list too large to check, deletes nothing', async () => {
    mockPage.mockRejectedValueOnce(new Error('throttled'));
    await expect(executeLeadListDelete({ list_id: 'list-a1' }, ctxA)).rejects.toThrow('nothing was deleted');
    expect(methods()).toEqual(['GET /api/crm/lists/list-a1']);

    mockFetch.mockClear();
    mockPage.mockReset().mockResolvedValue({ items: Array.from({ length: 500 }, (_, i) => ({ leadId: `l${i}` })), lastEvaluatedKey: { k: 'more' } });
    await expect(executeLeadListDelete({ list_id: 'list-a1' }, ctxA)).rejects.toThrow('more than 20000 leads');
    expect(methods()).toEqual(['GET /api/crm/lists/list-a1']);
  });

  it('refuses without a list id, and a refused REST read (no access) stops before anything is read', async () => {
    await expect(executeLeadListDelete({}, ctxA)).rejects.toThrow('list_id is required');
    mockFetch.mockRejectedValueOnce(new Error('API error (403): no access'));
    await expect(executeLeadListDelete({ list_id: 'list-b1' }, ctxA)).rejects.toThrow('403');
    expect(mockPage).not.toHaveBeenCalled();
  });
});
