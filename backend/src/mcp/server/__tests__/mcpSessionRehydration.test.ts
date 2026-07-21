/**
 * Cross-instance rehydration mechanism test (ENG-114, AC #1).
 *
 * Proves the core durable-store promise WITHOUT mocking the MCP SDK transport:
 * given only the metadata a session left in the shared store when it was created
 * on "instance A", a fresh transport on "instance B" is primed and serves the
 * real request (tools/list AND tools/call) — no 404, no client reinitialize.
 *
 * `createMcpServer` is injected (the production factory is stubbed out so the
 * heavy tool registry is not loaded); everything else — the
 * WebStandardStreamableHTTPServerTransport, the priming handshake, the JSON-RPC
 * dispatch — is the real SDK.
 */

// Stub the production server factory import (never invoked; we inject our own).
jest.mock('../mcpServerCore', () => ({ createMcpServer: jest.fn() }));

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { rehydrateAndServe } from '../mcpSessionRehydration';
import type { McpSessionRecord } from '../mcpSessionStore';

const SID = 'session-created-on-instance-A';

function makeRecord(overrides: Partial<McpSessionRecord> = {}): McpSessionRecord {
  return {
    sessionId: SID,
    agentUserId: 'user-A',
    isInternal: false,
    createdAt: new Date().toISOString(),
    lastActivity: Date.now(),
    ttl: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

// A lightweight but REAL MCP server carrying two handlers so we can prove both a
// listing request and an actual tool invocation are served after rehydration.
function makeInjectedServerFactory() {
  return jest.fn(() => {
    const server = new Server(
      { name: 'test-server', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => ({
      content: [{ type: 'text', text: `PONG-from-B:${req.params.name}` }],
    }));
    return server;
  });
}

// Minimal Express-response stand-in (rehydrateAndServe only uses these members).
function makeRes() {
  return {
    statusCode: 0,
    headersSent: false,
    _headers: {} as Record<string, unknown>,
    body: undefined as string | undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(key: string, value: unknown) {
      this._headers[key.toLowerCase()] = value;
    },
    end(text?: string) {
      this.body = text;
      this.headersSent = true;
    },
  };
}

const req = { headers: { 'mcp-protocol-version': '2025-06-18' } } as any;

describe('rehydrateAndServe (cross-instance session resolution)', () => {
  it('serves a tools/list request for a session created on another instance (no 404)', async () => {
    const createServer = makeInjectedServerFactory();
    const res = makeRes();
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

    await rehydrateAndServe(req, res as any, SID, makeRecord(), body, createServer);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body!);
    expect(parsed.result.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'ping' })]),
    );
    // The session id from instance A is echoed back on the response.
    expect(res._headers['mcp-session-id']).toBe(SID);
  });

  it('serves an actual tools/call for the rehydrated session', async () => {
    const createServer = makeInjectedServerFactory();
    const res = makeRes();
    const body = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ping', arguments: {} },
    };

    await rehydrateAndServe(req, res as any, SID, makeRecord(), body, createServer);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body!);
    expect(parsed.result.content[0].text).toBe('PONG-from-B:ping');
  });

  it('reconstructs the server with the persisted user context (userId + isInternal)', async () => {
    const createServer = makeInjectedServerFactory();
    const res = makeRes();
    const body = { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} };

    await rehydrateAndServe(
      req,
      res as any,
      SID,
      makeRecord({ agentUserId: 'user-A', isInternal: false }),
      body,
      createServer,
    );

    expect(createServer).toHaveBeenCalledWith({
      agentUserId: 'user-A',
      sessionId: SID,
      isInternal: false,
    });
  });

  it('propagates internal-client context for a backend-to-backend session', async () => {
    const createServer = makeInjectedServerFactory();
    const res = makeRes();
    const body = { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} };

    await rehydrateAndServe(
      req,
      res as any,
      SID,
      makeRecord({ agentUserId: undefined, isInternal: true }),
      body,
      createServer,
    );

    expect(createServer).toHaveBeenCalledWith({
      agentUserId: undefined,
      sessionId: SID,
      isInternal: true,
    });
    expect(res.statusCode).toBe(200);
  });

  it('propagates errors instead of silently swallowing them (fail loud)', async () => {
    const createServer = jest.fn(() => {
      throw new Error('server construction failed');
    });
    const res = makeRes();
    const body = { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} };

    await expect(
      rehydrateAndServe(req, res as any, SID, makeRecord(), body, createServer as any),
    ).rejects.toThrow('server construction failed');
  });
});
