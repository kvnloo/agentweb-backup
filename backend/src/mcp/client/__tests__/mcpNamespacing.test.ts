
import { McpClientService } from '../mcpClientService';
import { settingsService } from '../../../services/settingsService';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { internalMcpServers } from '../mcp_config';

// Mock dependencies
jest.mock('../../../services/settingsService');
jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/sse.js');
jest.mock('@modelcontextprotocol/sdk/client/stdio.js');
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js');

// Mock the registry for internal server access
const mockRegistryExecute = jest.fn().mockResolvedValue({
  formattedContent: 'Success'
});

jest.mock('../../server/registry', () => ({
  mcpToolRegistry: {
    getToolDefinitions: () => [
      {
        name: 'search',
        description: 'Search tool (internal)',
        inputSchema: {}
      }
    ],
    execute: mockRegistryExecute
  }
}));

jest.mock('../../server/tools', () => ({}));

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
    mockRegistryExecute.mockClear();
    
    // Clear internalMcpServers
    Object.keys(internalMcpServers).forEach(key => delete (internalMcpServers as any)[key]);
    
    // Mock MCP Client for external servers
    (Client as jest.Mock).mockImplementation(() => ({
      connect: mockConnect,
      listTools: mockListTools,
      callTool: mockCallTool,
      close: jest.fn()
    }));

    mcpClientService = new McpClientService();
  });

  it('should load internal tools via direct registry and external tools with prefix via HTTP', async () => {
    // Set up internal server config (uses direct registry access)
    Object.assign(internalMcpServers, {
      'internal-server': {
        transport: 'streamable-http',
        url: 'http://localhost:3001/mcp',
        isInternal: true
      }
    });

    // Mock DB config (External - uses HTTP transport)
    (settingsService.getSetting as jest.Mock).mockResolvedValue({
      settingValue: JSON.stringify([
        {
          name: 'external-db-server',
          transport: 'stdio',
          command: 'node',
          args: ['db-server.js'],
          isInternal: false
        }
      ])
    });

    // Initialize
    await mcpClientService.initialize();

    const tools = mcpClientService.getTools();
    
    // We expect 2 tools:
    // 1. 'search' from internal-server (no prefix, loaded via registry)
    // 2. 'external-db-server_search' from external-db-server (prefixed, loaded via HTTP)
    
    // Verify tool names in registry
    const internalTool = tools.find(t => t.name === 'search');
    const externalTool = tools.find(t => t.name === 'external-db-server_search');

    expect(internalTool).toBeDefined();
    expect(externalTool).toBeDefined();

    // Verify definitions
    expect(internalTool?.definition.function.name).toBe('search');
    expect(externalTool?.definition.function.name).toBe('external-db-server_search');

    // Execute internal tool - should use direct registry with context as 3rd param
    await internalTool?.execute({}, { userId: '1', sessionId: '1', llmModel: 'gpt' } as any);
    expect(mockRegistryExecute).toHaveBeenCalledWith(
      'search',
      {},  // args is empty object
      expect.objectContaining({  // context is third parameter
        userId: '1',
        sessionId: '1',
        llmModel: 'gpt'
      })
    );

    mockCallTool.mockClear();

    // Execute external tool - should use HTTP client with original name
    await externalTool?.execute({}, { userId: '1', sessionId: '1', llmModel: 'gpt' } as any);
    expect(mockCallTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'search' // SHOULD be original name, NOT prefixed
    }), undefined, { timeout: 3600000 });
  });
});
