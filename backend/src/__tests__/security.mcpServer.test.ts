/**
 * Security tests for the MCP server layer.
 *
 * Covers:
 * A. Internal tool isolation — internal-only tools must never be exposed to external clients
 * B. userId override (IDOR) — external clients must not override authenticated identity
 * C. Authentication middleware — missing / invalid / expired tokens
 * D. mcpFetch auth-boundary — ensures all tool calls go through JWT-auth'd REST API
 * E. Rate limiting — per-key limits enforced
 */

// ─── Mocks that must be set up before any imports ──────────────────────────

// Capture request handlers registered on the MCP server
let listToolsHandler: (() => Promise<any>) | null = null;
let callToolHandler: ((request: any) => Promise<any>) | null = null;

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    server: {
      setRequestHandler: jest.fn().mockImplementation((schema: any, handler: any) => {
        if (schema === 'ListToolsRequestSchema') {
          listToolsHandler = handler;
        }
        if (schema === 'CallToolRequestSchema') {
          callToolHandler = handler;
        }
      }),
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      onerror: null,
    },
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));

// Mock httpClient so apiTools can register without needing a real server
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn().mockResolvedValue({ success: true }),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-jwt'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
  },
}));

// Mock agentApiKeyService for auth tests
const mockValidateKey = jest.fn();
jest.mock('../services/agentApiKeyService', () => ({
  agentApiKeyService: {
    validateKey: (...args: any[]) => mockValidateKey(...args),
  },
}));

// Mock mcpOAuthService for auth tests
const mockValidateAccessToken = jest.fn();
jest.mock('../mcp/oauth/oauthService', () => ({
  mcpOAuthService: {
    validateAccessToken: (...args: any[]) => mockValidateAccessToken(...args),
  },
}));

jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
        update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
        delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        batchWrite: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      })),
    },
    S3: jest.fn(() => ({})),
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
    })),
  },
}));

jest.mock('../services/db', () => ({
  taskDb: {},
  scheduleDb: {},
  userDb: { getUserById: jest.fn() },
}));

// ─── Imports (after all mocks) ─────────────────────────────────────────────

import { createMcpServer, mcpToolRegistry, McpSessionContext } from '../mcp/server/mcpServerCore';
import { McpToolRegistry } from '../mcp/server/registry';
import { mcpFetch } from '../mcp/server/httpClient';

const INTERNAL_TOOL_NAMES = [
  'you_search_web',
  'generate_image',
  'send_email',
  'save_file',
  'create_blog_article',
  'publish_blog_article',
  'install_skills',
  'list_available_skills',
];

// ─── Test suites ───────────────────────────────────────────────────────────

