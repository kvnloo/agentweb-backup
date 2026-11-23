/**
 * ENG-2840 wave 2 (W2-2): a JSON-RPC batch is one HTTP request but N calls. The per-key and per-OAuth-user limiter counted requests, so a
 * batch of 100 tool calls cost one count. The other N-1 members are now charged, and a batch that does not fit in what is left is refused
 * whole (429), before any member runs.
 *
 * How the tests tell a limited request from an admitted one without running tools: the instance is set to "draining", in which an admitted
 * request that carries a tools/call is answered 503 by the handler (A-019), while a limited one never gets that far and is answered 429.
 */
import express from 'express';
import request from 'supertest';

const mockIsCronEnabled = jest.fn(() => false);
const mockValidateKey = jest.fn();
const mockValidateOAuth = jest.fn();

jest.mock('../utils/instanceState', () => ({ isCronEnabled: () => mockIsCronEnabled() }));
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
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({ StreamableHTTPServerTransport: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  isInitializeRequest: jest.fn().mockReturnValue(false),
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));
jest.mock('../mcp/server/apiTools', () => ({}));
jest.mock('../mcp/server/mcpServerCore', () => ({ createMcpServer: jest.fn() }));

import { chargeBatchMembers, setupMcpServer } from '../mcp/server/mcpServer';

const call = (id: number) => ({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'test_tool', arguments: {} }, id });
const batch = (n: number) => Array.from({ length: n }, (_, i) => call(i + 1));
let keySeq = 0;
const freshKey = (rateLimitPerMin: number) => {
  const keyId = `batch-key-${++keySeq}-${Date.now()}`;
  mockValidateKey.mockResolvedValue({ keyId, userId: 'user-1', rateLimitPerMin });
  return keyId;
};

function appWithMcp() {
  const app = express();
  app.use(express.json());
  process.env.MCP_HTTP_ENABLED = 'true';
  delete process.env.MCP_ACCESS_TOKEN;
  setupMcpServer(app);
  return app;
}

const post = (app: express.Express, body: unknown, token = 'aw_test') => request(app).post('/mcp').set('Authorization', `Bearer ${token}`).send(body as any);
/** 503 = admitted by the limiter (the draining handler answered); 429 = stopped by it. */
const admitted = (status: number) => status === 503;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsCronEnabled.mockReturnValue(false);
});

describe('an aw_ key: the limiter counts the members of a batch', () => {
  it('a batch of 3 costs 3: with 5 a minute, the next batch of 3 is refused whole, then the last two single calls fit', async () => {
    freshKey(5);
    const app = appWithMcp();
    expect(admitted((await post(app, batch(3))).status)).toBe(true);
    const refused = await post(app, batch(3));
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'Rate limit exceeded', retryAfterMs: expect.any(Number) });
    // The refused batch still cost its own request (1): 3 + 1 = 4 used, so exactly one single call is left.
    expect(admitted((await post(app, call(1))).status)).toBe(true);
    expect((await post(app, call(2))).status).toBe(429);
  });

  it('a batch larger than everything that is left is refused at once', async () => {
    freshKey(5);
    const app = appWithMcp();
    expect((await post(app, batch(6))).status).toBe(429);
  });

  it('a batch that exactly fits is admitted, and is the whole minute\'s allowance', async () => {
    freshKey(10);
    const app = appWithMcp();
    expect(admitted((await post(app, batch(10))).status)).toBe(true);
    expect((await post(app, call(1))).status).toBe(429);
  });

  it('single calls are counted exactly as before: 3 a minute allows 3 and refuses the 4th', async () => {
    freshKey(3);
    const app = appWithMcp();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(app, call(i + 1))).status);
    expect(statuses).toEqual([503, 503, 503, 429]);
  });

  it('a batch of one is a single call', async () => {
    freshKey(2);
    const app = appWithMcp();
    expect(admitted((await post(app, batch(1))).status)).toBe(true);
    expect(admitted((await post(app, batch(1))).status)).toBe(true);
    expect((await post(app, batch(1))).status).toBe(429);
  });

  it('a huge batch cannot be used to consume more than the key has: it is refused, not looped', async () => {
    freshKey(60);
    const app = appWithMcp();
    expect((await post(app, batch(500))).status).toBe(429);
    // A different, small request still gets its own count afterwards (the refused batch cost 1).
    expect(admitted((await post(app, call(1))).status)).toBe(true);
  });
});

describe('a signed-in OAuth client: the same, at 60 a minute per user', () => {
  const oauthUser = () => {
    const userId = `oauth-user-${++keySeq}-${Date.now()}`;
    mockValidateOAuth.mockResolvedValue({ userId, clientId: 'client-1' });
    mockValidateKey.mockResolvedValue(null);
    return userId;
  };

  it('a batch of 50 then a batch of 11 (61 in a minute) is refused; a batch of 10 would have fit', async () => {
    oauthUser();
    const app = appWithMcp();
    expect(admitted((await post(app, batch(50), 'oauth-token')).status)).toBe(true);
    expect((await post(app, batch(11), 'oauth-token')).status).toBe(429);
  });

  it('a batch of 60 uses the whole minute and the next call is refused', async () => {
    oauthUser();
    const app = appWithMcp();
    expect(admitted((await post(app, batch(60), 'oauth-token')).status)).toBe(true);
    expect((await post(app, call(1), 'oauth-token')).status).toBe(429);
  });

  it('a batch of 61 is refused whole', async () => {
    oauthUser();
    const app = appWithMcp();
    expect((await post(app, batch(61), 'oauth-token')).status).toBe(429);
  });
});

describe('chargeBatchMembers', () => {
  const allowed = (remaining: number) => ({ allowed: true, remaining, resetInMs: 1000 });

  it('leaves a single request, a refused request and a non-array body exactly as the limiter answered', () => {
    const first = allowed(4);
    expect(chargeBatchMembers('unit-a', 5, first, { jsonrpc: '2.0' })).toBe(first);
    expect(chargeBatchMembers('unit-a', 5, first, [])).toBe(first);
    expect(chargeBatchMembers('unit-a', 5, first, [call(1)])).toBe(first);
    const blocked = { allowed: false, remaining: 0, resetInMs: 500 };
    expect(chargeBatchMembers('unit-a', 5, blocked, batch(9))).toBe(blocked);
    expect(chargeBatchMembers('unit-a', 5, first, undefined)).toBe(first);
    expect(chargeBatchMembers('unit-a', 5, first, 'text')).toBe(first);
  });

  it('refuses a batch that needs more than what is left (3 more members, 2 left) and says how long to wait', () => {
    expect(chargeBatchMembers('unit-b', 5, allowed(2), batch(4))).toEqual({ allowed: false, remaining: 2, resetInMs: 1000 });
  });

  it('admits a batch that fits (3 more members, 3 left) and reports what is left after charging them', () => {
    const result = chargeBatchMembers('unit-c', 5, allowed(3), batch(4));
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5 - 3);
  });
});
