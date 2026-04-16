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
jest.mock('../utils/crypto', () => ({
  decryptPassword: jest.fn().mockImplementation((val) => ({ password: val, userId: 'test' }))
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { settingsService } from '../services/settingsService';
import { decryptPassword } from '../utils/crypto';

// Mock mcp_config to allow tests to inject configurations
jest.mock('../mcp/client/mcp_config', () => ({
  internalMcpServers: {}
}));
import { internalMcpServers } from '../mcp/client/mcp_config';

// Mock axios
const mockAxios = jest.fn();
jest.mock('axios', () => {
    // Return a mock function that also has properties (like create, isAxiosError)
    const mockedSdk = jest.fn((...args) => mockAxios(...args));
    (mockedSdk as any).isAxiosError = jest.fn().mockReturnValue(false);
    return mockedSdk;
});



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
      }, undefined, { timeout: 3600000 });
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
      }, undefined, { timeout: 3600000 });
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

  describe('Session Validation for Streamable HTTP', () => {
    beforeEach(() => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
    });

    it('should validate session ID is established after connection for streamable-http', async () => {
      Object.assign(internalMcpServers, {
        'streamable-validated': {
          transport: 'streamable-http',
          url: 'http://validated.example.com/mcp'
        }
      });

      const mockTransport = {
        onclose: null,
        onerror: null,
        sessionId: 'test-session-123' // Session ID is set
      };

      (StreamableHTTPClientTransport as jest.Mock).mockImplementation(() => mockTransport);

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      // Should not throw
      await service.initialize();

      expect(StreamableHTTPClientTransport).toHaveBeenCalled();
      expect(mockClient.connect).toHaveBeenCalled();
    });

    it('should log warning but continue when session ID is not established for streamable-http', async () => {
      Object.assign(internalMcpServers, {
        'streamable-no-session': {
          transport: 'streamable-http',
          url: 'http://nosession.example.com/mcp'
        }
      });

      const mockTransport = {
        onclose: null,
        onerror: null,
        sessionId: undefined // No session ID
      };

      (StreamableHTTPClientTransport as jest.Mock).mockImplementation(() => mockTransport);

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      await service.initialize();

      // Should log warning but continue
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Session ID not detected for streamable-no-session')
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('will try to proceed anyway')
      );

      // Should still attempt to list tools despite missing session ID
      expect(mockClient.listTools).toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    it('should not validate session for SSE transport', async () => {
      Object.assign(internalMcpServers, {
        'sse-no-validation': {
          transport: 'sse',
          url: 'http://sse.example.com/mcp'
        }
      });

      const mockTransport = {
        onclose: null,
        onerror: null
        // No sessionId property for SSE
      };

      (SSEClientTransport as jest.Mock).mockImplementation(() => mockTransport);

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      // Should not throw, session validation only for streamable-http
      await service.initialize();

      expect(SSEClientTransport).toHaveBeenCalled();
      expect(mockClient.connect).toHaveBeenCalled();
    });

    it('should wait 500ms before validating session ID', async () => {
      Object.assign(internalMcpServers, {
        'streamable-wait': {
          transport: 'streamable-http',
          url: 'http://wait.example.com/mcp'
        }
      });

      const mockTransport: any = {
        onclose: null,
        onerror: null,
        sessionId: undefined // Initially undefined
      };

      // Simulate session ID being set after 300ms
      setTimeout(() => {
        mockTransport.sessionId = 'delayed-session-id';
      }, 300);

      (StreamableHTTPClientTransport as jest.Mock).mockImplementation(() => mockTransport);

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      // Should succeed because the 500ms wait gives time for sessionId to be set
      await service.initialize();

      expect(mockTransport.sessionId).toBe('delayed-session-id');
      expect(mockClient.listTools).toHaveBeenCalled();
    });
  });

  describe('Session-Based Client Pooling', () => {
    beforeEach(() => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
    });

    it('should create isolated MCP client for each chat session', async () => {
      Object.assign(internalMcpServers, {
        'test-server': { transport: 'streamable-http', url: 'http://test.example.com/mcp' }
      });

      let clientCount = 0;
      (StreamableHTTPClientTransport as jest.Mock).mockImplementation(() => {
        clientCount++;
        return {
          onclose: null,
          onerror: null,
          sessionId: `mcp-session-${clientCount}`
        };
      });

      (Client as jest.Mock).mockImplementation(() => {
        const currentCount = clientCount;
        return {
          connect: jest.fn().mockResolvedValue(undefined),
          listTools: jest.fn().mockResolvedValue({ tools: [] }),
          close: jest.fn(),
          _transport: { sessionId: `mcp-session-${currentCount}` }
        };
      });

      await service.initialize();

      // Get clients for two different sessions
      const client1 = await (service as any).getSessionClient('test-server', 'session-1');
      const client2 = await (service as any).getSessionClient('test-server', 'session-2');

      expect(client1._transport.sessionId).toBe('mcp-session-2');
      expect(client2._transport.sessionId).toBe('mcp-session-3');
      expect(client1).not.toBe(client2);
    });

    it('should reuse client for same chat session', async () => {
      Object.assign(internalMcpServers, {
        'test-server': { transport: 'streamable-http', url: 'http://test.example.com/mcp' }
      });

      const mockTransport = { onclose: null, onerror: null, sessionId: 'mcp-session-1' };
      (StreamableHTTPClientTransport as jest.Mock).mockImplementation(() => mockTransport);

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn(),
        _transport: mockTransport
      };

      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      // Get client twice for same session
      const client1 = await (service as any).getSessionClient('test-server', 'session-1');
      const client2 = await (service as any).getSessionClient('test-server', 'session-1');

      expect(client1).toBe(client2);
      expect(Client).toHaveBeenCalledTimes(2); // Once for init, once for session
    });

    it('should release all clients for a session', async () => {
      Object.assign(internalMcpServers, {
        'test-server': { transport: 'streamable-http', url: 'http://test.example.com/mcp' }
      });

      const mockTransport = { onclose: null, onerror: null, sessionId: 'mcp-session-1' };
      (StreamableHTTPClientTransport as jest.Mock).mockImplementation(() => mockTransport);

      const mockClose = jest.fn().mockResolvedValue(undefined);
      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: mockClose,
        _transport: mockTransport
      };

      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      await (service as any).getSessionClient('test-server', 'session-1');
      await service.releaseSessionClients('session-1');

      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle releasing non-existent session gracefully', async () => {
      await service.initialize();

      // Should not throw
      await service.releaseSessionClients('non-existent-session');
    });

    it('should use session-specific client in tool execution', async () => {
      const mockTools = [
        { name: 'test_tool', description: 'Test tool', inputSchema: { type: 'object' } }
      ];

      // Use DB config path since internal servers with isInternal:true are now skipped
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'test-server',
          transport: 'streamable-http',
          url: 'http://test.example.com/mcp',
          isInternal: true
        }])
      });

      const mockCallTool = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'result' }],
        isError: false
      });

      let clientCount = 0;
      (StreamableHTTPClientTransport as jest.Mock).mockImplementation(() => {
        clientCount++;
        return {
          onclose: null,
          onerror: null,
          sessionId: `mcp-session-${clientCount}`
        };
      });

      (Client as jest.Mock).mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        callTool: mockCallTool,
        close: jest.fn(),
        _transport: { sessionId: `mcp-session-${clientCount}` }
      }));

      await service.initialize();

      const tools = service.getTools();

      // Execute tool with different sessions
      const context1 = { userId: 'u1', sessionId: 'chat-session-1', llmModel: 'm', service: {} };
      const context2 = { userId: 'u2', sessionId: 'chat-session-2', llmModel: 'm', service: {} };

      await tools[0].execute({ arg: 'val1' }, context1);
      await tools[0].execute({ arg: 'val2' }, context2);

      // Should have called tool twice (once per session)
      expect(mockCallTool).toHaveBeenCalledTimes(2);
      expect(mockCallTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'test_tool' }),
        undefined,
        { timeout: 3600000 }
      );
    });

    it('should have cleanup interval configured', async () => {
      // Just verify the service sets up cleanup - detailed timer testing is complex
      await service.initialize();

      // Verify cleanup interval exists in service (implementation detail)
      const cleanupInterval = (service as any).cleanupInterval;
      expect(cleanupInterval).toBeDefined();

      await service.shutdown();
    });
  });

  describe('Streamable Http Custom Fetch (Axios Adapter)', () => {
    beforeEach(() => {
      mockAxios.mockReset();
      mockAxios.mockResolvedValue({
        data: Buffer.from('test data'),
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
    });

    it('should inject custom fetch into transport', async () => {
      Object.assign(internalMcpServers, {
        'http-server': { transport: 'streamable-http', url: 'http://test.example.com' }
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(StreamableHTTPClientTransport).toHaveBeenCalled();
      const options = (StreamableHTTPClientTransport as jest.Mock).mock.calls[0][1];
      expect(options).toHaveProperty('fetch');
      expect(typeof options.fetch).toBe('function');
    });

    it('should sanitize headers and set infinite timeout', async () => {
      Object.assign(internalMcpServers, {
        'http-server': { transport: 'streamable-http', url: 'http://test.example.com' }
      });

      // Capture the custom fetch function
      let capturedFetch: any;
      (StreamableHTTPClientTransport as jest.Mock).mockImplementation((url, opts) => {
        capturedFetch = opts?.fetch;
        return { onclose: null, onerror: null };
      });

      const mockClient = { connect: jest.fn(), listTools: jest.fn(), close: jest.fn() };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(capturedFetch).toBeDefined();

      // Invoke the custom fetch with various messy headers
      const dirtyHeaders = {
        'Content-Length': 123, // Number
        'X-Nullable': null,    // Null
        'X-Undefined': undefined, // Undefined
        'X-String': 'valid'    // String
      };

      await capturedFetch('http://test.example.com', {
        method: 'POST',
        headers: dirtyHeaders,
        body: 'test'
      });

      // Verify axios call arguments
      expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({
        url: 'http://test.example.com',
        method: 'POST',
        timeout: 0, // CRITICAL VERIFICATION
        headers: expect.objectContaining({
            'Content-Length': '123', // Should be stringified
            'X-String': 'valid'
        })
      }));

      // Null/Undefined should be filtered out or handled safely (implementation specific)
      // Our implementation filters them out in the Object.entries loop
      const callArgs = mockAxios.mock.calls[0][0];
      expect(callArgs.headers).not.toHaveProperty('X-Nullable');
      expect(callArgs.headers).not.toHaveProperty('X-Undefined');
    });

    it('should handle Headers object correctly', async () => {
       Object.assign(internalMcpServers, { 'http-server': { transport: 'streamable-http', url: 'http://test.example.com' } });
       
       let capturedFetch: any;
       (StreamableHTTPClientTransport as jest.Mock).mockImplementation((url, opts) => {
         capturedFetch = opts?.fetch;
         return { onclose: null, onerror: null };
       });
       (Client as jest.Mock).mockImplementation(() => ({ connect: jest.fn(), listTools: jest.fn(), close: jest.fn() }));

       await service.initialize();

       const headersObj = new Headers();
       headersObj.set('X-Custom', 'value');
       
       await capturedFetch('http://test.example.com', { headers: headersObj });

       expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({
          headers: expect.objectContaining({ 'x-custom': 'value' })
       }));
    });
  });

  describe('circuit breaker', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should open circuit after threshold failures and throw immediately without connecting', async () => {
      // Configure a server via DB
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'flaky-server',
          transport: 'sse',
          url: 'http://flaky.example.com/mcp'
        }])
      });

      const mockTools = [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }];
      // Call 1 (connectToServer during init) succeeds; subsequent session-level connects fail.
      // The circuit breaker only tracks failures from getSessionClient, not the init connect.
      let connectCallCount = 0;
      const mockClient = {
        connect: jest.fn().mockImplementation(() => {
          connectCallCount++;
          if (connectCallCount === 1) return Promise.resolve(); // init connection succeeds
          return Promise.reject(new Error('Connection timeout for flaky-server')); // session connects fail
        }),
        listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        callTool: jest.fn(),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();
      const tools = service.getTools();
      expect(tools).toHaveLength(1);

      const context = { userId: 'user1', sessionId: 'sess1', llmModel: 'test', service: null };

      // Calls 1–3: real session connect attempts (connectCallCount goes 2, 3, 4)
      await expect(tools[0].execute({}, context)).rejects.toThrow('Connection timeout for flaky-server');
      await expect(tools[0].execute({}, context)).rejects.toThrow('Connection timeout for flaky-server');
      await expect(tools[0].execute({}, context)).rejects.toThrow('Connection timeout for flaky-server');

      const connectCountAfterThreshold = connectCallCount;

      // Call 4: circuit is now open — should fail immediately without calling connect()
      await expect(tools[0].execute({}, context)).rejects.toThrow('service temporarily unavailable');
      expect(connectCallCount).toBe(connectCountAfterThreshold); // no new connect attempt
    });

    it('should close circuit after cooldown and allow reconnection', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'recover-server',
          transport: 'sse',
          url: 'http://recover.example.com/mcp'
        }])
      });

      // First connect (init) always succeeds; session connects fail until shouldFail = false
      let sessionConnectShouldFail = true;
      let connectCallCount = 0;
      const mockClient = {
        connect: jest.fn().mockImplementation(() => {
          connectCallCount++;
          if (connectCallCount === 1) return Promise.resolve(); // init succeeds
          return sessionConnectShouldFail
            ? Promise.reject(new Error('Connection timeout for recover-server'))
            : Promise.resolve();
        }),
        listTools: jest.fn().mockResolvedValue({ tools: [{ name: 'tool', description: 'tool', inputSchema: {} }] }),
        callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], isError: false }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();
      const tools = service.getTools();
      expect(tools).toHaveLength(1);
      const context = { userId: 'userA', sessionId: 'sessA', llmModel: 'test', service: null };

      // Exhaust threshold (default 3) to open circuit
      for (let i = 0; i < 3; i++) {
        await expect(tools[0].execute({}, context)).rejects.toThrow('Connection timeout');
      }
      // Circuit is open now
      await expect(tools[0].execute({}, context)).rejects.toThrow('service temporarily unavailable');

      // Advance time past cooldown (default 5 minutes)
      jest.advanceTimersByTime(5 * 60 * 1000 + 1000);
      sessionConnectShouldFail = false;

      // After cooldown, the tool should succeed
      const result = await tools[0].execute({}, context);
      expect(result).toEqual(expect.objectContaining({ content: 'ok' }));
    });
  });

  describe('dead client eviction on callTool connection error', () => {
    it('should evict stale client from session pool when callTool fails with connection error', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'evict-server',
          transport: 'sse',
          url: 'http://evict.example.com/mcp'
        }])
      });

      const mockTools = [{ name: 'do_thing', description: 'Does a thing', inputSchema: { type: 'object' } }];
      let callToolCount = 0;
      const mockClient = {
        // connect() is called once during init (connectToServer) + once per getSessionClient
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        callTool: jest.fn().mockImplementation(() => {
          callToolCount++;
          if (callToolCount === 1) {
            // First callTool: transport dies mid-session
            return Promise.reject(new Error('Connection timeout for evict-server'));
          }
          // Subsequent calls (on fresh client after eviction): succeed
          return Promise.resolve({ content: [{ type: 'text', text: 'success' }], isError: false });
        }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();
      const tools = service.getTools();
      const context = { userId: 'user-evict', sessionId: 'sess-evict', llmModel: 'test', service: null };

      // First execute fails with connection error — dead client should be evicted
      await expect(tools[0].execute({}, context)).rejects.toThrow('Connection timeout');

      // Second execute: new client is created (eviction worked), succeeds
      const result = await tools[0].execute({}, context);
      expect(result).toEqual(expect.objectContaining({ content: 'success' }));
      // connect() called: once during init + once during first getSessionClient + once after eviction = 3
      expect(mockClient.connect).toHaveBeenCalledTimes(3);
    });

    it('should NOT evict client on non-connection errors (tool logic errors)', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([{
          name: 'logic-error-server',
          transport: 'sse',
          url: 'http://logic.example.com/mcp'
        }])
      });

      const mockTools = [{ name: 'logic_tool', description: 'Logic tool', inputSchema: { type: 'object' } }];
      let connectCallCount = 0;
      const mockClient = {
        connect: jest.fn().mockImplementation(() => { connectCallCount++; return Promise.resolve(); }),
        listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        callTool: jest.fn().mockRejectedValue(new Error('Invalid query parameter')),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();
      const tools = service.getTools();
      const context = { userId: 'user-logic', sessionId: 'sess-logic', llmModel: 'test', service: null };

      // Two calls with a logic error — both fail but no client eviction
      await expect(tools[0].execute({}, context)).rejects.toThrow('Invalid query parameter');
      await expect(tools[0].execute({}, context)).rejects.toThrow('Invalid query parameter');

      // connect() called: once during init + once on first getSessionClient = 2
      // Second execute reuses the pooled client (not evicted) → no additional connect
      expect(connectCallCount).toBe(2);
    });
  });
});
