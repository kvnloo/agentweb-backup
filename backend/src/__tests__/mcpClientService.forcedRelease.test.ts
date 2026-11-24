/**
 * ENG-3170: a chat session's browser is pooled for the whole session under the OWNER's id, so when the person driving it changes between the owner and a
 * share-link visitor who may not use the owner's logins, the session's browser is released. The release must be FORCED (a call the other person left
 * running must not survive it), and the call that was running must not RETRY into the new browser (a browser tool retries on any error, and the closed
 * browser fails the running call with exactly such an error).
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

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue({ tools: [] }),
    callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('McpClientService forced release of a session\'s browser (ENG-3170)', () => {
  let service: McpClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockClientFactory.mockImplementation(() => makeClient());
    (McpClientService as any).playwrightBrowsersInstall = Promise.resolve();
    service = new McpClientService();
  });
  afterEach(async () => { await service.shutdown(); });

  const register = () => (service as any).safeConnectToServer('playwright', { transport: 'sse', url: 'http://browser.example.com/sse' }, 'playwright');

  describe('releaseSessionClients', () => {
    it('without force, a pool with a call still running is skipped and counted', async () => {
      await register();
      const client = await (service as any).getSessionClient('playwright', 'chat-a', 'user-1');
      (service as any).markPoolBusy((service as any).getPoolKey('playwright', 'chat-a', 'user-1'), 1);
      await expect(service.releaseSessionClients('chat-a')).resolves.toEqual({ released: 0, skippedInFlight: 1 });
      expect(client.close).not.toHaveBeenCalled();
      expect((service as any).sessionClientPools.size).toBe(1);
    });

    it('with force, the same pool is closed and nothing is skipped', async () => {
      await register();
      const client = await (service as any).getSessionClient('playwright', 'chat-a', 'user-1');
      (service as any).markPoolBusy((service as any).getPoolKey('playwright', 'chat-a', 'user-1'), 1);
      await expect(service.releaseSessionClients('chat-a', { force: true })).resolves.toEqual({ released: 1, skippedInFlight: 0 });
      expect(client.close).toHaveBeenCalled();
      expect((service as any).sessionClientPools.size).toBe(0);
    });

    it('an idle pool is released either way, and another session\'s pool is left alone', async () => {
      await register();
      const a = await (service as any).getSessionClient('playwright', 'chat-a', 'user-1');
      const b = await (service as any).getSessionClient('playwright', 'chat-b', 'user-1');
      await expect(service.releaseSessionClients('chat-a')).resolves.toEqual({ released: 1, skippedInFlight: 0 });
      expect(a.close).toHaveBeenCalled();
      expect(b.close).not.toHaveBeenCalled();
    });
  });

  describe('a browser call that is running when the session\'s browser is force-released', () => {
    // A browser tool of the server, built the way the real discovery builds it, with a client whose callTool is controlled by the test.
    async function browserTool(callTool: jest.Mock) {
      mockClientFactory.mockImplementation(() => makeClient({
        callTool,
        listTools: jest.fn().mockResolvedValue({ tools: [{ name: 'browser_run_code', description: 'run code', inputSchema: { type: 'object', properties: {} } }] }),
      }));
      await register();
      const tool = service.getTools().find((t) => t.name.includes('browser_run_code'));
      if (!tool) throw new Error('the browser tool was not registered');
      return tool;
    }

    it('does NOT retry into the new browser: it fails, once', async () => {
      const callTool = jest.fn()
        .mockImplementationOnce(async () => {
          await service.releaseSessionClients('chat-a', { force: true }); // the person driving the browser changes while this call runs
          throw new Error('Connection closed');
        })
        .mockResolvedValue({ content: [{ type: 'text', text: 'the retry ran in the NEW browser' }] });
      const tool = await browserTool(callTool);
      await expect(tool.execute({ code: 'x' }, { userId: 'user-1', sessionId: 'chat-a', llmModel: 'm' } as any)).rejects.toThrow(/was reset because the person driving it changed/);
      expect(callTool).toHaveBeenCalledTimes(1);
    });

    it('CONTROL: an ordinary failure with no release still retries (the retry exists for a dead browser)', async () => {
      const callTool = jest.fn()
        .mockRejectedValueOnce(new Error('Connection closed'))
        .mockResolvedValue({ content: [{ type: 'text', text: 'recovered' }] });
      const tool = await browserTool(callTool);
      const result: any = await tool.execute({ code: 'x' }, { userId: 'user-1', sessionId: 'chat-a', llmModel: 'm' } as any);
      expect(result.content).toContain('recovered');
      expect(callTool).toHaveBeenCalledTimes(2);
    }, 15000);

    it('the same for a server whose secrets are resolved per user (the per-user discovery path has its own retry loop)', async () => {
      const callTool = jest.fn()
        .mockImplementationOnce(async () => {
          await service.releaseSessionClients('chat-a', { force: true });
          throw new Error('Connection closed');
        })
        .mockResolvedValue({ content: [{ type: 'text', text: 'the retry ran in the NEW browser' }] });
      mockClientFactory.mockImplementation(() => makeClient({
        callTool,
        listTools: jest.fn().mockResolvedValue({ tools: [{ name: 'browser_run_code', description: 'run code', inputSchema: { type: 'object', properties: {} } }] }),
      }));
      await (service as any).safeConnectToServer('playwright', { transport: 'sse', url: 'http://browser.example.com/sse', accessToken: '{{browser_token}}' }, 'playwright');
      (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', secrets: { browser_token: 'a-token' } });
      expect(await service.discoverToolsForUser('user-1', 'chat-a')).toBeGreaterThan(0);
      const tool = service.getTools().find((t) => t.name.includes('browser_run_code'));
      if (!tool) throw new Error('the per-user browser tool was not registered');
      await expect(tool.execute({ code: 'x' }, { userId: 'user-1', sessionId: 'chat-a', llmModel: 'm' } as any)).rejects.toThrow(/was reset because the person driving it changed/);
      expect(callTool).toHaveBeenCalledTimes(1);
    });

    it('a release of ANOTHER session does not stop this call\'s retry', async () => {
      const callTool = jest.fn()
        .mockImplementationOnce(async () => {
          await service.releaseSessionClients('chat-other', { force: true });
          throw new Error('Connection closed');
        })
        .mockResolvedValue({ content: [{ type: 'text', text: 'recovered' }] });
      const tool = await browserTool(callTool);
      const result: any = await tool.execute({ code: 'x' }, { userId: 'user-1', sessionId: 'chat-a', llmModel: 'm' } as any);
      expect(result.content).toContain('recovered');
      expect(callTool).toHaveBeenCalledTimes(2);
    }, 15000);

    it('a NON-forced release (the idle sweep, the end of a chat) does not change the retry either', async () => {
      const callTool = jest.fn()
        .mockImplementationOnce(async () => {
          await service.releaseSessionClients('chat-a');
          throw new Error('Connection closed');
        })
        .mockResolvedValue({ content: [{ type: 'text', text: 'recovered' }] });
      const tool = await browserTool(callTool);
      const result: any = await tool.execute({ code: 'x' }, { userId: 'user-1', sessionId: 'chat-a', llmModel: 'm' } as any);
      expect(result.content).toContain('recovered');
      expect(callTool).toHaveBeenCalledTimes(2);
    }, 15000);
  });
});
