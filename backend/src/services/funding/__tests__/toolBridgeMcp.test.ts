/**
 * ENG-2109 (B2): the tool bridge's MCP endpoint, exercised with a real MCP client over
 * real HTTP against the real router. Only the bridge's tool resolution and execution
 * are faked.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server as HttpServer } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { ToolBridge, type BridgeExecuteOutcome, type BridgeTool, type ToolBridgeDeps } from '../toolBridge';
import { ToolBridgeMcpAdapter, HARNESS_TOOL_USE_ID_META_KEY } from '../toolBridgeMcp';

import { createToolBridgeRouter, isLocalOnlyRequest } from '../../../routes/toolBridge';

const RUN = { runId: 'run-1', userId: 'user-1', sessionId: 'session-1' };
const READ_TOOL: BridgeTool = { name: 'get_leads', description: 'Reads leads.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
const WRITE_TOOL: BridgeTool = { name: 'launch_campaign' };
const INSTALL_TOOL: BridgeTool = { name: 'install_skills' };

const ok = (content: string, extra: Partial<BridgeExecuteOutcome> = {}): BridgeExecuteOutcome => ({
  content,
  isError: false,
  requiresConfirmation: false,
  toolsChanged: false,
  ...extra,
});

function makeDeps(tools: BridgeTool[]) {
  const deps = {
    resolveTools: jest.fn(async () => tools),
    isReadOnly: jest.fn((name: string) => name.startsWith('get_')),
    execute: jest.fn(async (_run, call) => ok(`${call.name} done`)),
    releaseRun: jest.fn(),
  };
  return deps as typeof deps & ToolBridgeDeps;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('tool bridge MCP endpoint', () => {
  let http: HttpServer;
  let baseUrl: string;
  let deps: ReturnType<typeof makeDeps>;
  let bridge: ToolBridge;
  let adapter: ToolBridgeMcpAdapter;
  const clients: Client[] = [];

  /** What the app answers for a path that has no route at all. */
  async function unknownPathResponse(): Promise<{ status: number; body: string }> {
    const res = await fetch(`${baseUrl}/internal/tool-bridge/${RUN.runId}/nothing-here`, { method: 'POST' });
    return { status: res.status, body: (await res.text()).replace('/nothing-here', '/mcp') };
  }

  async function connect(token: string, runId = RUN.runId, headers: Record<string, string> = {}): Promise<Client> {
    const client = new Client({ name: 'test-harness', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/internal/tool-bridge/${runId}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
    });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    deps = makeDeps([READ_TOOL, WRITE_TOOL, INSTALL_TOOL]);
    bridge = new ToolBridge(deps);
    adapter = new ToolBridgeMcpAdapter(bridge);
    const app = express();
    app.use(express.json({ limit: '50mb' })); // the app's own limit (app.ts)
    app.use('/internal/tool-bridge', createToolBridgeRouter(adapter));
    http = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => http.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    adapter.closeRun(RUN.runId);
    adapter.closeRun('run-2');
    await new Promise<void>((resolve) => http.close(() => resolve()));
    jest.restoreAllMocks();
  });

  it('serves the run\'s tools to a client holding its token, annotating only read-only tools', async () => {
    const token = adapter.openRun(RUN);
    const client = await connect(token);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_leads', 'launch_campaign', 'install_skills']);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('get_leads')).toMatchObject({
      description: 'Reads leads.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    });
    expect(byName.get('launch_campaign')?.annotations).toBeUndefined();
    expect(byName.get('launch_campaign')?.inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('runs a tool call through the bridge and passes the harness\'s own call id along', async () => {
    const token = adapter.openRun(RUN);
    const client = await connect(token);

    const result = await client.callTool({
      name: 'get_leads',
      arguments: { q: 'acme' },
      _meta: { [HARNESS_TOOL_USE_ID_META_KEY]: 'toolu_abc123' },
    });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'get_leads done' }], isError: false });
    expect(deps.execute).toHaveBeenCalledWith(RUN, { name: 'get_leads', args: { q: 'acme' }, callId: 'toolu_abc123' }, expect.anything());
  });

  it('answers a forged token exactly as it answers a path that does not exist, and never reaches the bridge', async () => {
    adapter.openRun(RUN);
    await expect(connect('forged-token')).rejects.toThrow();

    const res = await fetch(`${baseUrl}/internal/tool-bridge/${RUN.runId}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer forged-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect({ status: res.status, body: await res.text() }).toEqual(await unknownPathResponse());
    expect(res.status).toBe(404);
    expect(deps.resolveTools).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('rejects one run\'s valid token on another run\'s URL, and with another run\'s session id', async () => {
    const tokenA = adapter.openRun(RUN);
    adapter.openRun({ runId: 'run-2', userId: 'user-2', sessionId: 'session-2' });

    const res = await fetch(`${baseUrl}/internal/tool-bridge/run-2/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect({ status: res.status, body: await res.text() }).toEqual({ ...(await unknownPathResponse()), body: expect.any(String) });
    expect(res.status).toBe(404);

    // A's token on A's URL, naming a session that belongs to run 2.
    const tokenB = adapter.openRun({ runId: 'run-2', userId: 'user-2', sessionId: 'session-2' });
    const clientB = await connect(tokenB, 'run-2');
    const sessionB = (clientB.transport as StreamableHTTPClientTransport).sessionId as string;
    const crossed = await fetch(`${baseUrl}/internal/tool-bridge/${RUN.runId}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}`, 'mcp-session-id': sessionB },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_leads', arguments: {} } }),
    });
    expect(crossed.status).toBe(404);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('keeps serving a run whose harness reconnects many times, dropping its oldest sessions', async () => {
    const token = adapter.openRun(RUN);
    for (let i = 0; i < 6; i++) await connect(token);
    const latest = await connect(token);
    expect((await latest.listTools()).tools.length).toBe(3);
  });

  it('returns a tool\'s image as an image block, not as text', async () => {
    deps.execute.mockResolvedValueOnce(ok('Screenshot captured.', { images: [{ mimeType: 'image/png', data: 'QUJD' }] }));
    const token = adapter.openRun(RUN);
    const client = await connect(token);
    const result = await client.callTool({ name: 'get_leads', arguments: {} });
    expect(result.content).toEqual([
      { type: 'text', text: 'Screenshot captured.' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]);
  });

  it('lifts and reports the halt through the adapter', async () => {
    deps.execute.mockResolvedValueOnce(ok('preview', { requiresConfirmation: true }));
    const token = adapter.openRun(RUN);
    const client = await connect(token);
    await client.callTool({ name: 'launch_campaign', arguments: {} });
    expect(adapter.isHalted(RUN.sessionId)).toBe(true);
    adapter.clearHalt(RUN.sessionId);
    expect(adapter.isHalted(RUN.sessionId)).toBe(false);
  });

  it('answers a request that came through a proxy as if the path did not exist, even with a valid token', async () => {
    const token = adapter.openRun(RUN);
    const res = await fetch(`${baseUrl}/internal/tool-bridge/${RUN.runId}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect({ status: res.status, body: await res.text() }).toEqual(await unknownPathResponse());
    expect(res.status).toBe(404);
    expect(deps.resolveTools).not.toHaveBeenCalled();
  });

  it('pushes a tool-list change to the connected client, which then sees the new tool', async () => {
    deps.execute.mockResolvedValueOnce(ok('installed', { toolsChanged: true }));
    const token = adapter.openRun(RUN);
    const client = await connect(token);
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notified += 1;
    });
    await client.listTools();

    deps.resolveTools.mockResolvedValue([READ_TOOL, WRITE_TOOL, INSTALL_TOOL, { name: 'send_email' }]);
    await client.callTool({ name: 'install_skills', arguments: {} });

    await waitFor(() => notified > 0);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('send_email');
  });

  it('holds the answer to the call that changed the tool list until the client has fetched the new list', async () => {
    deps.execute.mockResolvedValueOnce(ok('installed', { toolsChanged: true }));
    const token = adapter.openRun(RUN);
    const client = await connect(token);
    await client.listTools();
    const order: string[] = [];
    deps.resolveTools.mockImplementation(async () => {
      order.push('list fetched');
      return [READ_TOOL, WRITE_TOOL, INSTALL_TOOL, { name: 'send_email' }];
    });
    // What a harness does on the notification: fetch the list again.
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await client.listTools();
    });

    await client.callTool({ name: 'install_skills', arguments: {} });
    order.push('install answered');
    expect(order).toEqual(['list fetched', 'install answered']);
  });

  it('still answers the call when the client never fetches the new list', async () => {
    deps.execute.mockResolvedValueOnce(ok('installed', { toolsChanged: true }));
    const token = adapter.openRun(RUN);
    const client = await connect(token);
    const started = Date.now();
    const result = await client.callTool({ name: 'install_skills', arguments: {} });
    expect(result.isError).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('does not hold a tool-list change for a session the harness abandoned', async () => {
    const token = adapter.openRun(RUN);
    const abandoned = await connect(token);
    await abandoned.listTools();
    // Gone without a DELETE: the session stays registered and will never re-read its tools.
    await (abandoned.transport as StreamableHTTPClientTransport).close();
    const live = await connect(token);
    live.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await live.listTools();
    });

    deps.execute.mockResolvedValueOnce(ok('installed', { toolsChanged: true }));
    const started = Date.now();
    await live.callTool({ name: 'install_skills', arguments: {} });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('answers an initialize whose run closed mid-setup instead of leaving it hanging, and registers nothing', async () => {
    const token = adapter.openRun(RUN);
    const realVerify = bridge.verify.bind(bridge);
    let calls = 0;
    jest.spyOn(bridge, 'verify').mockImplementation((t, id) => {
      calls += 1;
      const claims = realVerify(t, id);
      if (calls === 1) adapter.closeRun(RUN.runId); // closes right after the request was let in
      return claims;
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${baseUrl}/internal/tool-bridge/${RUN.runId}/mcp`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    });
    await res.text(); // must end; a hanging stream aborts and fails the test
    clearTimeout(timer);
    expect((adapter as any).sessionsByRun.size).toBe(0);
  });

  it('answers an undecodable run id exactly as it answers a missing path', async () => {
    adapter.openRun(RUN);
    const post = async (path: string) => {
      const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      return { status: res.status, body: (await res.text()).replace(path, 'PATH') };
    };
    const bridgePath = await post('/internal/tool-bridge/%FF/mcp');
    expect(bridgePath).toEqual(await post('/internal/tool-bridge/%FF/nothing-here'));
    expect(bridgePath.status).toBe(404);
  });

  it('returns the halt refusal to the client once a result requires confirmation', async () => {
    deps.execute.mockResolvedValueOnce(ok('{"previewToken":"abc"}', { requiresConfirmation: true }));
    const token = adapter.openRun(RUN);
    const client = await connect(token);

    await client.callTool({ name: 'launch_campaign', arguments: {} });
    const replay = await client.callTool({ name: 'launch_campaign', arguments: { confirm: true, preview_token: 'abc' } });
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay.content)).toMatch(/waiting for the user to confirm/);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('stops serving a connected client once the run is closed', async () => {
    const token = adapter.openRun(RUN);
    const client = await connect(token);
    await client.listTools();

    adapter.closeRun(RUN.runId);
    await expect(client.callTool({ name: 'get_leads', arguments: {} })).rejects.toThrow();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('refuses a request that names an unknown session, and a non-initialize request with no session', async () => {
    const token = adapter.openRun(RUN);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const unknown = await fetch(`${baseUrl}/internal/tool-bridge/${RUN.runId}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': 'not-a-session' },
      body,
    });
    expect(unknown.status).toBe(404);

    const noSession = await fetch(`${baseUrl}/internal/tool-bridge/${RUN.runId}/mcp`, { method: 'POST', headers, body });
    expect(noSession.status).toBe(400);
  });
  // ─── ENG-2113 PR B ──────────────────────────────────────────────────────────

  it('answers the initialize request as plain JSON, not an event stream (the CLI handshake fails on SSE)', async () => {
    const token = adapter.openRun(RUN);
    const res = await fetch(`${baseUrl}/internal/tool-bridge/${RUN.runId}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-type')).not.toContain('text/event-stream');
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('emma');
  });

  it('a stop closes the run and its MCP session, so the harness cannot call again', async () => {
    const token = adapter.openRun(RUN);
    const client = await connect(token);
    adapter.beginTurn(RUN.userId, RUN.sessionId);
    expect(adapter.cancelSession(RUN.userId, RUN.sessionId)).toEqual({ cancelled: true, runIds: [RUN.runId] });
    await expect(client.callTool({ name: 'launch_campaign', arguments: {} })).rejects.toBeDefined();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('revoking the connection closes the funded run and its MCP session', async () => {
    (deps as any).isLive = jest.fn(async () => true);
    const token = adapter.openRun({ ...RUN, connectionId: 'conn-1', epoch: 2 });
    const client = await connect(token);
    expect(adapter.revokeConnection('conn-1')).toEqual([RUN.runId]);
    await expect(client.callTool({ name: 'get_leads', arguments: {} })).rejects.toBeDefined();
  });

  it('feeds the stream events to the bridge so a repeated call in one message collapses', async () => {
    const token = adapter.openRun(RUN, { callGroupWaitMs: 100 });
    adapter.noteToolUse(RUN.runId, 'toolu_1', 'get_leads', { q: 'a' }, 'msg_1');
    adapter.noteToolUse(RUN.runId, 'toolu_2', 'get_leads', { q: 'a' }, 'msg_1');
    const client = await connect(token);
    const call = (id: string) =>
      client.callTool({ name: 'get_leads', arguments: { q: 'a' }, _meta: { [HARNESS_TOOL_USE_ID_META_KEY]: id } });
    const first = await call('toolu_1');
    const second = await call('toolu_2');
    expect((first.content as any)[0].text).toBe('get_leads done');
    expect((second.content as any)[0].text).toContain('was collapsed');
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('carries unicode and a 300 KB argument to the tool byte-identical over real HTTP', async () => {
    const token = adapter.openRun(RUN);
    const client = await connect(token);
    const unicode = 'héllo wörld 你好, 世界 🚀 — “quotes” \\ backslash \t tab \u0000 nul';
    const big = 'x'.repeat(300_000) + '🚀';
    await client.callTool({ name: 'get_leads', arguments: { q: unicode } });
    await client.callTool({ name: 'get_leads', arguments: { q: big } });
    const received = deps.execute.mock.calls.map((c: any[]) => c[1].args.q);
    expect(received).toEqual([unicode, big]);
  });

  it('drains and closes through the adapter, returning the ledger', async () => {
    const token = adapter.openRun(RUN);
    const client = await connect(token);
    await client.callTool({ name: 'get_leads', arguments: { q: 'a' } });
    const drained = await adapter.closeRunAndDrain(RUN.runId, 500);
    expect(drained?.settled).toBe(true);
    expect(drained?.ledger.map((r) => r.name)).toEqual(['get_leads']);
    await expect(client.callTool({ name: 'get_leads', arguments: {} })).rejects.toBeDefined();
  });

});

describe('isLocalOnlyRequest', () => {
  const req = (remoteAddress: string | undefined, headers: Record<string, string> = {}) =>
    ({ headers, socket: { remoteAddress } }) as any;

  it('accepts a direct loopback connection', () => {
    expect(isLocalOnlyRequest(req('127.0.0.1'))).toBe(true);
    expect(isLocalOnlyRequest(req('::1'))).toBe(true);
    expect(isLocalOnlyRequest(req('::ffff:127.0.0.1'))).toBe(true);
  });

  it('rejects anything that carries a forwarding header, which every proxied request does', () => {
    expect(isLocalOnlyRequest(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }))).toBe(false);
    expect(isLocalOnlyRequest(req('127.0.0.1', { forwarded: 'for=203.0.113.9' }))).toBe(false);
  });

  it('rejects a non-loopback or unknown peer', () => {
    expect(isLocalOnlyRequest(req('10.0.3.7'))).toBe(false);
    expect(isLocalOnlyRequest(req(undefined))).toBe(false);
  });
});
