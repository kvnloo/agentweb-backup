/**
 * Unit tests for HubSpotService.getListMembershipContactIds / getContactsForList
 * (ENG-600: HubSpot segment -> Meta Custom Audience source data)
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('axios');
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: jest.fn(),
  getAccountById: jest.fn(),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../config/integrations', () => ({
  getHubSpotConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    tokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    redirectUri: 'http://localhost:3001/api/oauth/hubspot/callback',
    scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
    authorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenInfoUrl: 'https://api.hubapi.com/oauth/v1/access-tokens',
  }),
}));

import axios from 'axios';
import { HubSpotService } from '../services/hubspotService';

const mockAxiosGet = axios.get as jest.Mock;
const mockAxiosPost = axios.post as jest.Mock;

describe('HubSpotService — getListMembershipContactIds', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = HubSpotService.fromToken('test-token');
  });

  it('rejects an empty listId', async () => {
    await expect(svc.getListMembershipContactIds('')).rejects.toThrow('listId is required');
  });

  it('fetches a single page of membership record IDs', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: { results: [{ recordId: '101' }, { recordId: '102' }] },
    });

    const result = await svc.getListMembershipContactIds('list-1');

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('crm/lists/2026-03/list-1/memberships'),
      expect.any(Object)
    );
    expect(result.contactIds).toEqual(['101', '102']);
    expect(result.nextCursor).toBeUndefined();
  });

  it('passes through the pagination cursor when provided', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { results: [] } });

    await svc.getListMembershipContactIds('list-1', { cursor: 'CURSOR_1' });

    expect(mockAxiosGet).toHaveBeenCalledWith(
      expect.stringContaining('after=CURSOR_1'),
      expect.any(Object)
    );
  });

  it('surfaces nextCursor from paging.next.after', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: { results: [{ recordId: '101' }], paging: { next: { after: 'CURSOR_2' } } },
    });

    const result = await svc.getListMembershipContactIds('list-1');

    expect(result.nextCursor).toBe('CURSOR_2');
  });

  it('propagates the underlying axios error (no silent swallow)', async () => {
    mockAxiosGet.mockRejectedValueOnce(new Error('HubSpot 404'));

    await expect(svc.getListMembershipContactIds('missing-list')).rejects.toThrow('HubSpot 404');
  });
});

describe('HubSpotService — getContactsForList', () => {
  let svc: HubSpotService;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = HubSpotService.fromToken('test-token');
  });

  it('returns an empty array for a list with no members', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { results: [] } });

    const contacts = await svc.getContactsForList('empty-list');

    expect(contacts).toEqual([]);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it('paginates membership pages then batch-reads contact properties', async () => {
    mockAxiosGet
      .mockResolvedValueOnce({
        data: { results: [{ recordId: '1' }, { recordId: '2' }], paging: { next: { after: 'CURSOR_1' } } },
      })
      .mockResolvedValueOnce({
        data: { results: [{ recordId: '3' }] },
      });
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [
          { id: '1', properties: { email: 'a@example.com', firstname: 'A', lastname: 'One', phone: '111' } },
          { id: '2', properties: { email: 'b@example.com', firstname: 'B', lastname: 'Two', phone: '' } },
          { id: '3', properties: { email: '', firstname: 'C', lastname: 'Three', phone: '333' } },
        ],
      },
    });

    const contacts = await svc.getContactsForList('list-1');

    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('crm/v3/objects/contacts/batch/read'),
      expect.objectContaining({ inputs: [{ id: '1' }, { id: '2' }, { id: '3' }] }),
      expect.any(Object)
    );
    expect(contacts).toEqual([
      { contactId: '1', email: 'a@example.com', firstname: 'A', lastname: 'One', phone: '111' },
      { contactId: '2', email: 'b@example.com', firstname: 'B', lastname: 'Two', phone: '' },
      { contactId: '3', email: '', firstname: 'C', lastname: 'Three', phone: '333' },
    ]);
  });

  it('chunks batch/read calls at 100 contact IDs', async () => {
    const memberIds = Array.from({ length: 150 }, (_, i) => ({ recordId: String(i) }));
    mockAxiosGet.mockResolvedValueOnce({ data: { results: memberIds } });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { results: [] } })
      .mockResolvedValueOnce({ data: { results: [] } });

    await svc.getContactsForList('big-list');

    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    expect((mockAxiosPost.mock.calls[0][1] as any).inputs).toHaveLength(100);
    expect((mockAxiosPost.mock.calls[1][1] as any).inputs).toHaveLength(50);
  });

  it('logs and skips a failed batch/read chunk without throwing', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { results: [{ recordId: '1' }] } });
    mockAxiosPost.mockRejectedValueOnce(new Error('batch/read failed'));

    const contacts = await svc.getContactsForList('list-1');

    expect(contacts).toEqual([]);
  });

  it('rejects an empty listId', async () => {
    await expect(svc.getContactsForList('')).rejects.toThrow('listId is required');
  });
});
