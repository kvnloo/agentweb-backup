/**
 * ENG-2868: list_sender_settings — read-only, own-account, allow-listed shape.
 */
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import { findScopeDenial } from '../mcp/server/apiKeyScopes';
import '../mcp/server/apiTools';

const mockFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const parse = (r: any) => JSON.parse(r.content[0].text);

const routePayload = {
  senders: [{
    id: 's1', email: 'a@acme.com', fromName: 'A', notes: 'internal', dailyLimit: 50,
    senderProvider: 'gmail', connectedAccountId: 'g1', gmailAccountId: 'g1',
    effectiveDailyLimit: 20, sentToday: 3, warmupStartedAt: '2026-11-01',
    accessToken: 'SECRET', refresh_token: 'SECRET',
  }],
  defaultSenderId: 's1',
  defaultLinkedInAccountId: 'li-9',
  connectedEmailAccounts: [{ account_id: 'g1', account_name: 'A', email: 'a@acme.com', platform: 'gmail', config: { token: 'SECRET' } }],
  connectedGmailAccounts: [],
};

describe('ENG-2868 list_sender_settings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the caller own sender emails and LinkedIn default via runtime identity', async () => {
    mockFetch.mockResolvedValueOnce(routePayload as any);
    const out = parse(await mcpToolRegistry.execute('list_sender_settings', {}, { userId: 'u-1', agentUserId: 'u-1' }));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0][0] as any;
    expect(call.method).toBe('GET');
    expect(call.path).toBe('/api/crm/sender-emails');
    expect(call.context.userId).toBe('u-1');
    expect(out.default_sender_id).toBe('s1');
    expect(out.default_linkedin_account_id).toBe('li-9');
    expect(out.senders[0]).toMatchObject({ id: 's1', email: 'a@acme.com', effective_daily_limit: 20, sent_today: 3 });
  });

  it('reports unknown usage as null, not zero (uncapped or failed usage read)', async () => {
    mockFetch.mockResolvedValueOnce({
      ...routePayload,
      senders: [{ ...routePayload.senders[0], effectiveDailyLimit: null, sentToday: 0, sentTodayKnown: false }],
    } as any);
    const out = parse(await mcpToolRegistry.execute('list_sender_settings', {}, { userId: 'u-1', agentUserId: 'u-1' }));
    expect(out.senders[0].sent_today).toBeNull();
  });

  it('ignores account-selecting args (no cross-account access)', async () => {
    mockFetch.mockResolvedValueOnce(routePayload as any);
    await mcpToolRegistry.execute('list_sender_settings', { client_id: 'victim', user_id: 'victim', userId: 'victim' }, { userId: 'u-1', agentUserId: 'u-1' });
    const call = mockFetch.mock.calls[0][0] as any;
    expect(call.path).toBe('/api/crm/sender-emails');
    expect(call.context.userId).toBe('u-1');
    expect(JSON.stringify(call)).not.toContain('victim');
  });

  it('never surfaces secrets or unlisted fields', async () => {
    mockFetch.mockResolvedValueOnce(routePayload as any);
    const text = JSON.stringify(parse(await mcpToolRegistry.execute('list_sender_settings', {}, { userId: 'u-1', agentUserId: 'u-1' })));
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('internal');
  });

  it('is registered read-only and callable with a tools:read key', () => {
    const tool = mcpToolRegistry.getTool('list_sender_settings') as any;
    expect(tool.readOnly).toBe(true);
    const req = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sender_settings', arguments: {} } };
    expect(findScopeDenial(req, ['tools:read'], (n) => mcpToolRegistry.getTool(n) as any)).toBeNull();
  });
});
