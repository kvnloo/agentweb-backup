/**
 * ENG-2840 wave 2 (W2-2): a JSON-RPC batch is one HTTP request but N calls. The per-key and per-OAuth-user limiter counted requests, so a
 * batch of 100 tool calls cost one count. The other N-1 members are now charged, and a batch that does not fit in what is left is refused
 * whole (429), before any member runs.
 *
 * The members are charged only when the request is about to be SERVED: a batch answered 404 (its session expired), 403 (a scope refusal)
 * or 503 (draining) costs only its own request. Charged earlier, a client whose session expired got a 404, reconnected, and was refused for
 * the minute the stale batch had used (found by Opslane on the first W2-2 head).
 *
 * How it is observed: the transport is a stub that answers 200 `{ result: 'ok' }`, so an admitted request is 200 and a limited one is 429.
 * A key's allowance counts EVERY request it makes, `initialize` included.
 */
import express from 'express';
import request from 'supertest';

const mockIsCronEnabled = jest.fn(() => true);
const mockValidateKey = jest.fn();
const mockValidateOAuth = jest.fn();
let sessionSeq = 0;

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
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation((options: any) => {
    const sessionId = `batch-session-${++sessionSeq}`;
    const transport: any = {
      sessionId,
      handleRequest: jest.fn().mockImplementation(async (_req: any, res: any) => { if (!res.headersSent) res.status(200).json({ result: 'ok' }); }),
      close: jest.fn().mockResolvedValue(undefined),
      onclose: null,
    };
    // The real transport tells the server its session id once the initialize request is handled.
    if (options?.onsessioninitialized) setTimeout(() => options.onsessioninitialized(sessionId), 0);
    return transport;
  }),
}));
jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  isInitializeRequest: jest.fn((body: any) => body?.method === 'initialize'),
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));
const mockRehydrateAndServe = jest.fn(async (_req: any, res: any) => { res.status(200).json({ result: 'rehydrated' }); });
jest.mock('../mcp/server/mcpSessionRehydration', () => ({ rehydrateAndServe: (...a: any[]) => (mockRehydrateAndServe as any)(...a) }));
jest.mock('../mcp/server/apiTools', () => ({}));
jest.mock('../mcp/server/mcpServerCore', () => ({ createMcpServer: jest.fn().mockReturnValue({ connect: jest.fn(), close: jest.fn() }) }));

import { chargeBatchMembers, setupMcpServer } from '../mcp/server/mcpServer';

const init = (id = 1) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
const call = (id: number) => ({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'test_tool', arguments: {} }, id });
const batch = (n: number) => Array.from({ length: n }, (_, i) => call(i + 1));
let keySeq = 0;

