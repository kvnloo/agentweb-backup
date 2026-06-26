
import { error } from 'console';
import { McpClientService } from '../mcpClientService';
import { settingsService } from '../../../services/settingsService';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Mock dependencies
jest.mock('../../../services/settingsService');
jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/sse.js');
jest.mock('@modelcontextprotocol/sdk/client/stdio.js');
jest.mock('../mcp_config', () => ({
  internalMcpServers: {}
}));

import { internalMcpServers } from '../mcp_config';

describe('McpClientService Tool Namespacing', () => {
  let mcpClientService: McpClientService;
  
  const mockCallTool = jest.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'Success' }],
    isError: false
  });
  const mockConnect = jest.fn().mockResolvedValue(undefined);
  const mockListTools = jest.fn().mockResolvedValue({
    tools: [
      {
        name: 'search',
        description: 'Search tool',
        inputSchema: {}
      }
    ]
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock MCP Client
    (Client as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      listTools: mockListTools,
      callTool: mockCallTool,
      close: jest.fn()
    }));

    // Mock StdioClientTransport
    (StdioClientTransport as jest.Mock).mockImplementation(() => ({
      onclose: null,
      onerror: null
    }));

    // Reset internalMcpServers
    Object.keys(internalMcpServers).forEach(key => delete internalMcpServers[key]);

    mcpClientService = new McpClientService();
  });

  it('should load file config tools without prefix and DB config tools with prefix', async () => {
    // Set up internal servers (no prefix) - loaded from file config
    // Note: isInternal flag is NOT set here because isInternal:true servers
    // are now skipped during initialization (they self-connect and create circular deps).
    // This test verifies the file-config vs DB-config namespacing behavior.
    Object.assign(internalMcpServers, {
      'internal-server': {
        transport: 'stdio',
        command: 'node',
        args: ['server.js']
      }
    });

    // Mock DB config (External - with prefix)
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: JSON.stringify([
        {
          name: 'external-db-server',
          transport: 'stdio',
          command: 'node',
          args: ['db-server.js']
        }
      ])
    });

    // Initialize
    await mcpClientService.initialize();

    const tools = mcpClientService.getTools();
    
    // We expect 2 tools:
    // 1. 'search' from internal-server (no prefix)
    // 2. 'external-db-server_search' from external-db-server (prefixed)
    
    // Verify tool names in registry
    const internalTool = tools.find(t => t.name === 'search');
    const externalTool = tools.find(t => t.name === 'external-db-server_search');

    expect(internalTool).toBeDefined();
    expect(externalTool).toBeDefined();

    // Verify definitions
    expect(internalTool?.definition.function.name).toBe('search');
    expect(externalTool?.definition.function.name).toBe('external-db-server_search');

    // Verify execution calls original name
    
    // Execute internal tool
    await internalTool?.execute({}, { userId: '1', sessionId: '1', llmModel: 'gpt' } as any);
    expect(mockCallTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'search'
    }), undefined, { timeout: 3600000 });

    mockCallTool.mockClear();

    // Execute external tool
    await externalTool?.execute({}, { userId: '1', sessionId: '1', llmModel: 'gpt' } as any);
    expect(mockCallTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'search' // SHOULD be original name, NOT prefixed
    }), undefined, { timeout: 3600000 });
  });

  it('should NOT expose tools from a server flagged excludeFromAgent (backend-only)', async () => {
    // higgsfield is used directly by the backend video service (its own client +
    // getServerConfig), so its 40+ tools must NOT leak into Emma's agent toolset.
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: JSON.stringify([
        {
          name: 'higgsfield',
          transport: 'streamable-http',
          url: 'https://mcp.higgsfield.ai/mcp',
          authType: 'oauth',
          excludeFromAgent: true,
        },
        {
          name: 'visible-server',
          transport: 'stdio',
          command: 'node',
          args: ['s.js'],
        },
      ]),
    });

    await mcpClientService.initialize();
    const tools = mcpClientService.getTools();

    // Backend-only server: none of its tools registered (and connect never attempted)
    expect(tools.find(t => t.name.startsWith('higgsfield_'))).toBeUndefined();
    // A normal DB server alongside it is still exposed (prefixed)
    expect(tools.find(t => t.name === 'visible-server_search')).toBeDefined();
  });
});
