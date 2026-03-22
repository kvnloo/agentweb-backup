/**
 * Unit tests for Playwright MCP auto-configuration in mcpClientService.
 * Verifies that --headless and --no-sandbox flags are automatically injected
 * for Playwright MCP servers in createStdioTransport.
 */

// Set env before any imports
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

// Capture StdioClientTransport constructor calls
const mockStdioConstructor = jest.fn().mockImplementation(() => ({
  onclose: null,
  onerror: null,
}));

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue({ tools: [] }),
    callTool: jest.fn().mockResolvedValue({ content: [] }),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: mockStdioConstructor,
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null,
  })),
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
  },
}));

jest.mock('../utils/crypto', () => ({
  decryptPassword: jest.fn().mockImplementation((val) => ({ password: val, userId: 'test' })),
}));

jest.mock('../mcp/client/mcp_config', () => ({
  internalMcpServers: {},
}));

jest.mock('axios', () => {
  const mockedSdk = jest.fn();
  (mockedSdk as any).isAxiosError = jest.fn().mockReturnValue(false);
  return mockedSdk;
});

import { McpClientService } from '../mcp/client/mcpClientService';
import { internalMcpServers } from '../mcp/client/mcp_config';

describe('McpClientService - Playwright MCP auto-configuration', () => {
  let service: McpClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear internalMcpServers between tests
    for (const key of Object.keys(internalMcpServers)) {
      delete (internalMcpServers as any)[key];
    }
    service = new McpClientService();
  });

  it('should inject --headless, --no-sandbox, and anti-detection args for Playwright MCP server', async () => {
    (internalMcpServers as any)['playwright'] = {
      transport: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      isInternal: false,
    };

    await service.initialize();

    expect(mockStdioConstructor).toHaveBeenCalledTimes(1);
    const callArgs = mockStdioConstructor.mock.calls[0][0];
    expect(callArgs.command).toBe('npx');
    expect(callArgs.args).toContain('@playwright/mcp@latest');
    expect(callArgs.args).toContain('--headless');
    expect(callArgs.args).toContain('--no-sandbox');
    // Anti-headless detection args
    expect(callArgs.args).toContain('--launch-options');
    const launchOptionsIdx = callArgs.args.indexOf('--launch-options');
    const launchOptions = JSON.parse(callArgs.args[launchOptionsIdx + 1]);
    expect(launchOptions.args).toContain('--disable-blink-features=AutomationControlled');
  });

  it('should NOT inject flags for non-Playwright MCP servers', async () => {
    (internalMcpServers as any)['other-server'] = {
      transport: 'stdio',
      command: 'npx',
      args: ['@some/other-mcp@latest'],
      isInternal: false,
    };

    await service.initialize();

    expect(mockStdioConstructor).toHaveBeenCalledTimes(1);
    const callArgs = mockStdioConstructor.mock.calls[0][0];
    expect(callArgs.args).not.toContain('--headless');
    expect(callArgs.args).not.toContain('--no-sandbox');
  });

  it('should NOT duplicate flags if already present', async () => {
    (internalMcpServers as any)['playwright'] = {
      transport: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest', '--headless', '--no-sandbox'],
      isInternal: false,
    };

    await service.initialize();

    expect(mockStdioConstructor).toHaveBeenCalledTimes(1);
    const callArgs = mockStdioConstructor.mock.calls[0][0];
    const headlessCount = callArgs.args.filter((a: string) => a === '--headless').length;
    const noSandboxCount = callArgs.args.filter((a: string) => a === '--no-sandbox').length;
    expect(headlessCount).toBe(1);
    expect(noSandboxCount).toBe(1);
  });

  it('should NOT inject --launch-options if already provided', async () => {
    const customOptions = JSON.stringify({ args: ['--custom-flag'] });
    (internalMcpServers as any)['playwright'] = {
      transport: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest', '--launch-options', customOptions],
      isInternal: false,
    };

    await service.initialize();

    expect(mockStdioConstructor).toHaveBeenCalledTimes(1);
    const callArgs = mockStdioConstructor.mock.calls[0][0];
    const launchOptionsCount = callArgs.args.filter((a: string) => a === '--launch-options').length;
    expect(launchOptionsCount).toBe(1);
    // Should keep the custom options, not override
    const launchOptionsIdx = callArgs.args.indexOf('--launch-options');
    expect(callArgs.args[launchOptionsIdx + 1]).toBe(customOptions);
  });
});
