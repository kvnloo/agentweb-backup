/**
 * Route-level wiring tests for the durable session store (ENG-114).
 *
 * These prove setupMcpServer's POST/DELETE handlers use the injected store
 * correctly:
 *  - initialize persists the session metadata to the store;
 *  - a POST for a session unknown locally but present in the store, from the
 *    SAME principal, rehydrates and serves (AC #1);
 *  - a POST for a session owned by a DIFFERENT principal is NOT rehydrated —
 *    it 404s (IDOR guard);
 *  - a genuine miss (empty store) still 404s (single-instance unchanged, AC #2);
 *  - DELETE evicts the session from the store (AC #3).
 *
 * The SDK transport and the rehydration helper are mocked so we assert the
 * branch logic in isolation; the rehydration MECHANISM is proven separately in
 * mcpSessionRehydration.test.ts.
 */

import express, { Express } from 'express';
import request from 'supertest';

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    server: { setRequestHandler: jest.fn(), connect: jest.fn().mockResolvedValue(undefined) },
  })),
}));
jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn().mockImplementation(() => ({
    setRequestHandler: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn().mockImplementation((options) => {
    const transport: any = {
      sessionId: 'test-session-id',
      handleRequest: jest.fn().mockImplementation(async (_req: any, res: any) => {
        if (!res.headersSent) res.status(200).json({ result: 'ok' });
      }),
      close: jest.fn().mockResolvedValue(undefined),
      onclose: null,
    };
    if (options?.onsessioninitialized) {
      setTimeout(() => options.onsessioninitialized(transport.sessionId), 0);
    }
    return transport;
  }),
}));
jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  isInitializeRequest: jest.fn().mockReturnValue(false),
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));
jest.mock('../mcp/server/registry', () => ({
  mcpToolRegistry: { getToolDefinitions: jest.fn().mockReturnValue([]), execute: jest.fn() },
}));
jest.mock('../mcp/server/apiTools', () => ({}));
jest.mock('../mcp/server/mcpServerCore', () => ({
  createMcpServer: jest.fn().mockImplementation(() => ({
    setRequestHandler: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
  })),
}));
// Mock the rehydration helper so we can assert WHEN it is invoked. It writes a
// response so supertest does not hang.
jest.mock('../mcp/server/mcpSessionRehydration', () => ({
  rehydrateAndServe: jest.fn().mockImplementation(async (_req: any, res: any) => {
    if (!res.headersSent) res.status(200).json({ rehydrated: true });
  }),
}));
jest.mock('../services/mcpUsageEventsService', () => ({
  classifyMcpClient: jest.fn().mockReturnValue('unknown'),
  recordMcpConnectionAttempt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/agentApiKeyService', () => ({
  agentApiKeyService: { validateKey: jest.fn() },
}));

import { setupMcpServer } from '../mcp/server/mcpServer';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { rehydrateAndServe } from '../mcp/server/mcpSessionRehydration';
import { agentApiKeyService } from '../services/agentApiKeyService';
import type { McpSessionStore, McpSessionRecord } from '../mcp/server/mcpSessionStore';

const INTERNAL_TOKEN = 'internal-mcp-token';

function makeSpyStore(overrides: Partial<Record<keyof McpSessionStore, jest.Mock>> = {}) {
  return {
    get: overrides.get || jest.fn().mockResolvedValue(null),
    set: overrides.set || jest.fn().mockResolvedValue(undefined),
    touch: overrides.touch || jest.fn().mockResolvedValue(undefined),
    delete: overrides.delete || jest.fn().mockResolvedValue(undefined),
  } as unknown as McpSessionStore & Record<string, jest.Mock>;
}

