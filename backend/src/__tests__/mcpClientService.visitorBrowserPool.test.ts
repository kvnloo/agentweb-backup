/**
 * ENG-3170: a chat session's browser is pooled per (owner, chat session) for an hour, and a share-link visitor runs under the owner's id and session, so
 * a visitor who may not use the owner's logins would drive the browser the owner logged in (browser_evaluate can read its cookies), and any hand-over
 * between the two has a window. `executeTool` gives such a visitor a browser pool of their own through `ToolContext.browserPoolSessionId`
 * (`<session>::visitor`). These tests use real pools: the visitor's calls never touch the owner's client, a retry stays in the pool it started in, and
 * both are released together.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockGetSetting = jest.fn().mockResolvedValue(null);
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...args: any[]) => mockGetSetting(...args) },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../utils/crypto', () => ({ decryptPassword: (value: string) => ({ password: value }) }));
jest.mock('../mcp/client/mcp_config', () => ({ internalMcpServers: {} }));

const mockClientFactory = jest.fn();
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation((...args: any[]) => mockClientFactory(...args)),
}));
jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })) }));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })) }));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({ onclose: null, onerror: null })) }));

import { McpClientService } from '../mcp/client/mcpClientService';
import { userDb } from '../services/db';

const BROWSER_TOOL_LIST = { tools: [{ name: 'browser_run_code', description: 'run code', inputSchema: { type: 'object', properties: {} } }] };

describe('McpClientService: a share-link visitor\'s browser pool (ENG-3170)', () => {
  let service: McpClientService;
  let clients: Array<{ callTool: jest.Mock; close: jest.Mock }>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    clients = [];
    mockClientFactory.mockImplementation(() => {
      const client = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue(BROWSER_TOOL_LIST),
        callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
        close: jest.fn().mockResolvedValue(undefined),
      };
      clients.push(client);
      return client;
    });
    (McpClientService as any).playwrightBrowsersInstall = Promise.resolve();
    service = new McpClientService();
  });
  afterEach(async () => { await service.shutdown(); });

  const register = () => (service as any).safeConnectToServer('playwright', { transport: 'sse', url: 'http://browser.example.com/sse' }, 'playwright');
  const tool = () => {
    const found = service.getTools().find((t) => t.name.includes('browser_run_code'));
    if (!found) throw new Error('the browser tool was not registered');
    return found;
  };
  const call = (ctx: Record<string, unknown>) => tool().execute({ code: 'x' }, { userId: 'user-1', sessionId: 'chat-a', llmModel: 'm', ...ctx } as any);
  const poolKeys = () => Array.from((service as any).sessionClientPools.keys()) as string[];
  const callsOf = (client: { callTool: jest.Mock }) => client.callTool.mock.calls.length;

  it('the owner\'s call and the visitor\'s call of the same chat session are made on two DIFFERENT browsers', async () => {
    await register();
    clients.length = 0;
    await call({});
    await call({ browserPoolSessionId: 'chat-a::visitor' });
    expect(clients).toHaveLength(2);
    expect(callsOf(clients[0])).toBe(1);
    expect(callsOf(clients[1])).toBe(1);
    expect(poolKeys().sort()).toEqual(['user-1::chat-a', 'user-1::chat-a::visitor']);
  });

  it('each stays on its own browser across calls: the visitor\'s second call reuses the visitor\'s, not the owner\'s', async () => {
    await register();
    clients.length = 0;
    await call({});
    await call({ browserPoolSessionId: 'chat-a::visitor' });
    await call({ browserPoolSessionId: 'chat-a::visitor' });
    await call({});
    expect(clients).toHaveLength(2);
    expect(callsOf(clients[0])).toBe(2); // the owner's browser: only the owner's two calls
    expect(callsOf(clients[1])).toBe(2); // the visitor's browser: only the visitor's two calls
  });

  it('a retry of the visitor\'s call stays in the visitor\'s pool (it never lands in the owner\'s browser)', async () => {
    await register();
    clients.length = 0;
    await call({}); // the owner's browser exists
    const owner = clients[0];
    let failedOnce = false;
    mockClientFactory.mockImplementationOnce(() => {
      const client = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue(BROWSER_TOOL_LIST),
        callTool: jest.fn().mockImplementation(async () => {
          if (!failedOnce) { failedOnce = true; throw new Error('Connection closed'); }
          return { content: [{ type: 'text', text: 'recovered' }] };
        }),
        close: jest.fn().mockResolvedValue(undefined),
      };
      clients.push(client);
      return client;
    });
    const result: any = await call({ browserPoolSessionId: 'chat-a::visitor' });
    expect(result.content).toContain('recovered');
    expect(callsOf(owner)).toBe(1); // only the owner's own first call
    expect(poolKeys().filter((key) => key.endsWith('::visitor'))).toEqual(['user-1::chat-a::visitor']);
  }, 15000);

  it('releasing a chat session releases the visitor\'s browser with it, and nobody else\'s', async () => {
    await register();
    clients.length = 0;
    await call({});
    await call({ browserPoolSessionId: 'chat-a::visitor' });
    await call({ sessionId: 'chat-b' });
    await call({ sessionId: 'chat-b', browserPoolSessionId: 'chat-b::visitor' });
    await service.releaseSessionClients('chat-a');
    expect(clients[0].close).toHaveBeenCalled();
    expect(clients[1].close).toHaveBeenCalled();
    expect(clients[2].close).not.toHaveBeenCalled();
    expect(clients[3].close).not.toHaveBeenCalled();
    expect(poolKeys().sort()).toEqual(['user-1::chat-b', 'user-1::chat-b::visitor']);
  });

  it('a pool is not shared across users either way, and a plain call without the field is unchanged (the chat session\'s own pool)', async () => {
    await register();
    clients.length = 0;
    await call({ userId: 'user-1' });
    await call({ userId: 'user-2', browserPoolSessionId: 'chat-a::visitor' });
    expect(poolKeys().sort()).toEqual(['user-1::chat-a', 'user-2::chat-a::visitor']);
  });

  it('the same for a server whose secrets are resolved per user (the per-user discovery path has its own execute)', async () => {
    await (service as any).safeConnectToServer('playwright', { transport: 'sse', url: 'http://browser.example.com/sse', accessToken: '{{browser_token}}' }, 'playwright');
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', secrets: { browser_token: 'a-token' } });
    expect(await service.discoverToolsForUser('user-1', 'chat-a')).toBeGreaterThan(0);
    await call({});
    await call({ browserPoolSessionId: 'chat-a::visitor' });
    expect(poolKeys().sort()).toEqual(['user-1::chat-a', 'user-1::chat-a::visitor']);
    const used = clients.filter((client) => callsOf(client) > 0);
    expect(used).toHaveLength(2); // the two calls ran on two different browsers
    expect(used.map(callsOf)).toEqual([1, 1]);
  });
});
