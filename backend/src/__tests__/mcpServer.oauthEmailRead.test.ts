/**
 * POST /mcp HTTP-layer gate for opt-in-scope tools (read_email / email:read):
 * an OAuth token the user consented to email:read is let through; an OAuth
 * token without it, a legacy token (no grantedScopes) and an anonymous caller
 * are refused with 403 before any session or tool work. The consented scopes
 * also reach the session context the registry's second-line check reads.
 */
import express from 'express';
import request from 'supertest';

const mockValidateAccessToken = jest.fn();
const mockCreateMcpServer = jest.fn();

jest.mock('../utils/instanceState', () => ({ isCronEnabled: () => true }));
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({
  mcpOAuthService: {
    validateAccessToken: (...args: any[]) => mockValidateAccessToken(...args),
    getClient: jest.fn().mockResolvedValue({ clientName: 'Claude' }),
  },
}));
jest.mock('../services/mcpUsageEventsService', () => ({
  classifyMcpClient: () => 'claude',
  recordMcpConnectionAttempt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../mcp/server/anonymousTransport', () => ({
  anonymousUserIdForSession: () => 'anon_test',
  isAnonymousDiscoveryEnabled: () => true,
  // Admit the anonymous request at the auth layer so the opt-in-scope gate is what refuses it.
  isAnonymouslyPermitted: () => true,
}));
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation((options) => {
    const transport = {
      sessionId: 'sid-1',
      handleRequest: jest.fn(async (_req: any, res: any) => { if (!res.headersSent) res.status(200).json({ result: 'ok' }); }),
      close: jest.fn().mockResolvedValue(undefined),
      onclose: null,
    };
    if (options?.onsessioninitialized) setTimeout(() => options.onsessioninitialized(transport.sessionId), 0);
    return transport;
  }),
}));
jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  isInitializeRequest: (body: any) => body?.method === 'initialize',
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));
jest.mock('../mcp/server/mcpServerCore', () => ({
  createMcpServer: (...args: any[]) => {
    mockCreateMcpServer(...args);
    return { connect: jest.fn().mockResolvedValue(undefined) };
  },
}));
jest.mock('../mcp/server/registry', () => ({
  mcpToolRegistry: {
    getTool: (name: string) =>
      name === 'read_email' ? { readOnly: true, requiredScope: 'email:read' } : name === 'list_tasks' ? { readOnly: true } : undefined,
  },
}));

import { setupMcpServer } from '../mcp/server/mcpServer';

const readEmailCall = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_email', arguments: { account_id: 'a', action: 'list' } } };

function oauthRecord(grantedScopes?: string[]) {
  return {
    tokenHash: 'h', userId: 'user-1', clientId: 'client-1', scope: 'mcp:tools email:read', revoked: false,
    ...(grantedScopes && { grantedScopes }),
  };
}

let app: express.Express;
beforeEach(() => {
  jest.clearAllMocks();
  app = express();
  app.use(express.json());
  setupMcpServer(app);
});

it('lets an OAuth token granted email:read through the gate', async () => {
  mockValidateAccessToken.mockResolvedValue(oauthRecord(['mcp:tools', 'email:read']));
  const res = await request(app).post('/mcp').set('Authorization', 'Bearer oauth-token').send(readEmailCall);
  // Past the scope gate; with no session the server asks the client to reinitialize.
  expect(res.status).toBe(404);
});

it('refuses an OAuth token without email:read with 403', async () => {
  mockValidateAccessToken.mockResolvedValue(oauthRecord(['mcp:tools']));
  const res = await request(app).post('/mcp').set('Authorization', 'Bearer oauth-token').send(readEmailCall);
  expect(res.status).toBe(403);
  expect(res.body.error.code).toBe(-32003);
  expect(res.body.error.message).toBe(
    "Forbidden: Tool 'read_email' requires the 'email:read' scope: it is only available to API keys or OAuth sign-ins granted 'email:read'."
  );
});

it('treats a legacy OAuth token (no grantedScopes) as mcp:tools only, even if its scope string names email:read', async () => {
  mockValidateAccessToken.mockResolvedValue(oauthRecord());
  const res = await request(app).post('/mcp').set('Authorization', 'Bearer oauth-token').send(readEmailCall);
  expect(res.status).toBe(403);
});

it('refuses an anonymous caller with 403', async () => {
  const res = await request(app).post('/mcp').send(readEmailCall);
  expect(res.status).toBe(403);
  expect(res.body.error.message).toMatch(/email:read/);
});

it('does not gate ordinary tools for OAuth callers without email:read', async () => {
  mockValidateAccessToken.mockResolvedValue(oauthRecord(['mcp:tools']));
  const res = await request(app).post('/mcp').set('Authorization', 'Bearer oauth-token')
    .send({ ...readEmailCall, params: { name: 'list_tasks', arguments: {} } });
  expect(res.status).toBe(404);
});

it('carries the consented scopes into the session context', async () => {
  mockValidateAccessToken.mockResolvedValue(oauthRecord(['mcp:tools', 'email:read']));
  await request(app).post('/mcp').set('Authorization', 'Bearer oauth-token')
    .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  expect(mockCreateMcpServer).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ authMethod: 'oauth', agentUserId: 'user-1', oauthScopes: ['mcp:tools', 'email:read'] }),
  );
});