function record(overrides: Partial<McpSessionRecord> = {}): McpSessionRecord {
  return {
    sessionId: 'sess-A',
    agentUserId: 'userX',
    isInternal: false,
    createdAt: new Date().toISOString(),
    lastActivity: Date.now(),
    ttl: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function makeApp(store: McpSessionStore): Express {
  const app = express();
  app.use(express.json());
  setupMcpServer(app, store);
  return app;
}

describe('setupMcpServer durable session store wiring', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.MCP_HTTP_ENABLED = 'true';
    process.env.MCP_ACCESS_TOKEN = INTERNAL_TOKEN;
    (isInitializeRequest as unknown as jest.Mock).mockReturnValue(false);
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('persists session metadata to the store on initialize', async () => {
    const store = makeSpyStore();
    const app = makeApp(store);
    (isInitializeRequest as unknown as jest.Mock).mockReturnValue(true);

    await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    // onsessioninitialized fires on a 0ms timer inside the mocked transport.
    await new Promise((r) => setTimeout(r, 20));

    expect((store as any).set).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'test-session-id', isInternal: true }),
    );
  });

  it('rehydrates + serves a session that is unknown locally but present in the store (same principal)', async () => {
    const store = makeSpyStore({ get: jest.fn().mockResolvedValue(record({ isInternal: true })) });
    const app = makeApp(store);

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .set('mcp-session-id', 'sess-A')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

    expect(res.status).toBe(200);
    expect(res.body.rehydrated).toBe(true);
    expect(rehydrateAndServe as jest.Mock).toHaveBeenCalledTimes(1);
    expect((store as any).touch).toHaveBeenCalledWith('sess-A');
  });

  it('does NOT rehydrate another principal’s session — returns 404 (IDOR guard)', async () => {
    // Session belongs to external userX; caller authenticates as the internal
    // static token (a different principal) → must not be handed userX's session.
    const store = makeSpyStore({
      get: jest.fn().mockResolvedValue(record({ isInternal: false, agentUserId: 'userX' })),
    });
    const app = makeApp(store);

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .set('mcp-session-id', 'sess-A')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(-32001);
    expect(rehydrateAndServe as jest.Mock).not.toHaveBeenCalled();
  });

  it('rehydrates for a matching external user, and 404s for a mismatched one', async () => {
    delete process.env.MCP_ACCESS_TOKEN; // force the aw_ API-key path
    (agentApiKeyService.validateKey as jest.Mock).mockImplementation(async (token: string) => {
      if (token === 'aw_x') return { keyId: 'kx', userId: 'userX', rateLimitPerMin: 60 };
      if (token === 'aw_y') return { keyId: 'ky', userId: 'userY', rateLimitPerMin: 60 };
      return null;
    });
    const store = makeSpyStore({
      get: jest.fn().mockResolvedValue(record({ isInternal: false, agentUserId: 'userX' })),
    });
    const app = makeApp(store);

    const match = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer aw_x')
      .set('mcp-session-id', 'sess-A')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(match.status).toBe(200);
    expect(rehydrateAndServe as jest.Mock).toHaveBeenCalledTimes(1);

    (rehydrateAndServe as jest.Mock).mockClear();

    const mismatch = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer aw_y')
      .set('mcp-session-id', 'sess-A')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(mismatch.status).toBe(404);
    expect(rehydrateAndServe as jest.Mock).not.toHaveBeenCalled();
  });

  it('returns 404 on a genuine miss (empty store) — single-instance behavior unchanged', async () => {
    const store = makeSpyStore(); // get → null
    const app = makeApp(store);

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .set('mcp-session-id', 'ghost')
      .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(-32001);
    expect(rehydrateAndServe as jest.Mock).not.toHaveBeenCalled();
  });

  it('DELETE evicts an OWNED session from the store (global termination)', async () => {
    // Internal caller terminating an internal session it owns.
    const store = makeSpyStore({ get: jest.fn().mockResolvedValue(record({ isInternal: true })) });
    const app = makeApp(store);

    const res = await request(app)
      .delete('/mcp')
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .set('mcp-session-id', 'sess-A');

    expect(res.status).toBe(204);
    expect((store as any).delete).toHaveBeenCalledWith('sess-A');
  });

  it('DELETE does NOT evict another principal’s session — 204 without deleting (IDOR guard)', async () => {
    // Session belongs to external userX; caller is the internal static token
    // (a different principal) → must not be able to evict userX's session.
    const store = makeSpyStore({
      get: jest.fn().mockResolvedValue(record({ isInternal: false, agentUserId: 'userX' })),
    });
    const app = makeApp(store);

    const res = await request(app)
      .delete('/mcp')
      .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
      .set('mcp-session-id', 'sess-A');

    expect(res.status).toBe(204); // idempotent, no existence leak
    expect((store as any).delete).not.toHaveBeenCalled();
  });

  describe('ENG-984: anonymous discovery sessions across instances', () => {
    // Each unauthenticated request mints a fresh anon_ id, so an exact-match
    // ownership check can never reunite an anonymous caller with its session on
    // another instance. Anon-owned sessions rehydrate for any anonymous-permitted
    // request instead — the allowlist already confines those to discovery.
    it('rehydrates an anon-owned session for an unauthenticated discovery request', async () => {
      process.env.MCP_ANONYMOUS_DISCOVERY = 'true';
      const store = makeSpyStore({
        get: jest.fn().mockResolvedValue(
          record({ isInternal: false, agentUserId: 'anon_1111-2222' }),
        ),
      });
      const app = makeApp(store);

      const res = await request(app)
        .post('/mcp')
        .set('mcp-session-id', 'sess-A')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

      expect(res.status).toBe(200);
      expect(res.body.rehydrated).toBe(true);
      expect(rehydrateAndServe as jest.Mock).toHaveBeenCalledTimes(1);
      expect((store as any).touch).toHaveBeenCalledWith('sess-A');
    });

    it('does NOT hand an anonymous caller a real user’s session (IDOR guard holds)', async () => {
      process.env.MCP_ANONYMOUS_DISCOVERY = 'true';
      const store = makeSpyStore({
        get: jest.fn().mockResolvedValue(record({ isInternal: false, agentUserId: 'userX' })),
      });
      const app = makeApp(store);

      const res = await request(app)
        .post('/mcp')
        .set('mcp-session-id', 'sess-A')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

      expect(res.status).toBe(404);
      expect(rehydrateAndServe as jest.Mock).not.toHaveBeenCalled();
    });

    it('does NOT hand an authenticated caller an anon-owned session', async () => {
      process.env.MCP_ANONYMOUS_DISCOVERY = 'true';
      const store = makeSpyStore({
        get: jest.fn().mockResolvedValue(
          record({ isInternal: false, agentUserId: 'anon_1111-2222' }),
        ),
      });
      const app = makeApp(store);

      const res = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${INTERNAL_TOKEN}`)
        .set('mcp-session-id', 'sess-A')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

      expect(res.status).toBe(404);
      expect(rehydrateAndServe as jest.Mock).not.toHaveBeenCalled();
    });

    it('with the flag OFF, an unauthenticated request is 401d before rehydration', async () => {
      delete process.env.MCP_ANONYMOUS_DISCOVERY;
      const store = makeSpyStore({
        get: jest.fn().mockResolvedValue(
          record({ isInternal: false, agentUserId: 'anon_1111-2222' }),
        ),
      });
      const app = makeApp(store);

      const res = await request(app)
        .post('/mcp')
        .set('mcp-session-id', 'sess-A')
        .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

      expect(res.status).toBe(401);
      expect(rehydrateAndServe as jest.Mock).not.toHaveBeenCalled();
      expect((store as any).get).not.toHaveBeenCalled();
    });
  });
});
