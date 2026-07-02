/**
 * Tests for mcp/server/httpClient.ts
 * Covers JWT generation, fetch helper, error handling, and user cache.
 */

import jwt from 'jsonwebtoken';

// Mock db before importing httpClient
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

import {
  generateSelfCallToken,
  mcpFetch,
  clearUserCache,
  MCP_MAX_CALL_TIMEOUT_MS,
  DISPATCHER_TIMEOUT_MS,
} from '../mcp/server/httpClient';
import { userDb } from '../services/db';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;

describe('httpClient', () => {
  const testUser = { userId: 'user-123', email: 'test@example.com', isAdmin: false };

  beforeEach(() => {
    clearUserCache();
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    process.env.PORT = '3001';
    mockUserDb.getUserById.mockResolvedValue(testUser as any);
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
    delete process.env.PORT;
  });

  // ─── FAIL tests ───────────────────────────────────────────────────────

  describe('generateSelfCallToken - error cases', () => {
    it('should generate a JWT that expires in 600 seconds', () => {
      const token = generateSelfCallToken(testUser);
      const decoded = jwt.verify(token, 'test-secret') as any;

      expect(decoded.userId).toBe('user-123');
      expect(decoded.email).toBe('test@example.com');
      expect(decoded.isAdmin).toBe(false);
      // Token should expire within ~600s (must outlast slow operations like v0 generation)
      expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(600);
    });

    it('should include isAdmin flag in token', () => {
      const adminUser = { ...testUser, isAdmin: true };
      const token = generateSelfCallToken(adminUser);
      const decoded = jwt.verify(token, 'test-secret') as any;

      expect(decoded.isAdmin).toBe(true);
    });
  });

  describe('mcpFetch - error cases', () => {
    it('should throw when no userId in context', async () => {
      await expect(
        mcpFetch({ method: 'GET', path: '/api/test', context: {} })
      ).rejects.toThrow('Authentication required: no userId in context');
    });

    it('should throw when user not found in DB', async () => {
      mockUserDb.getUserById.mockResolvedValue(null as any);

      await expect(
        mcpFetch({ method: 'GET', path: '/api/test', context: { userId: 'nonexistent' } })
      ).rejects.toThrow('User not found: nonexistent');
    });

    it('should throw on HTTP error responses', async () => {
      const mockResponse = {
        ok: false,
        status: 403,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ message: 'Forbidden' }),
      };
      global.fetch = jest.fn().mockResolvedValue(mockResponse) as any;

      await expect(
        mcpFetch({ method: 'GET', path: '/api/test', context: { userId: 'user-123' } })
      ).rejects.toThrow('API error (403): Forbidden');
    });
  });

  // ─── SUCCESS tests ────────────────────────────────────────────────────

  describe('mcpFetch - success cases', () => {
    it('should make GET request with correct authorization header', async () => {
      const responseData = { tasks: [] };
      const mockResponse = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve(responseData),
      };
      global.fetch = jest.fn().mockResolvedValue(mockResponse) as any;

      const result = await mcpFetch({
        method: 'GET',
        path: '/api/tasks',
        context: { userId: 'user-123' },
      });

      expect(result).toEqual(responseData);

      const [url, options] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('http://localhost:3001/api/tasks');
      expect(options.method).toBe('GET');
      expect(options.headers.Authorization).toMatch(/^Bearer /);

      // Verify the JWT is valid
      const token = options.headers.Authorization.replace('Bearer ', '');
      const decoded = jwt.verify(token, 'test-secret') as any;
      expect(decoded.userId).toBe('user-123');
    });

    it('should make POST request with body', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ success: true }),
      };
      global.fetch = jest.fn().mockResolvedValue(mockResponse) as any;

      await mcpFetch({
        method: 'POST',
        path: '/api/tasks',
        context: { userId: 'user-123' },
        body: { name: 'Test Task', prompt: 'Do something' },
      });

      const [, options] = (global.fetch as jest.Mock).mock.calls[0];
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ name: 'Test Task', prompt: 'Do something' });
    });

    it('should append query params to URL', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ leads: [] }),
      };
      global.fetch = jest.fn().mockResolvedValue(mockResponse) as any;

      await mcpFetch({
        method: 'GET',
        path: '/api/crm/lists/list-1/leads',
        context: { userId: 'user-123' },
        queryParams: { limit: '10', search: 'test' },
      });

      const [url] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toContain('limit=10');
      expect(url).toContain('search=test');
    });

    it('should use agentUserId as fallback when userId is absent', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({}),
      };
      global.fetch = jest.fn().mockResolvedValue(mockResponse) as any;

      await mcpFetch({
        method: 'GET',
        path: '/api/tasks',
        context: { agentUserId: 'user-123' },
      });

      expect(mockUserDb.getUserById).toHaveBeenCalledWith('user-123');
    });

    it('should cache user lookups', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({}),
      };
      global.fetch = jest.fn().mockResolvedValue(mockResponse) as any;

      // First call
      await mcpFetch({ method: 'GET', path: '/api/tasks', context: { userId: 'user-123' } });
      // Second call — should use cache
      await mcpFetch({ method: 'GET', path: '/api/tasks', context: { userId: 'user-123' } });

      // getUserById should only be called once due to caching
      expect(mockUserDb.getUserById).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Dispatcher / per-call timeout invariant ─────────────────────────
  //
  // Regression coverage for a bug where the undici global dispatcher (headersTimeout /
  // bodyTimeout) was hardcoded to 15 minutes while generate_landing_page /
  // deploy_landing_page passed a 25-minute timeoutMs to mcpFetch. The dispatcher killed
  // the socket at 15 minutes — before mcpFetch's own AbortController could — so slow but
  // legitimate v0 generations (15-25 min) surfaced as a generic "TypeError: fetch failed"
  // instead of completing or hitting the intended 25-minute abort.

  describe('timeout configuration', () => {
    it('should keep the dispatcher timeout strictly greater than the longest per-call timeoutMs', () => {
      expect(DISPATCHER_TIMEOUT_MS).toBeGreaterThan(MCP_MAX_CALL_TIMEOUT_MS);
    });

    it('should give generate_landing_page/deploy_landing_page at least their full 25-minute budget', () => {
      expect(MCP_MAX_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(25 * 60 * 1000);
    });
  });

  describe('clearUserCache', () => {
    it('should clear cached users', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({}),
      };
      global.fetch = jest.fn().mockResolvedValue(mockResponse) as any;

      await mcpFetch({ method: 'GET', path: '/api/test', context: { userId: 'user-123' } });
      clearUserCache();
      await mcpFetch({ method: 'GET', path: '/api/test', context: { userId: 'user-123' } });

      expect(mockUserDb.getUserById).toHaveBeenCalledTimes(2);
    });
  });
});
