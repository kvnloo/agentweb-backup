/**
 * Unit tests for MCP Client Service per-user secret placeholder detection.
 * Verifies that configHasSecretPlaceholders correctly identifies servers
 * that require per-user resolution of {{...}} placeholders in both
 * env values and accessToken fields (including encrypted accessTokens).
 */

// Set env before any imports
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

// Mock MCP SDK modules
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue({ tools: [] }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null,
    close: jest.fn(),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null,
    close: jest.fn(),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null,
    close: jest.fn(),
  })),
}));

// Mock settings service
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn().mockResolvedValue(null),
  },
}));

// Mock db
const mockGetUserById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: (...args: any[]) => mockGetUserById(...args),
  },
}));

// Mock crypto with real behavior for testing
const mockDecryptPassword = jest.fn();
jest.mock('../utils/crypto', () => ({
  encryptPassword: jest.fn(),
  decryptPassword: (...args: any[]) => mockDecryptPassword(...args),
}));

// Mock internal MCP config (no internal servers for these tests)
jest.mock('../mcp/client/mcp_config', () => ({
  internalMcpServers: {},
}));

import { McpClientService, McpServerConfig } from '../mcp/client/mcpClientService';

describe('MCP Client Service - Secret Placeholder Detection', () => {
  let service: McpClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Create a fresh service for each test
    service = new McpClientService();
  });

  afterEach(async () => {
    // Clean up to avoid open handles
    await service.shutdown();
  });

  describe('configHasSecretPlaceholders via safeConnectToServer', () => {
    // We test configHasSecretPlaceholders indirectly through initialize()
    // by checking if servers are added to serversWithSecretPlaceholders

    it('should detect {{...}} placeholders in env values', async () => {
      const config: McpServerConfig = {
        transport: 'stdio',
        command: 'npx',
        args: ['some-server'],
        env: { API_KEY: '{{github_token}}' },
      };

      // Access the private method via any cast
      await (service as any).safeConnectToServer('test-server', config, 'test');

      // Server should be tracked as having placeholders
      expect((service as any).serversWithSecretPlaceholders.has('test-server')).toBe(true);
    });

    it('should detect {{...}} placeholders in plain accessToken', async () => {
      // decryptPassword will throw (not encrypted), fallback to checking raw value
      mockDecryptPassword.mockImplementation(() => { throw new Error('Not encrypted'); });

      const config: McpServerConfig = {
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        accessToken: '{{my_access_token}}',
      };

      await (service as any).safeConnectToServer('token-server', config, 'token');

      expect((service as any).serversWithSecretPlaceholders.has('token-server')).toBe(true);
    });

    it('should detect {{...}} placeholders in encrypted accessToken', async () => {
      // Simulate encrypted token that decrypts to a placeholder
      mockDecryptPassword.mockReturnValue({ password: '{{clickup_access_token}}' });

      const config: McpServerConfig = {
        transport: 'streamable-http',
        url: 'https://mcp.clickup.com/mcp',
        accessToken: 'encrypted-ciphertext-base64',
      };

      await (service as any).safeConnectToServer('clickup-server', config, 'clickup');

      expect((service as any).serversWithSecretPlaceholders.has('clickup-server')).toBe(true);
    });

    it('should NOT detect placeholders in config with plain env values', async () => {
      const config: McpServerConfig = {
        transport: 'stdio',
        command: 'npx',
        args: ['some-server'],
        env: { NODE_ENV: 'production', API_KEY: 'actual-api-key-123' },
      };

      await (service as any).safeConnectToServer('plain-server', config, 'plain');

      // Should NOT be tracked as having placeholders (it will try to connect normally)
      expect((service as any).serversWithSecretPlaceholders.has('plain-server')).toBe(false);
    });

    it('should NOT detect placeholders in config with real accessToken', async () => {
      // Not encrypted, no placeholders
      mockDecryptPassword.mockImplementation(() => { throw new Error('Not encrypted'); });

      const config: McpServerConfig = {
        transport: 'sse',
        url: 'https://mcp.example.com/sse',
        accessToken: 'real-access-token-no-placeholders',
      };

      await (service as any).safeConnectToServer('real-server', config, 'real');

      expect((service as any).serversWithSecretPlaceholders.has('real-server')).toBe(false);
    });

    it('should handle config with no env and no accessToken', async () => {
      const config: McpServerConfig = {
        transport: 'sse',
        url: 'https://mcp.example.com/sse',
      };

      await (service as any).safeConnectToServer('no-secrets-server', config, 'noauth');

      expect((service as any).serversWithSecretPlaceholders.has('no-secrets-server')).toBe(false);
    });
  });

  describe('discoverToolsForUser', () => {
    it('should return 0 if no servers have placeholders', async () => {
      const count = await service.discoverToolsForUser('user-1', 'session-1');
      expect(count).toBe(0);
    });

    it('should attempt to connect to placeholder servers with user secrets', async () => {
      // Register a server with placeholders
      mockDecryptPassword.mockImplementation((val: string) => {
        if (val === 'encrypted-placeholder') return { password: '{{clickup_access_token}}' };
        if (val === 'encrypted-real-token') return { password: 'real-decrypted-token' };
        throw new Error('Unknown value');
      });

      const config: McpServerConfig = {
        transport: 'streamable-http',
        url: 'https://mcp.clickup.com/mcp',
        accessToken: 'encrypted-placeholder',
      };

      // Add the server config
      await (service as any).safeConnectToServer('clickup', config, 'clickup');
      expect((service as any).serversWithSecretPlaceholders.has('clickup')).toBe(true);

      // Mock user with secrets
      mockGetUserById.mockResolvedValue({
        userId: 'user-1',
        secrets: { clickup_access_token: 'encrypted-real-token' },
      });

      // discoverToolsForUser should call getSessionClient which resolves secrets
      // It will fail at the transport level (mocked), but should count the attempt
      const count = await service.discoverToolsForUser('user-1', 'session-1');
      expect(count).toBe(1);
      expect(mockGetUserById).toHaveBeenCalledWith('user-1');
    });

    it('should skip if user has no secrets', async () => {
      mockDecryptPassword.mockImplementation(() => { throw new Error('Not encrypted'); });

      const config: McpServerConfig = {
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        accessToken: '{{my_token}}',
      };

      await (service as any).safeConnectToServer('example', config, 'example');

      // User with no secrets
      mockGetUserById.mockResolvedValue({ userId: 'user-2', secrets: {} });

      // Should not throw, just warn and return 0
      const count = await service.discoverToolsForUser('user-2', 'session-2');
      expect(count).toBe(0);
    });
  });
});
