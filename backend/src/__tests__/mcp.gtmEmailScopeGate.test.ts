/**
 * ENG-2840 (W2-4 follow-up): the scope gate for `send_gtm_status_report`, at the HTTP layer where it is enforced (mcpServer.ts), against the
 * REAL tool registry. The tool unit tests call the handler directly and the public tool inventory does not record scopes, so this is the test
 * that fails if the emailing tool ever becomes callable by a default key or an OAuth client.
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
jest.mock('../mcp/server/httpClient', () => ({ mcpFetch: jest.fn() }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: {}, accountMemoryDb: {}, orgMemoryDb: {} }));
jest.mock('../utils/embeddings', () => ({ embedText: jest.fn() }));

import '../mcp/server/memoryTools';
import '../mcp/server/gtmEmailTool';
import { setupMcpServer } from '../mcp/server/mcpServer';

const EMAIL_TOOL = 'send_gtm_status_report';
const callOf = (name: string, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } });

let seq = 0;
function appFor(scopes: string[] | undefined) {
  mockValidateKey.mockResolvedValue({ keyId: `gtm-gate-key-${++seq}-${Date.now()}`, userId: 'user-1', rateLimitPerMin: 600, ...(scopes ? { scopes } : {}) });
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
  it('is refused send_gtm_status_report with 403 naming the scope it lacks', async () => {
    const res = await send(appFor(['tools:read', 'tools:execute']), callOf(EMAIL_TOOL));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain(`lacks scope 'gtm:email' required for tool '${EMAIL_TOOL}'`);
  });

  it('is refused it hidden inside a batch of allowed calls, and the whole batch is refused', async () => {
    const res = await send(appFor(['tools:read', 'tools:execute']), [callOf('list_memories', 1), callOf('manage_gtm_plan', 2), callOf(EMAIL_TOOL, 3)]);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain(`tool '${EMAIL_TOOL}'`);
  });

  it('may still call the GTM plan tools that do not email', async () => {
    const app = appFor(['tools:read', 'tools:execute']);
    for (const tool of ['manage_gtm_plan', 'manage_gtm_items']) expect((await send(app, callOf(tool))).status).not.toBe(403);
  });

  it('a legacy key with no scopes array is a default key: refused the emailing tool', async () => {
    expect((await send(appFor(undefined), callOf(EMAIL_TOOL))).status).toBe(403);
  });
});

describe('a read-only key (tools:read)', () => {
  it('is refused the emailing tool, naming gtm:email (not tools:execute): the scope is the only way in', async () => {
    const res = await send(appFor(['tools:read']), callOf(EMAIL_TOOL));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("lacks scope 'gtm:email'");
  });
});

describe('a key that holds gtm:email', () => {
  it('may call the emailing tool, next to the default scopes', async () => {
    expect((await send(appFor(['tools:read', 'tools:execute', 'gtm:email']), callOf(EMAIL_TOOL))).status).not.toBe(403);
  });

  it('the scope alone is enough for this one tool (like memory:org), and it opens nothing else', async () => {
    const app = appFor(['gtm:email']);
    expect((await send(app, callOf(EMAIL_TOOL))).status).not.toBe(403);
    for (const tool of ['manage_gtm_plan', 'manage_gtm_items', 'save_org_memory', 'save_memory']) {
      expect((await send(app, callOf(tool))).status).toBe(403);
    }
  });

  it('does not unlock the other opt-in tools: org memory writes still need memory:org', async () => {
    const app = appFor(['tools:read', 'tools:execute', 'gtm:email']);
    for (const tool of ['save_org_memory', 'delete_org_memory']) {
      const res = await send(app, callOf(tool));
      expect(res.status).toBe(403);
      expect(res.body.error.message).toContain("lacks scope 'memory:org'");
    }
  });

  it('tools:execute does not imply it: a key with every other scope is refused', async () => {
    expect((await send(appFor(['tools:read', 'tools:execute', 'email:read', 'smartlead:read', 'smartlead:control', 'memory:org']), callOf(EMAIL_TOOL))).status).toBe(403);
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

  it('is refused the emailing tool with 403: it needs an aw_ key that holds gtm:email', async () => {
    const res = await send(oauthApp(), callOf(EMAIL_TOOL), 'oauth-token');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("needs an AgentWeb API key that holds the 'gtm:email' scope");
  });

  it('is refused it inside a batch', async () => {
    expect((await send(oauthApp(), [callOf('manage_gtm_plan', 1), callOf(EMAIL_TOOL, 2)], 'oauth-token')).status).toBe(403);
  });

  it('may still call the GTM plan tools that do not email', async () => {
    expect((await send(oauthApp(), callOf('manage_gtm_plan'), 'oauth-token')).status).not.toBe(403);
  });
});
