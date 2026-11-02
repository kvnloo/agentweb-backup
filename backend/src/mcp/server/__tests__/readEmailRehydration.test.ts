/**
 * A rehydrated (cross-instance) api_key session must still reach read_email.
 *
 * The session record carries only userId + isInternal, so rehydrateAndServe has
 * to take the auth method from the current, re-authenticated request. Without
 * it the registry sees an external caller with no authMethod and refuses the
 * opt-in-scope tool. The injected server factory builds the tool context the
 * same way mcpServerCore does (authMethod/apiKeyId from the session context).
 */
const mockMcpFetch = jest.fn();
jest.mock('../httpClient', () => ({ mcpFetch: (...args: any[]) => mockMcpFetch(...args) }));
jest.mock('../mcpServerCore', () => ({ createMcpServer: jest.fn() }));
jest.mock('../../../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../services/funding/runFunding', () => ({
  currentRunFunding: () => ({ source: 'test' }),
  resolveRunFunding: jest.fn(),
  withRunFunding: (_f: any, fn: () => any) => fn(),
}));

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { rehydrateAndServe } from '../mcpSessionRehydration';
import { mcpToolRegistry } from '../registry';
import { resetReadEmailRateLimit } from '../readEmailTool';
import type { McpSessionContext } from '../mcpServerCore';
import type { McpSessionRecord } from '../mcpSessionStore';

const SID = 'sid-from-instance-A';
const record: McpSessionRecord = {
  sessionId: SID,
  agentUserId: 'user-1',
  isInternal: false,
  createdAt: new Date().toISOString(),
  lastActivity: Date.now(),
  ttl: Math.floor(Date.now() / 1000) + 3600,
};

function factory(seen: McpSessionContext[]) {
  return (sc: McpSessionContext) => {
    seen.push(sc);
    const server = new Server({ name: 't', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      try {
        return await mcpToolRegistry.execute(r.params.name, r.params.arguments ?? {}, {
          userId: sc.agentUserId,
          agentUserId: sc.agentUserId,
          isInternal: sc.isInternal,
          authMethod: sc.authMethod,
          apiKeyId: sc.apiKeyId,
          externalMcp: sc.isInternal !== true,
        });
      } catch (e: any) {
        return { isError: true, content: [{ type: 'text', text: e.message }] };
      }
    });
    return server;
  };
}

function makeRes() {
  return {
    statusCode: 0, headersSent: false, body: '' as string,
    status(c: number) { this.statusCode = c; return this; },
    setHeader() {},
    end(t?: string) { this.body = t ?? ''; this.headersSent = true; },
  };
}

const callBody = {
  jsonrpc: '2.0', id: 7, method: 'tools/call',
  params: { name: 'read_email', arguments: { account_id: 'acct-1', action: 'list' } },
};

beforeEach(() => {
  jest.clearAllMocks();
  resetReadEmailRateLimit();
  jest.spyOn(console, 'info').mockImplementation(() => {});
  mockMcpFetch.mockResolvedValue({ emails: [], count: 0 });
});

it('rehydrated api_key session can call read_email (auth method from the current request)', async () => {
  const seen: McpSessionContext[] = [];
  const req = {
    headers: { 'mcp-protocol-version': '2025-06-18' },
    _mcpAuthMethod: 'api_key',
    _mcpApiKeyId: 'key-123',
  } as any;
  const res = makeRes();

  await rehydrateAndServe(req, res as any, SID, record, callBody, factory(seen) as any);

  expect(seen[0]).toMatchObject({ agentUserId: 'user-1', authMethod: 'api_key', apiKeyId: 'key-123' });
  const parsed = JSON.parse(res.body);
  expect(parsed.result.isError).toBeFalsy();
  expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
    path: '/api/emma/email',
    body: expect.objectContaining({ account_id: 'acct-1', action: 'list', own_mailbox_only: true }),
  }));
});

it('rehydrated OAuth session can call read_email (OAuth parity)', async () => {
  const req = { headers: { 'mcp-protocol-version': '2025-06-18' }, _mcpAuthMethod: 'oauth' } as any;
  const res = makeRes();

  await rehydrateAndServe(req, res as any, SID, record, callBody, factory([]) as any);

  const parsed = JSON.parse(res.body);
  expect(parsed.result.isError).toBeFalsy();
  expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
    body: expect.objectContaining({ own_mailbox_only: true }),
  }));
});
