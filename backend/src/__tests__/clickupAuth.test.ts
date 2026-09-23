/**
 * Unit tests for ClickUp Personal API Token routes
 * Tests cover: save-token, status, workspace docs, disconnect
 * Uses supertest for HTTP integration testing
 */
import request from 'supertest';
import express, { Application } from 'express';

// Set required environment variable BEFORE any imports
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

// Mock userDb
const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: (...args: any[]) => mockGetUserById(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
  },
}));

// Mock crypto utils
const mockEncryptPassword = jest.fn();
const mockDecryptPassword = jest.fn();
jest.mock('../utils/crypto', () => ({
  encryptPassword: (...args: any[]) => mockEncryptPassword(...args),
  decryptPassword: (...args: any[]) => mockDecryptPassword(...args),
}));

// Mock axios
jest.mock('axios');

// Mock integrations config for OAuth
const mockGetClickUpConfig = jest.fn();
jest.mock('../config/integrations', () => ({
  getClickUpConfig: (...args: any[]) => mockGetClickUpConfig(...args),
}));

// Mock auth middleware to authenticate all requests
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
}));

// Import modules after mocks are set up
import clickupAuthRouter from '../routes/clickupAuth';
import axios from 'axios';
import jwt from 'jsonwebtoken';

// Create test app
const createTestApp = (): Application => {
  const app = express();
  app.use(express.json());
  app.use('/api/oauth/clickup', clickupAuthRouter);
  return app;
};

const CLICKUP_CONFIG_MOCK = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:3001/api/oauth/clickup/callback',
  authorizationUrl: 'https://app.clickup.com/api',
  tokenUrl: 'https://api.clickup.com/api/v2/oauth/token',
};