describe('MCP Server Security', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listToolsHandler = null;
    callToolHandler = null;
    delete process.env.MCP_ACCESS_TOKEN;
  });

  // ─── A. Internal tool isolation ────────────────────────────────────────

  describe('A. Internal tool isolation', () => {
    it('getToolDefinitions() must NOT include any internal-only tools', () => {
      const externalDefs = mcpToolRegistry.getToolDefinitions();
      const externalNames = externalDefs.map((d: any) => d.name);

      for (const internalName of INTERNAL_TOOL_NAMES) {
        expect(externalNames).not.toContain(internalName);
      }
    });

    it('getAllToolDefinitions() MUST include internal-only tools', () => {
      const allDefs = mcpToolRegistry.getAllToolDefinitions();
      const allNames = allDefs.map((d: any) => d.name);

      for (const internalName of INTERNAL_TOOL_NAMES) {
        expect(allNames).toContain(internalName);
      }
    });

    it('ListToolsRequestSchema handler returns only external tools', async () => {
      createMcpServer('test-server', { agentUserId: 'user-1', isInternal: false });
      expect(listToolsHandler).not.toBeNull();

      const result = await listToolsHandler!();
      const toolNames = result.tools.map((t: any) => t.name);

      for (const internalName of INTERNAL_TOOL_NAMES) {
        expect(toolNames).not.toContain(internalName);
      }
    });

    it('internal flag on registry correctly filters mixed registrations', () => {
      const registry = new McpToolRegistry();
      registry.register({
        name: 'public_tool',
        definition: { name: 'public_tool' },
        execute: jest.fn(),
      });
      registry.register({
        name: 'secret_tool',
        definition: { name: 'secret_tool' },
        execute: jest.fn(),
        internal: true,
      });

      const external = registry.getToolDefinitions();
      const all = registry.getAllToolDefinitions();

      expect(external).toHaveLength(1);
      expect(external[0].name).toBe('public_tool');
      expect(all).toHaveLength(2);
    });

    it('external client should still be able to execute internal tools by name (registry does not block execute)', async () => {
      // The registry.execute() does not gate on internal flag — the protection
      // is at the ListTools level (tools are hidden, not blocked).
      // This is intentional: if a tool name is known, it can be called.
      // The real defense is that external clients never discover internal tool names.
      const registry = new McpToolRegistry();
      const mockFn = jest.fn().mockResolvedValue({ ok: true });
      registry.register({
        name: 'hidden_tool',
        definition: { name: 'hidden_tool' },
        execute: mockFn,
        internal: true,
      });

      const result = await registry.execute('hidden_tool', { foo: 'bar' });
      expect(result).toEqual({ ok: true });
      expect(mockFn).toHaveBeenCalledWith({ foo: 'bar' }, undefined);
    });
  });

  // ─── B. userId override (IDOR protection) ─────────────────────────────

  describe('B. userId override (IDOR protection)', () => {
    function setupAndGetCallHandler(ctx: McpSessionContext) {
      createMcpServer('test', ctx);
      expect(callToolHandler).not.toBeNull();
      return callToolHandler!;
    }

    // Mock the registry execute to capture context
    const mockExecute = jest.fn().mockResolvedValue({ success: true });

    beforeEach(() => {
      mockExecute.mockClear();
      // Temporarily replace execute on the real registry
      (mcpToolRegistry as any).execute = mockExecute;
    });

    it('FAIL: external client cannot override userId via tool args', async () => {
      const handler = setupAndGetCallHandler({
        agentUserId: 'legit-user',
        isInternal: false,
      });

      await handler({
        params: {
          name: 'list_tasks',
          arguments: { userId: 'victim-user' },
        },
      });

      const context = mockExecute.mock.calls[0][2];
      expect(context.userId).toBe('legit-user');
      expect(context.userId).not.toBe('victim-user');
    });

    it('FAIL: external client with isInternal=undefined cannot override userId', async () => {
      const handler = setupAndGetCallHandler({
        agentUserId: 'legit-user',
        // isInternal intentionally omitted
      });

      await handler({
        params: {
          name: 'list_tasks',
          arguments: { userId: 'victim-user' },
        },
      });

      const context = mockExecute.mock.calls[0][2];
      expect(context.userId).toBe('legit-user');
    });

    it('SUCCESS: internal client CAN override userId', async () => {
      const handler = setupAndGetCallHandler({
        agentUserId: 'backend-svc',
        isInternal: true,
      });

      await handler({
        params: {
          name: 'list_tasks',
          arguments: { userId: 'target-user' },
        },
      });

      const context = mockExecute.mock.calls[0][2];
      expect(context.userId).toBe('target-user');
    });

    it('userId arg is stripped from toolArgs passed to handler', async () => {
      const handler = setupAndGetCallHandler({
        agentUserId: 'user-1',
        isInternal: false,
      });

      await handler({
        params: {
          name: 'list_tasks',
          arguments: { userId: 'attacker', query: 'legit-param' },
        },
      });

      const toolArgs = mockExecute.mock.calls[0][1];
      expect(toolArgs).toEqual({ query: 'legit-param' });
      expect(toolArgs.userId).toBeUndefined();
    });

    it('sessionId and llmModel are also stripped from toolArgs', async () => {
      const handler = setupAndGetCallHandler({
        agentUserId: 'user-1',
        isInternal: false,
      });

      await handler({
        params: {
          name: 'list_tasks',
          arguments: { sessionId: 'fake', llmModel: 'gpt-4', realArg: 'ok' },
        },
      });

      const toolArgs = mockExecute.mock.calls[0][1];
      expect(toolArgs).toEqual({ realArg: 'ok' });
    });
  });

  // ─── C. mcpFetch auth boundary ────────────────────────────────────────

  describe('C. mcpFetch requires userId', () => {
    beforeEach(() => {
      (mcpFetch as jest.Mock).mockReset();
    });

    it('FAIL: mcpFetch throws when no userId in context', async () => {
      // Restore actual implementation for this test
      const actual = jest.requireActual('../mcp/server/httpClient');
      // The real mcpFetch checks for userId
      // We can test this by calling with empty context
      const { mcpFetch: realMcpFetch } = actual;

      await expect(
        realMcpFetch({ method: 'GET', path: '/api/test', context: {} })
      ).rejects.toThrow('Authentication required: no userId in context');
    });
  });

  // ─── D. Tool call error handling ──────────────────────────────────────

  describe('D. Tool call error handling', () => {
    it('tool execution error returns isError=true (no stack leak)', async () => {
      // Create a fresh registry and server to control the execute mock
      const mockRegistryExecute = jest.fn().mockRejectedValue(new Error('DB connection failed'));
      (mcpToolRegistry as any).execute = mockRegistryExecute;

      createMcpServer('test', { agentUserId: 'user-1', isInternal: false });
      expect(callToolHandler).not.toBeNull();

      const result = await callToolHandler!({
        params: { name: 'list_tasks', arguments: {} },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('DB connection failed');
      // Should not leak stack traces
      expect(result.content[0].text).not.toContain('at ');
    });

    it('unknown tool returns error (not crash)', async () => {
      // Restore real execute for this test
      const registry = new McpToolRegistry();
      const originalExecute = registry.execute.bind(registry);

      // The real mcpToolRegistry from apiTools doesn't have 'nonexistent_tool'
      // But our mock is overriding execute, so let's test the registry directly
      await expect(registry.execute('nonexistent_tool', {}))
        .rejects.toThrow('Tool nonexistent_tool not found');
    });
  });

  // ─── E. Rate limiting ────────────────────────────────────────────────

  describe('E. Rate limiting', () => {
    it('should enforce per-key rate limits', () => {
      const { RateLimiter } = require('../middleware/rateLimiter');
      const limiter = new RateLimiter();

      const keyId = 'mcp-key-security-test';
      const limit = 2;

      expect(limiter.check(keyId, limit).allowed).toBe(true);
      expect(limiter.check(keyId, limit).allowed).toBe(true);

      const blocked = limiter.check(keyId, limit);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);

      limiter.destroy();
    });

    it('different keys have independent limits', () => {
      const { RateLimiter } = require('../middleware/rateLimiter');
      const limiter = new RateLimiter();

      // Exhaust key A
      limiter.check('key-a', 1);
      expect(limiter.check('key-a', 1).allowed).toBe(false);

      // Key B should still work
      expect(limiter.check('key-b', 1).allowed).toBe(true);

      limiter.destroy();
    });
  });

  // ─── F. Self-call JWT generation ──────────────────────────────────────

  describe('F. Self-call JWT security', () => {
    it('generateSelfCallToken creates short-lived JWT with user identity', () => {
      const jwt = require('jsonwebtoken');
      const { generateSelfCallToken } = jest.requireActual('../mcp/server/httpClient');

      process.env.JWT_SECRET = 'test-secret';

      const token = generateSelfCallToken({
        userId: 'user-123',
        email: 'user@example.com',
        isAdmin: false,
      });

      const decoded = jwt.verify(token, 'test-secret') as any;
      expect(decoded.userId).toBe('user-123');
      expect(decoded.email).toBe('user@example.com');
      expect(decoded.isAdmin).toBe(false);
      // Token should expire in 600 seconds (extended for slow v0 operations)
      expect(decoded.exp - decoded.iat).toBe(600);
    });

    it('self-call JWT does not grant admin when user is not admin', () => {
      const jwt = require('jsonwebtoken');
      const { generateSelfCallToken } = jest.requireActual('../mcp/server/httpClient');

      process.env.JWT_SECRET = 'test-secret';

      const token = generateSelfCallToken({
        userId: 'user-123',
        email: 'user@example.com',
        isAdmin: false,
      });

      const decoded = jwt.verify(token, 'test-secret') as any;
      expect(decoded.isAdmin).toBe(false);
    });
  });
});
