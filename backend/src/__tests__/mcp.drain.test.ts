/** Real SDK/HTTP/core/registry coverage for the maintainer's A-019 drain contract. */
import express from 'express';
import type { Express } from 'express';
import type * as RateLimiterModule from '../middleware/rateLimiter';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Only external I/O and unrelated tool-registration side effects are isolated.
// The transport, core dispatcher, tool registry and drain registry remain real.
// Capture real limiter instances only to dispose their import-time cleanup timers.
jest.mock('../middleware/rateLimiter', () => {
  const actual = jest.requireActual<typeof RateLimiterModule>('../middleware/rateLimiter');
  return { ...actual, RateLimiter: jest.fn().mockImplementation(() => new actual.RateLimiter()) };
});
jest.mock('../mcp/server/apiTools', () => ({}));
jest.mock('../mcp/server/evaluationTools', () => ({}));
jest.mock('../mcp/server/workflowTools', () => ({}));
jest.mock('../mcp/server/landingWorkflowTools', () => ({}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: async () => {} }));
jest.mock('../services/funding/runFunding', () => ({
  currentRunFunding: () => ({}),
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: async () => null,
  attachPublishRevalidation: (_name: string, context: unknown) => context,
}));
jest.mock('../services/agentApiKeyService', () => ({
  agentApiKeyService: { validateKey: async () => ({
    keyId: 'drain-key', userId: 'drain-user', scopes: ['tools:read'], rateLimitPerMin: 100,
  }) },
}));
jest.mock('../mcp/oauth/oauthService', () => ({
  mcpOAuthService: { validateAccessToken: async () => null },
}));
jest.mock('../services/mcpUsageEventsService', () => ({
  classifyMcpClient: () => 'other',
  recordMcpConnectionAttempt: async () => {},
  recordMcpToolUse: async () => {},
  recordMcpFirstToolUse: async () => {},
}));

import { setupMcpServer } from '../mcp/server/mcpServer';
import { mcpToolRegistry } from '../mcp/server/registry';
import { InMemoryMcpSessionStore } from '../mcp/server/mcpSessionStore';
import type { McpSessionRecord } from '../mcp/server/mcpSessionStore';
import { cronJobRegistry } from '../utils/cronJobRegistry';
import type { CronDrainResult } from '../utils/cronJobRegistry';
import { disableCron } from '../utils/instanceState';
import { RateLimiter, rateLimiter } from '../middleware/rateLimiter';

// Capture before Jest's per-test clearMocks resets constructor bookkeeping.
const fixtureRateLimiters = jest.mocked(RateLimiter).mock.results.map(({ value }) => value as RateLimiter);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

const INTERNAL_TOKEN = 'drain-internal-fixture-token';
const TOOL = 'read_drain_probe';
const call = { jsonrpc: '2.0', id: 'drain-call', method: 'tools/call', params: { name: TOOL, arguments: {} } };
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

interface DrainObservation {
  promise: Promise<CronDrainResult>;
  settled: () => boolean;
}

function startDrain(): DrainObservation {
  let settled = false;
  const promise = cronJobRegistry.drain(5000, 5).then((result) => {
    settled = true;
    return result;
  });
  return { promise, settled: () => settled };
}

