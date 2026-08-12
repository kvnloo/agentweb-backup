/**
 * Regression coverage for ENG-1118: a browser-backed MCP server (Playwright) must
 * never be shared between two chat sessions.
 *
 * The client pool is keyed by userId, so two concurrent sessions of the same user
 * (e.g. a scheduled run and an interactive chat) were handed the SAME Playwright
 * MCP process — i.e. the same single-tab browser. One session's navigate() moved
 * the other session's page, and evaluate() silently returned the wrong site's DOM.
 *
 * Browser servers must therefore pool per chat session; every other server keeps
 * pooling per user (cheap HTTP clients, per-user credentials).
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockGetSetting = jest.fn().mockResolvedValue(null);
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...args: any[]) => mockGetSetting(...args) },
}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
}));

jest.mock('../utils/crypto', () => ({
  decryptPassword: (value: string) => ({ password: value }),
}));

jest.mock('../mcp/client/mcp_config', () => ({ internalMcpServers: {} }));

const mockClientFactory = jest.fn();
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation((...args: any[]) => mockClientFactory(...args)),
}));

jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })),
}));

import { McpClientService } from '../mcp/client/mcpClientService';

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue({ tools: [] }),
    callTool: jest.fn().mockResolvedValue({ content: [] }),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('McpClientService browser session isolation (ENG-1118)', () => {
  let service: McpClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockClientFactory.mockImplementation(() => makeClient());
    service = new McpClientService();
  });

  afterEach(async () => {
    await service.shutdown();
  });

  async function registerServer(name: string, config: Record<string, unknown>, toolPrefix?: string) {
    await (service as any).safeConnectToServer(name, config, toolPrefix);
  }

  const BROWSER_SERVER = {
    transport: 'stdio',
    command: 'npx',
    args: ['@playwright/mcp@0.0.70'],
  };

  it('gives two concurrent sessions of the same user separate browser clients', async () => {
    await registerServer('playwright', { transport: 'sse', url: 'http://browser.example.com/sse' }, 'playwright');

    const clientA = await (service as any).getSessionClient('playwright', 'chat-session-a', 'user-1');
    const clientB = await (service as any).getSessionClient('playwright', 'chat-session-b', 'user-1');

    expect(clientA).not.toBe(clientB);
    expect((service as any).sessionClientPools.size).toBe(2);
  });

  it('reuses the same browser client within one chat session', async () => {
    await registerServer('playwright', { transport: 'sse', url: 'http://browser.example.com/sse' }, 'playwright');

    const first = await (service as any).getSessionClient('playwright', 'chat-session-a', 'user-1');
    const second = await (service as any).getSessionClient('playwright', 'chat-session-a', 'user-1');

    expect(first).toBe(second);
    expect((service as any).sessionClientPools.size).toBe(1);
  });

  it('never shares a browser client between two different users', async () => {
    await registerServer('playwright', { transport: 'sse', url: 'http://browser.example.com/sse' }, 'playwright');

    const clientA = await (service as any).getSessionClient('playwright', 'chat-session-a', 'user-1');
    const clientB = await (service as any).getSessionClient('playwright', 'chat-session-a', 'user-2');

    expect(clientA).not.toBe(clientB);
  });

  it('detects a browser server from its stdio command even when the name is opaque', async () => {
    (service as any).serverConfigs.set('automation', { config: BROWSER_SERVER, toolPrefix: 'automation' });

    const keyA = (service as any).getPoolKey('automation', 'chat-session-a', 'user-1');
    const keyB = (service as any).getPoolKey('automation', 'chat-session-b', 'user-1');

    expect(keyA).not.toBe(keyB);
  });

  // The server-name/command heuristic is our own naming; the TOOL names come from the
  // server itself (Playwright MCP exposes browser_navigate, browser_evaluate, ...). Keying
  // isolation on the tool means renaming or re-hosting the server cannot silently drop a
  // browser back into a shared per-user pool — which would reinstate ENG-1118 with no signal.
  it('isolates per session when the TOOL is a browser tool, however opaque the server', async () => {
    (service as any).serverConfigs.set('automation-gateway', {
      config: { transport: 'sse', url: 'https://gateway.example.com/sse' },
      toolPrefix: 'automation',
    });

    const keyA = (service as any).getPoolKey('automation-gateway', 'chat-session-a', 'user-1', 'browser_navigate');
    const keyB = (service as any).getPoolKey('automation-gateway', 'chat-session-b', 'user-1', 'browser_navigate');

    expect(keyA).toBe('user-1::chat-session-a');
    expect(keyB).toBe('user-1::chat-session-b');
    expect(keyA).not.toBe(keyB);
  });

  it('hands two sessions separate clients for a browser tool on an opaque server', async () => {
    await registerServer('automation-gateway', { transport: 'sse', url: 'https://gateway.example.com/sse' }, 'automation');

    const clientA = await (service as any).getSessionClient('automation-gateway', 'chat-session-a', 'user-1', 'browser_navigate');
    const clientB = await (service as any).getSessionClient('automation-gateway', 'chat-session-b', 'user-1', 'browser_navigate');

    expect(clientA).not.toBe(clientB);
  });

  it('keeps per-user pooling for a non-browser tool on that same server', async () => {
    (service as any).serverConfigs.set('automation-gateway', {
      config: { transport: 'sse', url: 'https://gateway.example.com/sse' },
      toolPrefix: 'automation',
    });

    const keyA = (service as any).getPoolKey('automation-gateway', 'chat-session-a', 'user-1', 'list_records');
    const keyB = (service as any).getPoolKey('automation-gateway', 'chat-session-b', 'user-1', 'list_records');

    expect(keyA).toBe('user-1');
    expect(keyB).toBe('user-1');
  });

  it('falls back to per-user pooling for a server with no stored config', async () => {
    const keyA = (service as any).getPoolKey('unknown-server', 'chat-session-a', 'user-1');
    const keyB = (service as any).getPoolKey('unknown-server', 'chat-session-b', 'user-1');

    expect(keyA).toBe(keyB);
  });

  it('still isolates browser pools per session when no userId is available', async () => {
    (service as any).serverConfigs.set('automation', { config: BROWSER_SERVER });

    const keyA = (service as any).getPoolKey('automation', 'chat-session-a');
    const keyB = (service as any).getPoolKey('automation', 'chat-session-b');

    expect(keyA).not.toBe(keyB);
  });

  it('keeps pooling non-browser servers per user across sessions', async () => {
    await registerServer('notion', { transport: 'sse', url: 'http://notion.example.com/sse' }, 'notion');

    const clientA = await (service as any).getSessionClient('notion', 'chat-session-a', 'user-1');
    const clientB = await (service as any).getSessionClient('notion', 'chat-session-b', 'user-1');

    expect(clientA).toBe(clientB);
    expect((service as any).sessionClientPools.size).toBe(1);
  });

  it('releases a per-session browser client when released by the bare chat session id', async () => {
    await registerServer('playwright', { transport: 'sse', url: 'http://browser.example.com/sse' }, 'playwright');

    const client = await (service as any).getSessionClient('playwright', 'chat-session-a', 'user-1');

    await service.releaseSessionClients('chat-session-a');

    expect(client.close).toHaveBeenCalled();
    expect((service as any).sessionClientPools.size).toBe(0);
  });

  it('leaves a concurrent session\'s browser client alone when releasing one session', async () => {
    await registerServer('playwright', { transport: 'sse', url: 'http://browser.example.com/sse' }, 'playwright');

    const clientA = await (service as any).getSessionClient('playwright', 'chat-session-a', 'user-1');
    const clientB = await (service as any).getSessionClient('playwright', 'chat-session-b', 'user-1');

    await service.releaseSessionClients('chat-session-a');

    expect(clientA.close).toHaveBeenCalled();
    expect(clientB.close).not.toHaveBeenCalled();
    expect((service as any).sessionClientPools.size).toBe(1);
  });

  it('does not release a per-user browser pool when a stale sibling pool is swept', async () => {
    await registerServer('playwright', { transport: 'sse', url: 'http://browser.example.com/sse' }, 'playwright');
    await registerServer('notion', { transport: 'sse', url: 'http://notion.example.com/sse' }, 'notion');

    const browserClient = await (service as any).getSessionClient('playwright', 'chat-session-a', 'user-1');
    const notionClient = await (service as any).getSessionClient('notion', 'chat-session-a', 'user-1');

    // The per-user pool ("user-1") goes stale while the browser pool
    // ("user-1::chat-session-a") is still active; the sweep must not touch it.
    (service as any).sessionClientPools.get('user-1').lastActivity = 0;
    await (service as any).cleanupStaleSessions();

    expect(notionClient.close).toHaveBeenCalled();
    expect(browserClient.close).not.toHaveBeenCalled();
    expect((service as any).sessionClientPools.has('user-1::chat-session-a')).toBe(true);
  });

  it('evicts a dead browser client from its own session pool, leaving the sibling session untouched', async () => {
    mockGetSetting.mockResolvedValue({
      settingValue: JSON.stringify([{ name: 'playwright', transport: 'sse', url: 'http://browser.example.com/sse' }]),
    });

    const tools = [{ name: 'browser_navigate', description: 'Navigate', inputSchema: { type: 'object' } }];
    const clients: any[] = [];
    mockClientFactory.mockImplementation(() => {
      const client = makeClient({
        listTools: jest.fn().mockResolvedValue({ tools }),
        callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false }),
      });
      clients.push(client);
      return client;
    });

    await service.initialize();
    const navigate = service.getTools().find(t => t.name === 'playwright_browser_navigate')!;
    expect(navigate).toBeDefined();

    const contextA = { userId: 'user-1', sessionId: 'chat-session-a', llmModel: 'm', service: null } as any;
    const contextB = { userId: 'user-1', sessionId: 'chat-session-b', llmModel: 'm', service: null } as any;

    await navigate.execute({ url: 'https://www.gao.gov' }, contextA);
    await navigate.execute({ url: 'https://www.healthit.gov' }, contextB);

    const poolA = (service as any).sessionClientPools.get((service as any).getPoolKey('playwright', 'chat-session-a', 'user-1'));
    const poolB = (service as any).sessionClientPools.get((service as any).getPoolKey('playwright', 'chat-session-b', 'user-1'));
    expect(poolA?.clients.get('playwright')).toBeDefined();
    expect(poolB?.clients.get('playwright')).toBeDefined();
    expect(poolA!.clients.get('playwright')).not.toBe(poolB!.clients.get('playwright'));

    // Session A's transport dies: only session A's client is evicted and replaced.
    const deadClient = poolA!.clients.get('playwright');
    const survivingClientB = poolB!.clients.get('playwright');
    deadClient.callTool = jest.fn().mockRejectedValue(new Error('Connection timeout for playwright'));

    await navigate.execute({ url: 'https://www.gao.gov' }, contextA);

    expect(deadClient.close).toHaveBeenCalled();
    expect(poolA!.clients.get('playwright')).not.toBe(deadClient);
    expect(poolB!.clients.get('playwright')).toBe(survivingClientB);
  });
});
