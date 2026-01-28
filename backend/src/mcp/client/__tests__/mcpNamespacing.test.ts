
import { error } from 'console';
import { McpClientService } from '../mcpClientService';
import { settingsService } from '../../../services/settingsService';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import fs from 'fs';

// Mock dependencies
jest.mock('../../../services/settingsService');
jest.mock('fs');
jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/sse.js');
jest.mock('@modelcontextprotocol/sdk/client/stdio.js');

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

    mcpClientService = new McpClientService();
  });

  it('should load file config tools without prefix and DB config tools with prefix', async () => {
    // Mock file config (Internal)
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({
      mcpServers: {
        'internal-server': {
          transport: 'stdio',
          command: 'node',
          args: ['server.js']
        }
      }
    }));

    // Mock DB config (External)
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
});