describe('MCP real drain lifecycle', () => {
  let app: Express;
  let listener: Server;
  let url: string;
  let store: InMemoryMcpSessionStore;
  let clients: Client[];
  let shutdown: () => Promise<void>;
  const originalToken = process.env.MCP_ACCESS_TOKEN;

  beforeEach(async () => {
    process.env.MCP_ACCESS_TOKEN = INTERNAL_TOKEN;
    clients = [];
    store = new InMemoryMcpSessionStore(60_000);
    app = express();
    setupMcpServer(app, store);
    // setupMcpServer exposes its lifecycle callback on the Express instance.
    shutdown = (app as Express & { mcpShutdown: () => Promise<void> }).mcpShutdown;
    listener = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback TCP listener');
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterEach(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await shutdown();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    expect(cronJobRegistry.size()).toBe(0);
    jest.restoreAllMocks();
    if (originalToken === undefined) delete process.env.MCP_ACCESS_TOKEN;
    else process.env.MCP_ACCESS_TOKEN = originalToken;
  });

  afterAll(() => {
    for (const limiter of fixtureRateLimiters) limiter.destroy();
    rateLimiter.destroy();
  });

  async function connect(token = INTERNAL_TOKEN) {
    const client = new Client({ name: 'drain-contract', version: '1' });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return { client, transport };
  }

  function post(sessionId?: string, token = INTERNAL_TOKEN, extraHeaders: Record<string, string> = {}) {
    return fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...extraHeaders,
      },
      body: JSON.stringify(call),
    });
  }

  function register(execute: () => Promise<unknown>) {
    mcpToolRegistry.register({
      name: TOOL, readOnly: true,
      definition: { name: TOOL, description: 'Bounded drain contract probe', inputSchema: { type: 'object' } },
      execute,
    });
  }

  it.each([false, true])('holds existing-session drain through actual tool execution (reject=%s)', async (reject) => {
    const entered = deferred<void>();
    const gate = deferred<void>();
    register(async () => { entered.resolve(); await gate.promise; return { completed: true }; });
    const { client } = await connect();
    const execution = client.callTool({ name: TOOL, arguments: {} });
    let drain: DrainObservation | undefined;
    try {
      await Promise.race([entered.promise, execution.then(() => { throw new Error('Tool never entered'); })]);
      drain = startDrain();
      await nextTurn();
      expect(drain.settled()).toBe(false);
      expect(cronJobRegistry.snapshot()).toMatchObject({ mcpHttpToolCall: 1, mcpToolCall: 1 });
      if (reject) gate.reject(new Error('bounded tool rejection'));
      else gate.resolve();
      expect(await execution).toMatchObject(reject ? { isError: true } : { content: expect.any(Array) });
      await expect(drain.promise).resolves.toMatchObject({ drained: true, stuckCount: 0 });
    } finally {
      gate.resolve();
      await Promise.allSettled([execution, ...(drain ? [drain.promise] : [])]);
    }
  });

  it.each(['success', 'tool-error', 'missing', 'lookup-error', 'wrong-principal'] as const)(
    'holds drain before deferred session lookup and releases on %s', async (outcome) => {
      const lookupEntered = deferred<void>();
      const lookup = deferred<McpSessionRecord | null>();
      const toolEntered = deferred<void>();
      const toolGate = deferred<void>();
      register(async () => { toolEntered.resolve(); await toolGate.promise; return { completed: true }; });
      await store.set({ sessionId: 'remote-drain', isInternal: outcome !== 'wrong-principal', agentUserId: 'other-user' });
      const record = await store.get('remote-drain');
      jest.spyOn(store, 'get').mockImplementationOnce(() => { lookupEntered.resolve(); return lookup.promise; });
      const execution = post('remote-drain');
      let drain: DrainObservation | undefined;
      try {
        await Promise.race([lookupEntered.promise, execution.then(() => { throw new Error('Lookup never entered'); })]);
        drain = startDrain();
        await nextTurn();
        expect(drain.settled()).toBe(false);
        expect(cronJobRegistry.snapshot()).toEqual({ mcpHttpToolCall: 1 });
        if (outcome === 'lookup-error') lookup.reject(new Error('bounded lookup rejection'));
        else lookup.resolve(outcome === 'missing' ? null : record);
        if (outcome === 'success' || outcome === 'tool-error') {
          await Promise.race([toolEntered.promise, execution.then(() => { throw new Error('Rehydrated tool never entered'); })]);
          expect(drain.settled()).toBe(false);
          expect(cronJobRegistry.snapshot()).toMatchObject({ mcpHttpToolCall: 1, mcpToolCall: 1 });
          if (outcome === 'tool-error') toolGate.reject(new Error('rehydrated tool rejection'));
          else toolGate.resolve();
        }
        const response = await execution;
        expect(response.status).toBe(outcome === 'success' || outcome === 'tool-error' ? 200 : 404);
        if (outcome === 'tool-error') expect(await response.json()).toMatchObject({ result: { isError: true } });
        await expect(drain.promise).resolves.toMatchObject({ drained: true, stuckCount: 0 });
      } finally {
        lookup.resolve(null);
        toolGate.resolve();
        await Promise.allSettled([execution, ...(drain ? [drain.promise] : [])]);
      }
    },
  );

  it('finishes an admitted turn through internal session siblings after disableCron, rejecting external bypasses', async () => {
    register(async () => ({ completed: true }));
    const { client, transport } = await connect();
    const external = await connect('aw_drain_external');
    await store.set({ sessionId: 'remote-internal', isInternal: true });
    const turn = deferred<void>();
    const trackedTurn = cronJobRegistry.track('admittedAgentTurn', turn.promise);
    disableCron();
    const drain = startDrain();
    try {
      // Initialization/recovery still works; draining rejects tool work, not sessions.
      const recovered = await connect();
      const externalRecovery = await connect('aw_drain_external');
      expect(await recovered.client.callTool({ name: TOOL, arguments: {} })).toMatchObject({ content: expect.any(Array) });
      expect(await client.callTool({ name: TOOL, arguments: {} })).toMatchObject({ content: expect.any(Array) });
      const rehydrated = await post('remote-internal');
      expect(rehydrated.status).toBe(200);
      expect(await rehydrated.json()).toMatchObject({
        result: { content: [{ type: 'text', text: expect.any(String) }] },
      });
      expect((await post('unknown-internal')).status).toBe(404);
      expect((await post()).status).toBe(404);
      for (const sessionId of [external.transport.sessionId, externalRecovery.transport.sessionId, transport.sessionId, 'remote-internal', undefined]) {
        const response = await post(sessionId, 'aw_drain_external', { 'x-mcp-is-internal': 'true' });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: call.id, error: { code: -32000 } });
      }
      const sse = await fetch(url, {
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, accept: 'text/event-stream', 'mcp-session-id': transport.sessionId! },
      });
      // The SDK may already own the one permitted standalone SSE stream (409).
      expect([200, 409]).toContain(sse.status);
      await sse.body?.cancel();
      await nextTurn();
      expect(drain.settled()).toBe(false);
      turn.resolve();
      await trackedTurn;
      await expect(drain.promise).resolves.toMatchObject({ drained: true, stuckCount: 0 });
    } finally {
      turn.resolve();
      await Promise.allSettled([trackedTurn, drain.promise]);
    }
  });
});
