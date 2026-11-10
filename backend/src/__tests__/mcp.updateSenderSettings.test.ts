/**
 * ENG-2897: update_sender_settings — own-account defaults only, write-scoped, read-back.
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
const CTX = { userId: 'u-1', agentUserId: 'u-1' };

const before = {
  senders: [
    { id: 's1', email: 'a@acme.com', fromName: 'A', notes: 'n', senderProvider: 'resend', dailyLimit: 50, effectiveDailyLimit: 20, sentToday: 1, sentTodayKnown: true },
    { id: 's2', email: 'b@acme.com', fromName: 'B', senderType: 'gmail', senderProvider: 'gmail', connectedAccountId: 'g1', gmailAccountId: 'g1', effectiveDailyLimit: null, sentToday: 0, sentTodayKnown: false },
  ],
  defaultSenderId: 's1',
  defaultLinkedInAccountId: 'li-old',
  connectedEmailAccounts: [],
};
const accounts = {
  success: true,
  accounts: [
    { platform: 'unipile', account_id: 'li-mine', owned: true },
    { platform: 'unipile', account_id: 'li-teammate', owned: false, sharedWithOrg: true },
  ],
};

function route(after: any) {
  mockFetch.mockImplementation(async (opts: any) => {
    if (opts.path === '/api/oauth/connected-accounts') return accounts as any;
    if (opts.method === 'POST') return { message: 'ok' } as any;
    const posted = mockFetch.mock.calls.some((c: any) => c[0].method === 'POST');
    return (posted ? after : before) as any;
  });
}
const posts = () => mockFetch.mock.calls.filter((c: any) => c[0].method === 'POST').map((c: any) => c[0]);

describe('ENG-2897 update_sender_settings', () => {
  beforeEach(() => { jest.clearAllMocks(); mockFetch.mockReset(); });

  it('sets own default sender + LinkedIn account, preserves senders, returns read-back', async () => {
    route({ ...before, defaultSenderId: 's2', defaultLinkedInAccountId: 'li-mine' });
    const out = parse(await mcpToolRegistry.execute('update_sender_settings',
      { default_sender_id: 's2', default_linkedin_account_id: 'li-mine', client_id: 'victim' }, CTX));
    const [post] = posts();
    expect(post.path).toBe('/api/crm/sender-emails');
    expect(post.context.userId).toBe('u-1');
    expect(JSON.stringify(mockFetch.mock.calls)).not.toContain('victim');
    expect(post.body.defaultSenderId).toBe('s2');
    expect(post.body.defaultLinkedInAccountId).toBe('li-mine');
    expect(post.body.senders.map((s: any) => s.id)).toEqual(['s1', 's2']);
    expect(post.body.senders[1]).toMatchObject({ senderType: 'gmail', connectedAccountId: 'g1' });
    expect(out.default_sender_id).toBe('s2');
    expect(out.default_linkedin_account_id).toBe('li-mine');
    expect(out.senders).toHaveLength(2);
  });

  it('keeps the existing LinkedIn default when only the email sender changes', async () => {
    route({ ...before, defaultSenderId: 's2' });
    await mcpToolRegistry.execute('update_sender_settings', { default_sender_id: 's2' }, CTX);
    expect(posts()[0].body.defaultLinkedInAccountId).toBe('li-old');
    expect(mockFetch.mock.calls.some((c: any) => c[0].path === '/api/oauth/connected-accounts')).toBe(false);
  });

  it.each([
    [{ default_linkedin_account_id: 'li-teammate' }, /not a LinkedIn account you own/],
    [{ default_linkedin_account_id: 'li-nonexistent' }, /not a LinkedIn account you own/],
    [{ default_sender_id: 's-foreign' }, /not one of your configured senders/],
    [{}, /Provide default_sender_id/],
  ])('rejects %j without writing', async (args, msg) => {
    route(before);
    await expect(mcpToolRegistry.execute('update_sender_settings', args, CTX)).rejects.toThrow(msg);
    expect(posts()).toHaveLength(0);
  });

  it.each([[''], [null], ['   ']])('treats default_linkedin_account_id=%j as not set', async (blank) => {
    route({ ...before, defaultSenderId: 's2' });
    const out = parse(await mcpToolRegistry.execute('update_sender_settings',
      { default_sender_id: 's2', default_linkedin_account_id: blank }, CTX));
    expect(posts()[0].body).toMatchObject({ defaultSenderId: 's2', defaultLinkedInAccountId: 'li-old' });
    expect(out.default_sender_id).toBe('s2');
  });

  it('restarts when the config moves between read and write (no stale full-list overwrite)', async () => {
    const moved = { ...before, senders: [...before.senders, { id: 's7', email: 'm@acme.com', fromName: 'M' }] };
    let gets = 0;
    mockFetch.mockImplementation(async (opts: any) => {
      if (opts.method === 'POST') return { message: 'ok' } as any;
      gets++;
      if (mockFetch.mock.calls.some((c: any) => c[0].method === 'POST')) return { ...moved, defaultSenderId: 's2' } as any;
      return (gets === 1 ? before : moved) as any;
    });
    await mcpToolRegistry.execute('update_sender_settings', { default_sender_id: 's2' }, CTX);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].body.senders.map((s: any) => s.id)).toEqual(['s1', 's2', 's7']);
  });

  it('never reports a default that a concurrent writer overwrote', async () => {
    route(before); // every read-back still shows s1
    await expect(mcpToolRegistry.execute('update_sender_settings', { default_sender_id: 's2' }, CTX))
      .rejects.toThrow(/changed concurrently/);
    expect(posts()).toHaveLength(3);
  });

  it('is a write tool: a tools:read key is denied', () => {
    const tool = mcpToolRegistry.getTool('update_sender_settings') as any;
    expect(tool.readOnly).toBeFalsy();
    const req = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_sender_settings', arguments: {} } };
    expect(findScopeDenial(req, ['tools:read'], (n) => mcpToolRegistry.getTool(n) as any)).not.toBeNull();
  });
});
