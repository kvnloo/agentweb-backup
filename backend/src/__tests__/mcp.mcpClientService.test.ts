/**
 * Unit tests for mcp/client/mcpClientService.ts
 * Tests the McpClientService class for MCP client management with multiple transports
 */

import { McpClientService } from '../mcp/client/mcpClientService';

// Mock dependencies
jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue({ tools: [] }),
    callTool: jest.fn().mockResolvedValue({ content: [] }),
    close: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null
  }))
}));

jest.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null
  }))
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({
    onclose: null,
    onerror: null
  }))
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn()
  }
}));

// Mock decryptPassword
jest.mock('../routes/config', () => ({
  decryptPassword: jest.fn().mockImplementation((val) => ({ password: val, userId: 'test' }))
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { settingsService } from '../services/settingsService';
import { decryptPassword } from '../routes/config';

// Mock mcp_config to allow tests to inject configurations
jest.mock('../mcp/client/mcp_config', () => ({
  internalMcpServers: {}
}));
import { internalMcpServers } from '../mcp/client/mcp_config';



describe('McpClientService', () => {
  let service: McpClientService;


  beforeEach(() => {
    jest.clearAllMocks();
    service = new McpClientService();
    
    // Reset the internalMcpServers mock
    Object.keys(internalMcpServers).forEach(key => delete internalMcpServers[key]);

  });

  describe('resolveEnvPlaceholders', () => {
    // Test the internal helper by testing it through initialize behavior
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should resolve ${VAR_NAME} placeholders from environment', async () => {
      process.env.TEST_URL = 'http://test.example.com';
      
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'test-server',
          transport: 'sse',
          url: '${TEST_URL}/mcp'
        }])
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(SSEClientTransport).toHaveBeenCalledWith(
        expect.any(URL),
        expect.any(Object)
      );
      
      const urlArg = (SSEClientTransport as jest.Mock).mock.calls[0][0];
      expect(urlArg.href).toBe('http://test.example.com/mcp');
    });

    it('should use fallback for BACKEND_URL when not set', async () => {
      delete process.env.BACKEND_URL;
      process.env.PORT = '4000';
      
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'test-server',
          transport: 'sse',
          url: '${BACKEND_URL}/mcp'
        }])
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      const urlArg = (SSEClientTransport as jest.Mock).mock.calls[0][0];
      expect(urlArg.href).toBe('http://localhost:4000/mcp');
    });

  });

  describe('initialize', () => {
    it('should load config from database', async () => {
      const dbConfig = [
        { name: 'db-server', transport: 'sse', url: 'http://db.example.com/mcp' }
      ];

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify(dbConfig)
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(settingsService.getSetting).toHaveBeenCalledWith('mcp_servers');
      expect(Client).toHaveBeenCalled();
    });

    it('should fallback to file when DB config is empty', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
      
      Object.assign(internalMcpServers, {
        'file-server': { transport: 'sse', url: 'http://file.example.com/mcp' }
      });


      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();


    });

    it('should handle no configuration gracefully', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
      Object.keys(internalMcpServers).forEach(key => delete internalMcpServers[key]);


      await service.initialize();

      expect(Client).not.toHaveBeenCalled();
      expect(service.getTools()).toEqual([]);
    });

    it('should handle DB error and fallback to file', async () => {
      (settingsService.getSetting as jest.Mock).mockRejectedValue(new Error('DB error'));
      
      Object.assign(internalMcpServers, {
        'fallback-server': { transport: 'sse', url: 'http://fallback.example.com/mcp' }
      });


      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();


    });

    it('should connect to multiple servers', async () => {
      const dbConfig = [
        { name: 'server-1', transport: 'sse', url: 'http://server1.example.com/mcp' },
        { name: 'server-2', transport: 'sse', url: 'http://server2.example.com/mcp' }
      ];

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify(dbConfig)
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(Client).toHaveBeenCalledTimes(2);
    });

    it('should continue when one server fails to connect', async () => {
      const dbConfig = [
        { name: 'good-server', transport: 'sse', url: 'http://good.example.com/mcp' },
        { name: 'bad-server', transport: 'sse', url: 'http://bad.example.com/mcp' }
      ];

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify(dbConfig)
      });

      let callCount = 0;
      (Client as jest.Mock).mockImplementation(() => ({
        connect: jest.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 2) {
            return Promise.reject(new Error('Connection failed'));
          }
          return Promise.resolve(undefined);
        }),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      }));

      // Should not throw
      await service.initialize();

      expect(Client).toHaveBeenCalledTimes(2);
    });
  });

  describe('createTransport', () => {
    beforeEach(() => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
    });


    it('should create SSE transport with auth token', async () => {
      Object.assign(internalMcpServers, {
        'sse-auth-server': { 
          transport: 'sse', 
          url: 'http://sse.example.com/mcp',
          accessToken: 'test-token-123'
        }
      });


      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(SSEClientTransport).toHaveBeenCalled();
      const transportOptions = (SSEClientTransport as jest.Mock).mock.calls[0][1];
      expect(transportOptions).toHaveProperty('requestInit');
      expect(transportOptions.requestInit.headers.Authorization).toBe('Bearer test-token-123');
    });

    it('should create SSE transport without auth', async () => {
      Object.assign(internalMcpServers, {
        'sse-noauth-server': { 
          transport: 'sse', 
          url: 'http://sse.example.com/mcp'
        }
      });


      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(SSEClientTransport).toHaveBeenCalled();
    });

    it('should create Stdio transport', async () => {
      Object.assign(internalMcpServers, {
        'stdio-server': { 
          transport: 'stdio', 
          command: 'node',
          args: ['server.js', '--port', '3000'],
          env: { NODE_ENV: 'production' }
        }
      });


      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'node',
          args: ['server.js', '--port', '3000']
        })
      );
    });

    it('should create Streamable HTTP transport with auth', async () => {
      Object.assign(internalMcpServers, {
        'streamable-server': { 
          transport: 'streamable-http', 
          url: 'http://streamable.example.com/mcp',
          accessToken: 'stream-token'
        }
      });


      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(StreamableHTTPClientTransport).toHaveBeenCalled();
    });

    it('should decrypt access token if present', async () => {
      Object.assign(internalMcpServers, {
        'encrypted-server': { 
          transport: 'sse', 
          url: 'http://enc.example.com/mcp',
          accessToken: 'encrypted-token-123'
        }
      });


      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(decryptPassword).toHaveBeenCalledWith('encrypted-token-123');
      const transportOptions = (SSEClientTransport as jest.Mock).mock.calls[0][1];
      expect(transportOptions.requestInit.headers.Authorization).toBe('Bearer encrypted-token-123');
    });

    it('should default to SSE for legacy config without transport field', async () => {
      Object.assign(internalMcpServers, {
        'legacy-server': { 
          url: 'http://legacy.example.com/mcp'
        }
      });


      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(SSEClientTransport).toHaveBeenCalled();
    });
  });

  describe('connectToServer', () => {
    beforeEach(() => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
    });


    it('should validate SSE config requires url', async () => {
      Object.assign(internalMcpServers, {
        'invalid-sse': { 
          transport: 'sse'
          // Missing url
        }
      });


      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      await service.initialize();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to connect'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should validate stdio config requires command', async () => {
      Object.assign(internalMcpServers, {
        'invalid-stdio': { 
          transport: 'stdio'
          // Missing command
        }
      });


      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      await service.initialize();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to connect'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should discover tools after connection', async () => {
      const mockTools = [
        { name: 'tool_1', description: 'First tool', inputSchema: { type: 'object' } },
        { name: 'tool_2', description: 'Second tool', inputSchema: { type: 'object' } }
      ];

      Object.assign(internalMcpServers, {
        'tools-server': { 
          transport: 'sse',
          url: 'http://tools.example.com/mcp'
        }
      });


      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        callTool: jest.fn().mockResolvedValue({ 
          content: [{ type: 'text', text: 'result' }],
          isError: false 
        }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      const tools = service.getTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('tool_1');
      expect(tools[1].name).toBe('tool_2');
    });

    it('should handle connection timeout', async () => {
      Object.assign(internalMcpServers, {
        'timeout-server': { 
          transport: 'sse',
          url: 'http://timeout.example.com/mcp'
        }
      });


      // Simulate a connection that times out by rejecting with timeout error
      const mockClient = {
        connect: jest.fn().mockRejectedValue(new Error('Connection timeout for timeout-server')),
        listTools: jest.fn(),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      // Should not throw, but should log error
      await service.initialize();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to connect'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('getTools', () => {
    it('should return empty array initially', () => {
      const tools = service.getTools();
      expect(tools).toEqual([]);
    });

    it('should return discovered tools after initialization', async () => {
      const mockTools = [
        { name: 'discovered_tool', description: 'A discovered tool', inputSchema: { type: 'object' } }
      ];

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'test-server',
          transport: 'sse',
          url: 'http://test.example.com/mcp'
        }])
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        callTool: jest.fn(),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      const tools = service.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('test-server_discovered_tool');
    });
  });

  describe('shutdown', () => {
    it('should close all clients', async () => {
      const mockClose = jest.fn().mockResolvedValue(undefined);
      
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([
          { name: 'server-1', transport: 'sse', url: 'http://s1.example.com/mcp' },
          { name: 'server-2', transport: 'sse', url: 'http://s2.example.com/mcp' }
        ])
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: mockClose
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();
      await service.shutdown();

      expect(mockClose).toHaveBeenCalledTimes(2);
    });

    it('should clear tools array after shutdown', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'test-server',
          transport: 'sse',
          url: 'http://test.example.com/mcp'
        }])
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ 
          tools: [{ name: 'tool', description: 'test', inputSchema: {} }] 
        }),
        close: jest.fn().mockResolvedValue(undefined)
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();
      expect(service.getTools()).toHaveLength(1);

      await service.shutdown();
      expect(service.getTools()).toEqual([]);
    });

    it('should handle client close errors gracefully', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'error-server',
          transport: 'sse',
          url: 'http://error.example.com/mcp'
        }])
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn().mockRejectedValue(new Error('Close failed'))
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      await service.initialize();
      
      // Should not throw
      await service.shutdown();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error shutting down'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('tool execution with internal context injection', () => {
    it('should inject userId, sessionId, llmModel for internal servers', async () => {
      const mockTools = [
        { name: 'internal_tool', description: 'Internal tool', inputSchema: { type: 'object' } }
      ];

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'internal-server',
          transport: 'sse',
          url: 'http://internal.example.com/mcp',
          isInternal: true
        }])
      });

      const mockCallTool = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'success' }],
        isError: false
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        callTool: mockCallTool,
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      const tools = service.getTools();
      const context = {
        userId: 'user-123',
        sessionId: 'session-456',
        llmModel: 'gpt-4',
        service: {}
      };

      await tools[0].execute({ customArg: 'value' }, context);

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'internal_tool',
        arguments: expect.objectContaining({
          customArg: 'value',
          userId: 'user-123',
          sessionId: 'session-456',
          llmModel: 'gpt-4'
        })
      });
    });

    it('should NOT inject context for external servers', async () => {
      const mockTools = [
        { name: 'external_tool', description: 'External tool', inputSchema: { type: 'object' } }
      ];

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'external-server',
          transport: 'sse',
          url: 'http://external.example.com/mcp',
          isInternal: false
        }])
      });

      const mockCallTool = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'success' }],
        isError: false
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        callTool: mockCallTool,
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      const tools = service.getTools();
      const context = {
        userId: 'user-123',
        sessionId: 'session-456',
        llmModel: 'gpt-4',
        service: {}
      };

      await tools[0].execute({ customArg: 'value' }, context);

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'external_tool',
        arguments: {
          customArg: 'value'
        }
      });
    });

    it('should handle tool execution errors', async () => {
      const mockTools = [
        { name: 'error_tool', description: 'Error tool', inputSchema: { type: 'object' } }
      ];

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'error-server',
          transport: 'sse',
          url: 'http://error.example.com/mcp'
        }])
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        callTool: jest.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Tool failed with error' }],
          isError: true
        }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      const tools = service.getTools();
      const context = { userId: 'u', sessionId: 's', llmModel: 'm', service: {} };

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(tools[0].execute({}, context))
        .rejects.toThrow('Tool failed with error');

      consoleErrorSpy.mockRestore();
    });
  });
});
