/**
 * ENG-2840 wave 2 (W2-2): the scope gate for the memory tools, at the HTTP layer where it is enforced (mcpServer.ts), against the REAL
 * tool registry. The public tool inventory snapshot records neither the scope nor `apiKeyOnly`, and the two-tenant harness does not run
 * this layer, so this is the test that fails if the org write tools ever become callable by a default key or an OAuth client.
 *
 * A request that passes the gate is not answered 403 (it goes on to the transport, which this test does not exercise); a refused one is.
 */
import express from 'express';
import request from 'supertest';

const mockValidateKey = jest.fn();
const mockValidateOAuth = jest.fn();

jest.mock('../utils/instanceState', () => ({ isCronEnabled: () => true }));
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: (...a: any[]) => mockValidateKey(...a) } }));
jest.mock('../mcp/oauth/oauthService', () => ({
  mcpOAuthService: {
    validateAccessToken: (...a: any[]) => mockValidateOAuth(...a),
    getClient: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({ server: { setRequestHandler: jest.fn(), connect: jest.fn(), close: jest.fn() } })),
}));
jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({ Server: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation(() => ({
    sessionId: 'gate-session',
    handleRequest: jest.fn().mockImplementation(async (_req: any, res: any) => { if (!res.headersSent) res.status(200).json({ result: 'ok' }); }),
    close: jest.fn().mockResolvedValue(undefined),
    onclose: null,
  })),
}));
jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  isInitializeRequest: jest.fn().mockReturnValue(true),
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));
jest.mock('../mcp/server/apiTools', () => ({}));
jest.mock('../mcp/server/mcpServerCore', () => ({ createMcpServer: jest.fn().mockReturnValue({ connect: jest.fn(), close: jest.fn() }) }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: {}, accountMemoryDb: {}, orgMemoryDb: {} }));
jest.mock('../utils/embeddings', () => ({ embedText: jest.fn() }));

import '../mcp/server/memoryTools';
import { setupMcpServer } from '../mcp/server/mcpServer';

const ORG_WRITE = ['save_org_memory', 'delete_org_memory'];
const USER_TOOLS = ['save_memory', 'delete_memory', 'list_memories'];
const callOf = (name: string, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

let seq = 0;
function appFor(scopes: string[] | undefined) {
  mockValidateKey.mockResolvedValue({ keyId: `gate-key-${++seq}-${Date.now()}`, userId: 'user-1', rateLimitPerMin: 600, ...(scopes ? { scopes } : {}) });
  const app = express();
  app.use(express.json());
  process.env.MCP_HTTP_ENABLED = 'true';
  delete process.env.MCP_ACCESS_TOKEN;
  setupMcpServer(app);
  return app;
}
const send = (app: express.Express, body: unknown, token = 'aw_test') => request(app).post('/mcp').set('Authorization', `Bearer ${token}`).send(body as any);

beforeEach(() => jest.clearAllMocks());

describe('an aw_ key with the default scopes (tools:read, tools:execute)', () => {
  it.each(ORG_WRITE)('is refused %s with 403 naming the scope it lacks', async (tool) => {
    const res = await send(appFor(['tools:read', 'tools:execute']), callOf(tool));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain(`lacks scope 'memory:org' required for tool '${tool}'`);
  });

  it('is refused an org write tool hidden inside a batch of allowed calls, and the whole batch is refused', async () => {
    const res = await send(appFor(['tools:read', 'tools:execute']), [callOf('list_memories', 1), callOf('save_memory', 2), callOf('save_org_memory', 3)]);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("tool 'save_org_memory'");
  });

  it.each(USER_TOOLS)('may call %s', async (tool) => {
    expect((await send(appFor(['tools:read', 'tools:execute']), callOf(tool))).status).not.toBe(403);
  });

  it('a legacy key with no scopes array is a default key: refused the org tools, allowed the user tools', async () => {
    expect((await send(appFor(undefined), callOf('save_org_memory'))).status).toBe(403);
    expect((await send(appFor(undefined), callOf('save_memory'))).status).not.toBe(403);
  });
});

describe('a read-only key (tools:read)', () => {
  it('may list but not save or delete, user or org', async () => {
    const app = appFor(['tools:read']);
    expect((await send(app, callOf('list_memories'))).status).not.toBe(403);
    for (const tool of ['save_memory', 'delete_memory']) {
      const res = await send(app, callOf(tool));
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain("lacks scope 'tools:execute'");
    }
    expect((await send(app, callOf('save_org_memory'))).status).toBe(403);
  });
});

describe('a key that holds memory:org', () => {
  it('may call the org write tools', async () => {
    const app = appFor(['tools:read', 'tools:execute', 'memory:org']);
    for (const tool of [...ORG_WRITE, ...USER_TOOLS]) expect((await send(app, callOf(tool))).status).not.toBe(403);
  });

  it('the scope alone is not a general pass: with only memory:org the user tools still need their own scopes', async () => {
    const app = appFor(['memory:org']);
    for (const tool of ORG_WRITE) expect((await send(app, callOf(tool))).status).not.toBe(403);
    for (const tool of ['save_memory', 'delete_memory']) expect((await send(app, callOf(tool))).status).toBe(403);
  });

  it('tools:execute does not imply it: a key with every scope except memory:org is refused', async () => {
    expect((await send(appFor(['tools:read', 'tools:execute', 'email:read', 'smartlead:read', 'smartlead:control']), callOf('save_org_memory'))).status).toBe(403);
  });
});

describe('a signed-in OAuth client', () => {
  const oauthApp = () => {
    mockValidateKey.mockResolvedValue(null);
    mockValidateOAuth.mockResolvedValue({ userId: `oauth-user-${++seq}-${Date.now()}`, clientId: 'client-1' });
    const app = express();
    app.use(express.json());
    process.env.MCP_HTTP_ENABLED = 'true';
    delete process.env.MCP_ACCESS_TOKEN;
    setupMcpServer(app);
    return app;
  };

  it.each(ORG_WRITE)('is refused %s with 403: it needs an aw_ key that holds memory:org', async (tool) => {
    const res = await send(oauthApp(), callOf(tool), 'oauth-token');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("needs an AgentWeb API key that holds the 'memory:org' scope");
  });

  it('is refused an org write tool inside a batch', async () => {
    expect((await send(oauthApp(), [callOf('list_memories', 1), callOf('delete_org_memory', 2)], 'oauth-token')).status).toBe(403);
  });

  it.each(USER_TOOLS)('may call %s', async (tool) => {
    expect((await send(oauthApp(), callOf(tool), 'oauth-token')).status).not.toBe(403);
  });
});

describe('a tool name that is not text (found in review: the request used to hang)', () => {
  const hostileCall = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: { toString: 'x' }, arguments: {} } };

  it('is answered at once: refused 403 for a read-only key (an unknown tool is a write), passed on for a key that may write', async () => {
    expect((await send(appFor(['tools:read']), hostileCall)).status).toBe(403);
    expect((await send(appFor(['tools:read', 'tools:execute']), hostileCall)).status).toBe(200);
  });

  it('is answered at once for an OAuth client too', async () => {
    mockValidateKey.mockResolvedValue(null);
    mockValidateOAuth.mockResolvedValue({ userId: `oauth-user-${++seq}-${Date.now()}`, clientId: 'client-1' });
    const app = express();
    app.use(express.json());
    process.env.MCP_HTTP_ENABLED = 'true';
    delete process.env.MCP_ACCESS_TOKEN;
    setupMcpServer(app);
    expect((await send(app, hostileCall, 'oauth-token')).status).not.toBe(403);
  });
});
