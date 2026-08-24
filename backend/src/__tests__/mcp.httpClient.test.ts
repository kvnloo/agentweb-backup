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

import { generateSelfCallToken, mcpFetch, clearUserCache } from '../mcp/server/httpClient';
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

    // ENG-1189: a raw network failure (undici's TypeError('fetch failed') on a self-call,
    // e.g. because the backend process was mid-restart) used to propagate to the LLM as the
    // bare, unactionable string "fetch failed" with no endpoint/method/cause and no retry —
    // so a transient connection blip permanently blocked the tool call (manage_scheduled_chat
    // in production, session 2318c99c-6b45-47ae-95cb-12fe85939c8d, failed 3 times this way).
    it('should retry a transient network failure and surface method/path/cause once retries are exhausted', async () => {
      const networkError = () => {
        const err = new TypeError('fetch failed');
        (err as any).cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:3001' };
        return err;
      };
      const fetchMock = jest.fn().mockRejectedValue(networkError());
      global.fetch = fetchMock as any;

      await expect(
        mcpFetch({ method: 'PUT', path: '/api/agent-mode/scheduled-chats/sched-1', context: { userId: 'user-123' } })
      ).rejects.toThrow(/PUT.*\/api\/agent-mode\/scheduled-chats\/sched-1.*ECONNREFUSED/s);

      // Bounded retry: more than one attempt, but not unbounded.
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
    });

    it('should succeed if a transient network failure resolves on retry', async () => {
      const networkError = () => {
        const err = new TypeError('fetch failed');
        (err as any).cause = { code: 'ECONNRESET', message: 'socket hang up' };
        return err;
      };
      const mockResponse = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ success: true }),
      };
      const fetchMock = jest.fn()
        .mockRejectedValueOnce(networkError())
        .mockResolvedValueOnce(mockResponse);
      global.fetch = fetchMock as any;

      const result = await mcpFetch({ method: 'GET', path: '/api/test', context: { userId: 'user-123' } });

      expect(result).toEqual({ success: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
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
