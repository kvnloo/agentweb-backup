/**
 * Regression coverage for MCP client lifecycle ownership.
 *
 * These tests deliberately exercise the private lifecycle seam: callers should
 * never observe duplicate clients, stale configuration, or orphaned transports.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockGetSetting = jest.fn().mockResolvedValue(null);
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...args: any[]) => mockGetSetting(...args) },
}));

const mockGetUserById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getUserById: (...args: any[]) => mockGetUserById(...args) },
}));

const mockDecryptPassword = jest.fn((value: string) => ({ password: value }));
jest.mock('../utils/crypto', () => ({
  decryptPassword: (value: string) => mockDecryptPassword(value),
}));

jest.mock('../mcp/client/mcp_config', () => ({ internalMcpServers: {} }));

const mockClientFactory = jest.fn();
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation((...args: any[]) => mockClientFactory(...args)),
}));

jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn(),
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

describe('McpClientService lifecycle', () => {
  let service: McpClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
    mockDecryptPassword.mockImplementation((value: string) => ({ password: value }));
    service = new McpClientService();
  });

  afterEach(async () => {
    jest.useRealTimers();
    await service.shutdown();
  });

  it('shares one in-flight connection for concurrent calls in the same user/server pool', async () => {
    let finishConnect!: () => void;
    const connectGate = new Promise<void>(resolve => { finishConnect = resolve; });
    const sessionClient = makeClient({ connect: jest.fn(() => connectGate) });
    mockClientFactory.mockReturnValue(sessionClient);

    (service as any).serverConfigs.set('shared-server', {
      config: { transport: 'sse', url: 'https://mcp.example.com/sse' },
    });
    jest.spyOn(service, 'createTransport').mockResolvedValue({ onclose: null, onerror: null } as any);

    const first = (service as any).getSessionClient('shared-server', 'chat-a', 'user-1');
    const second = (service as any).getSessionClient('shared-server', 'chat-b', 'user-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockClientFactory).toHaveBeenCalledTimes(1);
    finishConnect();
    await expect(Promise.all([first, second])).resolves.toEqual([sessionClient, sessionClient]);
  });

  it('closes an in-flight client when its pool is released during connection', async () => {
    let finishConnect!: () => void;
    const connectGate = new Promise<void>(resolve => { finishConnect = resolve; });
    const sessionClient = makeClient({ connect: jest.fn(() => connectGate) });
    mockClientFactory.mockReturnValue(sessionClient);
    (service as any).serverConfigs.set('slow-server', {
      config: { transport: 'sse', url: 'https://mcp.example.com/sse' },
    });
    jest.spyOn(service, 'createTransport').mockResolvedValue({ onclose: null, onerror: null } as any);

    const connection = (service as any).getSessionClient('slow-server', 'chat-a', 'user-1');
    await Promise.resolve();
    const release = service.releaseSessionClients('user-1');
    finishConnect();

    await expect(connection).rejects.toThrow(/released while connecting/i);
    await expect(release).resolves.toBeUndefined();
    expect(sessionClient.close).toHaveBeenCalledTimes(1);
  });

  it('closes and forgets a startup client when tool discovery fails', async () => {
    jest.useFakeTimers();
    const client = makeClient({ listTools: jest.fn().mockRejectedValue(new Error('bad tool schema')) });
    mockClientFactory.mockReturnValue(client);
    jest.spyOn(service, 'createTransport').mockResolvedValue({ onclose: null, onerror: null } as any);

    await expect((service as any).connectToServer(
      'broken-server',
      { transport: 'sse', url: 'https://mcp.example.com/sse' },
    )).rejects.toThrow('bad tool schema');

    expect(client.close).toHaveBeenCalledTimes(1);
    expect((service as any).clients.has('broken-server')).toBe(false);
  });

  it('does not leave a connection timeout timer after a successful startup connect', async () => {
    jest.useFakeTimers();
    const client = makeClient();
    mockClientFactory.mockReturnValue(client);
    jest.spyOn(service, 'createTransport').mockResolvedValue({ onclose: null, onerror: null } as any);
    const timersBeforeConnect = jest.getTimerCount();

    await (service as any).connectToServer(
      'healthy-server',
      { transport: 'sse', url: 'https://mcp.example.com/sse' },
    );

    expect(jest.getTimerCount()).toBe(timersBeforeConnect);
  });

  it('refresh removes retired server state and restarts stale-session cleanup', async () => {
    (service as any).serverConfigs.set('retired-server', {
      config: { transport: 'sse', url: 'https://retired.example.com/sse' },
    });
    (service as any).serversWithSecretPlaceholders.add('retired-server');
    (service as any).serverCircuits.set('retired-server', {
      failureCount: 3,
      firstFailureAt: Date.now(),
      openUntil: Date.now() + 60_000,
    });

    await service.refresh();

    expect((service as any).serverConfigs.size).toBe(0);
    expect((service as any).serversWithSecretPlaceholders.size).toBe(0);
    expect((service as any).serverCircuits.size).toBe(0);
    expect((service as any).cleanupInterval).toBeDefined();
  });

  it('rejects a per-user placeholder server without a user before creating a transport', async () => {
    mockDecryptPassword.mockImplementation(() => { throw new Error('plain text'); });
    await (service as any).safeConnectToServer('secret-server', {
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      accessToken: '{{api_token}}',
    }, 'secret');
    const createTransport = jest.spyOn(service, 'createTransport');

    await expect((service as any).getSessionClient('secret-server', 'chat-a')).rejects.toThrow(/user identity/i);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('rejects a missing required user secret before creating a transport', async () => {
    await (service as any).safeConnectToServer('secret-server', {
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      accessToken: '{{api_token}}',
    }, 'secret');
    mockGetUserById.mockResolvedValue({
      userId: 'user-1',
      secrets: { unrelated_secret: 'encrypted-other-value' },
    });
    const createTransport = jest.spyOn(service, 'createTransport');

    await expect((service as any).getSessionClient('secret-server', 'chat-a', 'user-1'))
      .rejects.toThrow('Required user secret "api_token" is not configured');
    expect(createTransport).not.toHaveBeenCalled();
  });
});