function appWith(key: { rateLimitPerMin: number; scopes?: string[] } | null, sessionStore?: any) {
  if (key) mockValidateKey.mockResolvedValue({ keyId: `batch-key-${++keySeq}-${Date.now()}`, userId: 'user-1', rateLimitPerMin: key.rateLimitPerMin, ...(key.scopes ? { scopes: key.scopes } : {}) });
  const app = express();
  app.use(express.json());
  process.env.MCP_HTTP_ENABLED = 'true';
  delete process.env.MCP_ACCESS_TOKEN;
  setupMcpServer(app, sessionStore);
  return app;
}
const post = (app: express.Express, body: unknown, opts: { token?: string; session?: string } = {}) => {
  let req = request(app).post('/mcp').set('Authorization', `Bearer ${opts.token ?? 'aw_test'}`);
  if (opts.session) req = req.set('Mcp-Session-Id', opts.session);
  return req.send(body as any);
};
/** Open a session (this is one request on the key's allowance) and return its id. */
async function open(app: express.Express, token?: string): Promise<string> {
  const res = await post(app, init(), { token });
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 5)); // the server records the session when the transport reports it
  return `batch-session-${sessionSeq}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsCronEnabled.mockReturnValue(true);
});

describe('an aw_ key: the limiter counts the members of a batch that is served', () => {
  it('a batch of 3 costs 3: with 6 a minute (initialize took 1), the next batch of 3 is refused whole, then one single call still fits', async () => {
    const app = appWith({ rateLimitPerMin: 6 });
    const session = await open(app); // 1 used
    expect((await post(app, batch(3), { session })).status).toBe(200); // 1 + 3 = 4 used
    const refused = await post(app, batch(3), { session }); // its own request makes 5; it needs 2 more and 1 is left
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'Rate limit exceeded', retryAfterMs: expect.any(Number) });
    expect((await post(app, call(1), { session })).status).toBe(200); // the 6th
    expect((await post(app, call(2), { session })).status).toBe(429);
  });

  it('a batch larger than everything that is left is refused at once', async () => {
    const app = appWith({ rateLimitPerMin: 5 });
    const session = await open(app);
    expect((await post(app, batch(6), { session })).status).toBe(429);
  });

  it('a batch that exactly fits is admitted and is the rest of the minute\'s allowance', async () => {
    const app = appWith({ rateLimitPerMin: 10 });
    const session = await open(app); // 1
    expect((await post(app, batch(9), { session })).status).toBe(200); // 1 + 9 = 10
    expect((await post(app, call(1), { session })).status).toBe(429);
  });

  it('single calls are counted exactly as before: 3 a minute allows initialize and two calls, and refuses the next', async () => {
    const app = appWith({ rateLimitPerMin: 3 });
    const session = await open(app);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(app, call(i + 1), { session })).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('a batch of one is a single call', async () => {
    const app = appWith({ rateLimitPerMin: 3 });
    const session = await open(app);
    expect((await post(app, batch(1), { session })).status).toBe(200);
    expect((await post(app, batch(1), { session })).status).toBe(200);
    expect((await post(app, batch(1), { session })).status).toBe(429);
  });

  it('a huge batch cannot consume more than the key has: it is refused, not looped, and costs only its own request', async () => {
    const app = appWith({ rateLimitPerMin: 60 });
    const session = await open(app);
    expect((await post(app, batch(500), { session })).status).toBe(429);
    expect((await post(app, call(1), { session })).status).toBe(200);
  });
});

describe('a batch that is NOT served costs only its own request (Opslane, first W2-2 head)', () => {
  it('a batch on an expired session is answered 404 and a client that reconnects is not refused', async () => {
    const app = appWith({ rateLimitPerMin: 5 });
    const stale = await post(app, batch(3), { session: 'a-session-this-server-does-not-have' });
    expect(stale.status).toBe(404); // 1 used, not 3
    const session = await open(app); // 2 used
    expect((await post(app, batch(3), { session })).status).toBe(200); // 2 + 3 = 5
    expect((await post(app, call(1), { session })).status).toBe(429);
  });

  it('with only 3 a minute, the reconnect after a stale batch still gets through (it was 429 when the batch was charged first)', async () => {
    const app = appWith({ rateLimitPerMin: 3 });
    expect((await post(app, batch(3), { session: 'gone' })).status).toBe(404);
    expect((await post(app, init())).status).toBe(200);
  });

  it('a batch refused for its scope (403) costs only its own request', async () => {
    const app = appWith({ rateLimitPerMin: 3, scopes: ['tools:read'] });
    expect((await post(app, batch(3), { session: 'any' })).status).toBe(403); // a read-only key may not call a tool that is not read-only (unknown tools are writes)
    expect((await post(app, init())).status).toBe(200);
  });

  it('a batch refused while the instance drains (503) costs only its own request', async () => {
    const app = appWith({ rateLimitPerMin: 3 });
    mockIsCronEnabled.mockReturnValue(false);
    expect((await post(app, batch(3), { session: 'any' })).status).toBe(503);
    mockIsCronEnabled.mockReturnValue(true);
    expect((await post(app, init())).status).toBe(200);
  });

  it('a request with no session that is not an initialize is answered 404 and costs one', async () => {
    const app = appWith({ rateLimitPerMin: 3 });
    expect((await post(app, batch(3))).status).toBe(404);
    expect((await post(app, init())).status).toBe(200);
  });
});

describe('a session that lives on ANOTHER server instance (rehydrated from the shared store): a batch is charged there too', () => {
  const sharedStore = () => ({
    get: async (id: string) => (id === 'on-another-instance' ? { sessionId: id, agentUserId: 'user-1', isInternal: false } : null),
    set: async () => {}, touch: async () => {}, delete: async () => {},
  });

  it('a batch that fits is served from the rehydrated session; one that does not fit is refused whole and never reaches it', async () => {
    const app = appWith({ rateLimitPerMin: 5 }, sharedStore());
    expect((await post(app, batch(3), { session: 'on-another-instance' })).status).toBe(200); // 1 + 2 = 3 used
    expect(mockRehydrateAndServe).toHaveBeenCalledTimes(1);
    const refused = await post(app, batch(3), { session: 'on-another-instance' }); // its own request makes 4; it needs 2 more and 1 is left
    expect(refused.status).toBe(429);
    expect(mockRehydrateAndServe).toHaveBeenCalledTimes(1);
  });

  it('a session the shared store does not have is a 404 that costs only its own request', async () => {
    const app = appWith({ rateLimitPerMin: 3 }, sharedStore());
    expect((await post(app, batch(3), { session: 'nobody-has-this' })).status).toBe(404);
    expect((await post(app, init())).status).toBe(200);
    expect(mockRehydrateAndServe).not.toHaveBeenCalled();
  });
});

describe('a signed-in OAuth client: the same, at 60 a minute per user', () => {
  const oauthApp = () => {
    mockValidateKey.mockResolvedValue(null);
    mockValidateOAuth.mockResolvedValue({ userId: `oauth-user-${++keySeq}-${Date.now()}`, clientId: 'client-1' });
    return appWith(null);
  };

  it('initialize, then a batch of 50 (51 used) and a batch of 11 (needs 10 more, 8 left) is refused whole', async () => {
    const app = oauthApp();
    const session = await open(app, 'oauth-token');
    expect((await post(app, batch(50), { session, token: 'oauth-token' })).status).toBe(200);
    expect((await post(app, batch(11), { session, token: 'oauth-token' })).status).toBe(429);
  });

  it('a batch that uses the whole minute is admitted and the next call is refused', async () => {
    const app = oauthApp();
    const session = await open(app, 'oauth-token');
    expect((await post(app, batch(59), { session, token: 'oauth-token' })).status).toBe(200); // 1 + 59 = 60
    expect((await post(app, call(1), { session, token: 'oauth-token' })).status).toBe(429);
  });

  it('a batch of 61 is refused whole, and a stale batch costs only its own request', async () => {
    const app = oauthApp();
    expect((await post(app, batch(61), { session: 'gone', token: 'oauth-token' })).status).toBe(404);
    const session = await open(app, 'oauth-token');
    expect((await post(app, batch(61), { session, token: 'oauth-token' })).status).toBe(429);
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

  it('fails closed when what is left is not a number (a key stored with a non-numeric rate): the batch is refused, not looped', () => {
    for (const remaining of [NaN, undefined as any, 'many' as any]) {
      expect(chargeBatchMembers('unit-d', 5, { allowed: true, remaining, resetInMs: 1 }, batch(2000)).allowed).toBe(false);
    }
  });
});