describe('ClickUp Auth Routes', () => {
  let app: Application;
  const mockAxiosGet = axios.get as jest.Mock;
  const mockAxiosPost = axios.post as jest.Mock;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetClickUpConfig.mockResolvedValue(CLICKUP_CONFIG_MOCK);
  });

  // Legacy read-only behavior remains; mutation/OAuth contracts live in clickupAuth.admin.test.ts.
  describe('GET /api/oauth/clickup/workspace/:teamId/docs', () => {
    it('should return 401 if user has null secrets', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: null });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/docs')
        .expect(401);

      expect(response.body.error).toBe('ClickUp not connected');
    });

    it('should return 401 if no token in secrets', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: {} });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/docs')
        .expect(401);

      expect(response.body.error).toBe('ClickUp not connected');
    });

    it('should return 401 if decryption fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'bad-data' },
      });
      mockDecryptPassword.mockImplementation(() => { throw new Error('Decrypt failed'); });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/docs')
        .expect(401);

      expect(response.body.error).toBe('ClickUp not connected');
    });

    it('should fetch docs and filter out deleted/archived', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'access-token' });

      mockAxiosGet.mockResolvedValue({
        data: {
          docs: [
            { id: 'doc-1', name: 'Active Doc', date_created: 1000, date_updated: 2000, deleted: false, archived: false },
            { id: 'doc-2', name: 'Deleted Doc', date_created: 1000, date_updated: 2000, deleted: true, archived: false },
            { id: 'doc-3', name: 'Archived Doc', date_created: 1000, date_updated: 2000, deleted: false, archived: true },
            { id: 'doc-4', name: 'Another Active', date_created: 3000, date_updated: null, deleted: false, archived: false },
          ],
          // No next_cursor means single page
        },
      });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-456/docs')
        .expect(200);

      expect(response.body.docs).toEqual([
        { id: 'doc-1', name: 'Active Doc', dateCreated: 1000, dateUpdated: 2000 },
        { id: 'doc-4', name: 'Another Active', dateCreated: 3000, dateUpdated: 3000 },
      ]);

      // Verify correct API URL
      expect(mockAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining('https://api.clickup.com/api/v3/workspaces/team-456/docs'),
        { headers: { Authorization: 'access-token' } }
      );
    });

    it('should handle pagination with next_cursor', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'access-token' });

      // First page
      mockAxiosGet
        .mockResolvedValueOnce({
          data: {
            docs: [{ id: 'doc-1', name: 'Page 1 Doc', date_created: 1000, date_updated: 2000, deleted: false, archived: false }],
            next_cursor: 'cursor-page-2',
          },
        })
        // Second page
        .mockResolvedValueOnce({
          data: {
            docs: [{ id: 'doc-2', name: 'Page 2 Doc', date_created: 3000, date_updated: 4000, deleted: false, archived: false }],
            // No next_cursor = done
          },
        });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-789/docs')
        .expect(200);

      expect(response.body.docs).toHaveLength(2);
      expect(response.body.docs[0].id).toBe('doc-1');
      expect(response.body.docs[1].id).toBe('doc-2');

      // Verify both API calls were made
      expect(mockAxiosGet).toHaveBeenCalledTimes(2);
      // Second call should include cursor
      expect(mockAxiosGet).toHaveBeenNthCalledWith(2,
        expect.stringContaining('cursor=cursor-page-2'),
        { headers: { Authorization: 'access-token' } }
      );
    });

    it('should return 500 if ClickUp API fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'access-token' });
      mockAxiosGet.mockRejectedValue(new Error('API Error'));

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/docs')
        .expect(500);

      expect(response.body.error).toBe('Failed to fetch workspace docs');
    });

    it('should handle empty docs array', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'access-token' });
      mockAxiosGet.mockResolvedValue({ data: { docs: [] } });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/docs')
        .expect(200);

      expect(response.body.docs).toEqual([]);
    });

    it('should handle null docs array from API', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'access-token' });
      mockAxiosGet.mockResolvedValue({ data: { docs: null } });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/docs')
        .expect(200);

      expect(response.body.docs).toEqual([]);
    });
  });

  // ============================================
  // GET /workspace/:teamId/tasks
  // ============================================
  describe('GET /api/oauth/clickup/workspace/:teamId/tasks', () => {
    it('should return 401 if user has null secrets', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: null });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/tasks')
        .expect(401);

      expect(response.body.error).toBe('ClickUp not connected');
    });

    it('should return 401 if no token in secrets', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: {} });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/tasks')
        .expect(401);

      expect(response.body.error).toBe('ClickUp not connected');
    });

    it('should return 401 if decryption fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'bad-data' },
      });
      mockDecryptPassword.mockImplementation(() => { throw new Error('Decrypt failed'); });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/tasks')
        .expect(401);

      expect(response.body.error).toBe('ClickUp not connected');
    });

    it('should fetch tasks successfully', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'access-token' });

      mockAxiosGet.mockResolvedValue({
        data: {
          tasks: [
            {
              id: 'task-1',
              name: 'Task One',
              description: 'Description',
              status: { status: 'open' },
              assignees: [{ username: 'alice' }],
              due_date: '1700000000000',
              tags: [{ name: 'bug' }],
              priority: { priority: 'high' },
              attachments: [],
              date_created: '1690000000000',
              date_updated: '1695000000000',
            },
          ],
          last_page: true,
        },
      });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-456/tasks')
        .expect(200);

      expect(response.body.tasks).toHaveLength(1);
      expect(response.body.tasks[0].id).toBe('task-1');
      expect(response.body.tasks[0].name).toBe('Task One');
      expect(response.body.tasks[0].status).toBe('open');
    });

    it('should return 500 if ClickUp API fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'access-token' });
      mockAxiosGet.mockRejectedValue(new Error('API Error'));

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/tasks')
        .expect(500);

      expect(response.body.error).toBe('Failed to fetch workspace tasks');
    });

    it('should handle empty tasks array', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'access-token' });
      mockAxiosGet.mockResolvedValue({ data: { tasks: [], last_page: true } });

      const response = await request(app)
        .get('/api/oauth/clickup/workspace/team-123/tasks')
        .expect(200);

      expect(response.body.tasks).toEqual([]);
    });
  });

  // ============================================
  // POST /disconnect
  // ============================================
});
