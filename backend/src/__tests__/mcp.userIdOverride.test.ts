/**
 * Tests for MCP IDOR fix: external clients must NOT be able to override userId
 * via tool call arguments. Only internal clients (MCP_ACCESS_TOKEN) may do so.
 *
 * Regression test for: https://github.com/AgentWebPro/agentweb/pull/new/rui/test-agentweb-mcp
 */

import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Capture the CallToolRequest handler when it's registered
let callToolHandler: ((request: any) => Promise<any>) | null = null;

// Mock MCP SDK
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    server: {
      setRequestHandler: jest.fn().mockImplementation((schema: any, handler: any) => {
        if (schema === CallToolRequestSchema) {
          callToolHandler = handler;
        }
      }),
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      onerror: null,
    }
  }))
}));

jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn()
}));

jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));

// Mock the tool registry to capture what userId is passed
const mockExecute = jest.fn().mockResolvedValue({ success: true });
jest.mock('../mcp/server/registry', () => ({
  mcpToolRegistry: {
    getToolDefinitions: jest.fn().mockReturnValue([]),
    execute: (...args: any[]) => mockExecute(...args),
  }
}));

jest.mock('../mcp/server/apiTools', () => ({}));
// ENG-982 added a second registering module to mcpServerCore's import chain.
// Stubbed for the same reason as apiTools: this suite exercises the IDOR
// dispatch, not tool registration, and the registry above is a partial mock
// with no `register`.
jest.mock('../mcp/server/workflowTools', () => ({}));

import { createMcpServer, McpSessionContext } from '../mcp/server/mcpServerCore';

describe('MCP userId override protection (IDOR fix)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    callToolHandler = null;
  });

  function setupServer(sessionContext: McpSessionContext) {
    createMcpServer('test-server', sessionContext);
    expect(callToolHandler).not.toBeNull();
    return callToolHandler!;
  }

  function makeToolRequest(toolName: string, args: Record<string, any>) {
    return { params: { name: toolName, arguments: args } };
  }

  describe('External client (API key auth, isInternal=false)', () => {
    it('should use authenticated agentUserId, ignoring caller-supplied userId', async () => {
      const handler = setupServer({
        agentUserId: 'real-user-123',
        isInternal: false,
      });

      await handler(makeToolRequest('list_knowledge_base_files', {
        userId: 'victim-user-456',
      }));

      expect(mockExecute).toHaveBeenCalledWith(
        'list_knowledge_base_files',
        {},  // userId stripped from toolArgs
        expect.objectContaining({ userId: 'real-user-123' }),
      );
    });

    it('should use agentUserId even when no userId is passed in args', async () => {
      const handler = setupServer({
        agentUserId: 'real-user-123',
        isInternal: false,
      });

      await handler(makeToolRequest('search_knowledge_base', {
        query: 'test',
      }));

      expect(mockExecute).toHaveBeenCalledWith(
        'search_knowledge_base',
        { query: 'test' },
        expect.objectContaining({ userId: 'real-user-123' }),
      );
    });

    it('should not allow userId override even when isInternal is undefined', async () => {
      const handler = setupServer({
        agentUserId: 'real-user-123',
        // isInternal not set (defaults to undefined/falsy)
      });

      await handler(makeToolRequest('get_lead_lists', {
        userId: 'victim-user-456',
      }));

      expect(mockExecute).toHaveBeenCalledWith(
        'get_lead_lists',
        {},
        expect.objectContaining({ userId: 'real-user-123' }),
      );
    });
  });

  describe('Internal client (MCP_ACCESS_TOKEN, isInternal=true)', () => {
    it('should allow userId override for internal clients', async () => {
      const handler = setupServer({
        agentUserId: 'backend-service',
        isInternal: true,
      });

      await handler(makeToolRequest('list_knowledge_base_files', {
        userId: 'target-user-789',
      }));

      expect(mockExecute).toHaveBeenCalledWith(
        'list_knowledge_base_files',
        {},
        expect.objectContaining({ userId: 'target-user-789' }),
      );
    });

    it('should fall back to agentUserId when internal client does not pass userId', async () => {
      const handler = setupServer({
        agentUserId: 'backend-service',
        isInternal: true,
      });

      await handler(makeToolRequest('list_knowledge_base_files', {}));

      expect(mockExecute).toHaveBeenCalledWith(
        'list_knowledge_base_files',
        {},
        expect.objectContaining({ userId: 'backend-service' }),
      );
    });
  });

  describe('sessionId override protection', () => {
    it('should prefer session context sessionId over caller-supplied sessionId for external clients', async () => {
      const handler = setupServer({
        agentUserId: 'real-user-123',
        sessionId: 'real-session-abc',
        isInternal: false,
      });

      await handler(makeToolRequest('some_tool', {
        sessionId: 'fake-session-xyz',
      }));

      expect(mockExecute).toHaveBeenCalledWith(
        'some_tool',
        {},
        expect.objectContaining({ sessionId: 'real-session-abc' }),
      );
    });
  });
});
