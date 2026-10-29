/**
 * External-MCP `read_email` (opt-in email:read scope). Pins the four controls:
 * opt-in scope, read actions only, own mailbox only for external callers, and
 * per-user rate limit + content-free audit line.
 */
const mockMcpFetch = jest.fn();
jest.mock('../httpClient', () => ({ mcpFetch: (...args: any[]) => mockMcpFetch(...args) }));
jest.mock('../../../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../services/funding/runFunding', () => ({
  currentRunFunding: () => ({ source: 'test' }),
  resolveRunFunding: jest.fn(),
  withRunFunding: (_f: any, fn: () => any) => fn(),
}));

import { mcpToolRegistry } from '../registry';
import { DEFAULT_API_KEY_SCOPES, findApiKeyOnlyToolCall, findScopeDenial } from '../apiKeyScopes';
import { READ_EMAIL_RATE_LIMIT, resetReadEmailRateLimit } from '../readEmailTool';

const lookup = (name: string) => mcpToolRegistry.getTool(name);
const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

const API_KEY_CTX = { userId: 'user-1', externalMcp: true, isInternal: false, authMethod: 'api_key', apiKeyId: 'k1' };
const OAUTH_CTX = { userId: 'user-1', externalMcp: true, isInternal: false, authMethod: 'oauth', oauthClientId: 'c1' };

beforeEach(() => {
  jest.clearAllMocks();
  resetReadEmailRateLimit();
  mockMcpFetch.mockResolvedValue({ emails: [{ id: 'm1', subject: 'secret subject' }], count: 1 });
});

describe('read_email scope gate', () => {
  it('denies a key without email:read', () => {
    expect(findScopeDenial(call('read_email'), ['tools:read'], lookup)).toMatchObject({ tool: 'read_email', requiredScope: 'email:read' });
  });

  it('denies a default-scope (legacy/default) key', () => {
    expect(DEFAULT_API_KEY_SCOPES).not.toContain('email:read');
    expect(findScopeDenial(call('read_email'), DEFAULT_API_KEY_SCOPES, lookup)).toMatchObject({ requiredScope: 'email:read' });
  });

  it('tools:execute alone does not imply email:read', () => {
    expect(findScopeDenial(call('read_email'), ['tools:execute'], lookup)).toMatchObject({ requiredScope: 'email:read' });
  });

  it('allows a key explicitly holding email:read', () => {
    expect(findScopeDenial(call('read_email'), ['email:read'], lookup)).toBeNull();
    expect(findScopeDenial(call('read_email'), ['tools:read', 'tools:execute', 'email:read'], lookup)).toBeNull();
  });

  it('does not change scope semantics for ordinary tools', () => {
    expect(findScopeDenial(call('send_email'), ['tools:execute'], lookup)).toBeNull();
    expect(findScopeDenial(call('send_email'), ['email:read'], lookup)).toMatchObject({ requiredScope: 'tools:execute' });
  });

  it('flags read_email for non-API-key auth at the HTTP layer', () => {
    expect(findApiKeyOnlyToolCall(call('read_email'), lookup)).toMatchObject({ tool: 'read_email' });
    expect(findApiKeyOnlyToolCall(call('send_email'), lookup)).toBeNull();
  });
});

describe('read_email execution', () => {
  it('refuses OAuth external callers outright, before any fetch', async () => {
    await expect(mcpToolRegistry.execute('read_email', { account_id: 'a', action: 'list' }, OAUTH_CTX))
      .rejects.toThrow(/only available to API keys/);
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('refuses action send (and any non-read action) before fetching', async () => {
    for (const action of ['send', 'reply', 'delete', undefined]) {
      await expect(mcpToolRegistry.execute('read_email', { account_id: 'a', action, to: 'x@y.com', body: 'hi' }, API_KEY_CTX))
        .rejects.toThrow(/not allowed/);
    }
    expect(mockMcpFetch).not.toHaveBeenCalled();
  });

  it('forwards only read fields and marks external calls own-mailbox-only', async () => {
    await mcpToolRegistry.execute('read_email', {
      account_id: 'a', action: 'search', query: 'invoice', max_results: 5, to: 'x@y.com', subject: 's', body: 'b',
    }, API_KEY_CTX);
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      method: 'POST',
      path: '/api/emma/email',
      body: { account_id: 'a', action: 'search', query: 'invoice', max_results: 5, own_mailbox_only: true },
    }));
  });

  it('writes a content-free audit line', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    await mcpToolRegistry.execute('read_email', { account_id: 'a', action: 'list' }, API_KEY_CTX);
    const line = info.mock.calls.map((c) => String(c[0])).find((s) => s.includes('mcp_read_email'))!;
    expect(JSON.parse(line)).toMatchObject({ event: 'mcp_read_email', userId: 'user-1', accountId: 'a', action: 'list', count: 1 });
    expect(line).not.toContain('secret subject');
    info.mockRestore();
  });

  it('rate-limits external callers per user', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    for (let i = 0; i < READ_EMAIL_RATE_LIMIT; i++) {
      await mcpToolRegistry.execute('read_email', { account_id: 'a', action: 'list' }, API_KEY_CTX);
    }
    await expect(mcpToolRegistry.execute('read_email', { account_id: 'a', action: 'list' }, API_KEY_CTX))
      .rejects.toThrow(/rate limit/);
    // Another user is unaffected.
    await mcpToolRegistry.execute('read_email', { account_id: 'a', action: 'list' }, { ...API_KEY_CTX, userId: 'user-2' });
    expect(mockMcpFetch).toHaveBeenCalledTimes(READ_EMAIL_RATE_LIMIT + 1);
  });
});
