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

  // ============================================
  // POST /save-token
  // ============================================
  describe('POST /api/oauth/clickup/save-token', () => {
    it('should return 400 if token is missing', async () => {
      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing ClickUp API token');
    });

    it('should return 400 if token is empty string', async () => {
      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: '   ' })
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing ClickUp API token');
    });

    it('should return 400 if token is not a string', async () => {
      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: 12345 })
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing ClickUp API token');
    });

    it('should return 400 if token is null', async () => {
      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: null })
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing ClickUp API token');
    });

    it('should return 401 if ClickUp API rejects the token (401)', async () => {
      mockAxiosGet.mockRejectedValue({ response: { status: 401 } });

      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: 'invalid-token' })
        .expect(401);

      expect(response.body.error).toBe('Invalid ClickUp API token. Please check and try again.');
    });

    it('should return 401 if ClickUp API rejects the token (403)', async () => {
      mockAxiosGet.mockRejectedValue({ response: { status: 403 } });

      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: 'forbidden-token' })
        .expect(401);

      expect(response.body.error).toBe('Invalid ClickUp API token. Please check and try again.');
    });

    it('should return 500 if ClickUp API returns an unexpected error', async () => {
      mockAxiosGet.mockRejectedValue(new Error('Network error'));

      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: 'valid-token' })
        .expect(500);

      expect(response.body.error).toBe('Failed to save ClickUp token');
    });

    it('should save token and return workspaces on success', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          teams: [
            { id: 'team-1', name: 'My Workspace', avatar: 'https://avatar.url' },
            { id: 'team-2', name: 'Other Workspace', avatar: null },
          ],
        },
      });
      mockEncryptPassword.mockReturnValue('encrypted-token');
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: { existing_key: 'val' } });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: 'pk_valid_token' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.workspaces).toEqual([
        { id: 'team-1', name: 'My Workspace', avatar: 'https://avatar.url' },
        { id: 'team-2', name: 'Other Workspace', avatar: null },
      ]);

      // Verify ClickUp API was called with trimmed token
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team',
        { headers: { Authorization: 'pk_valid_token' } }
      );

      // Verify token was encrypted and saved
      expect(mockEncryptPassword).toHaveBeenCalledWith('pk_valid_token', 'test-user-id');
      expect(mockUpdateUser).toHaveBeenCalledWith('test-user-id', {
        secrets: { existing_key: 'val', clickup_access_token: 'encrypted-token' },
      });
    });

    it('should handle user with no existing secrets', async () => {
      mockAxiosGet.mockResolvedValue({ data: { teams: [] } });
      mockEncryptPassword.mockReturnValue('encrypted-token');
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: null });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: 'pk_token' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.workspaces).toEqual([]);
      expect(mockUpdateUser).toHaveBeenCalledWith('test-user-id', {
        secrets: { clickup_access_token: 'encrypted-token' },
      });
    });

    it('should trim whitespace from token', async () => {
      mockAxiosGet.mockResolvedValue({ data: { teams: [] } });
      mockEncryptPassword.mockReturnValue('encrypted');
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: {} });
      mockUpdateUser.mockResolvedValue(undefined);

      await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: '  pk_token_with_spaces  ' })
        .expect(200);

      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team',
        { headers: { Authorization: 'pk_token_with_spaces' } }
      );
      expect(mockEncryptPassword).toHaveBeenCalledWith('pk_token_with_spaces', 'test-user-id');
    });

    it('should handle ClickUp API returning null teams array', async () => {
      mockAxiosGet.mockResolvedValue({
        data: { teams: null },
      });
      mockEncryptPassword.mockReturnValue('enc');
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: {} });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: 'pk_token' })
        .expect(200);

      expect(response.body.workspaces).toEqual([]);
    });

    it('should handle user not found (null user)', async () => {
      mockAxiosGet.mockResolvedValue({ data: { teams: [] } });
      mockEncryptPassword.mockReturnValue('enc');
      mockGetUserById.mockResolvedValue(null);
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: 'pk_token' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockUpdateUser).toHaveBeenCalledWith('test-user-id', {
        secrets: { clickup_access_token: 'enc' },
      });
    });

    it('should handle teams with missing avatar gracefully', async () => {
      mockAxiosGet.mockResolvedValue({
        data: {
          teams: [{ id: 'team-1', name: 'Workspace' }], // no avatar field
        },
      });
      mockEncryptPassword.mockReturnValue('enc');
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: {} });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/clickup/save-token')
        .send({ token: 'pk_token' })
        .expect(200);

      expect(response.body.workspaces[0].avatar).toBeNull();
    });
  });

  // ============================================
  // GET /status
  // ============================================
  describe('GET /api/oauth/clickup/status', () => {
    it('should return disconnected if no token in secrets', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: {} });

      const response = await request(app)
        .get('/api/oauth/clickup/status')
        .expect(200);

      expect(response.body).toEqual({ connected: false, workspaces: [] });
    });

    it('should return disconnected if user has no secrets at all', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: null });

      const response = await request(app)
        .get('/api/oauth/clickup/status')
        .expect(200);

      expect(response.body).toEqual({ connected: false, workspaces: [] });
    });

    it('should return disconnected if decryption fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'corrupted-data' },
      });
      mockDecryptPassword.mockImplementation(() => { throw new Error('Decryption failed'); });

      const response = await request(app)
        .get('/api/oauth/clickup/status')
        .expect(200);

      expect(response.body).toEqual({ connected: false, workspaces: [] });
    });

    it('should handle ClickUp API returning null teams in status', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted-token' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'real-access-token' });
      mockAxiosGet.mockResolvedValue({ data: { teams: null } });

      const response = await request(app)
        .get('/api/oauth/clickup/status')
        .expect(200);

      expect(response.body).toEqual({ connected: true, workspaces: [] });
    });

    it('should return connected with workspaces on valid token', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted-token' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'real-access-token' });
      mockAxiosGet.mockResolvedValue({
        data: {
          teams: [{ id: 'ws-1', name: 'Workspace 1', avatar: null }],
        },
      });

      const response = await request(app)
        .get('/api/oauth/clickup/status')
        .expect(200);

      expect(response.body).toEqual({
        connected: true,
        workspaces: [{ id: 'ws-1', name: 'Workspace 1', avatar: null }],
      });
      expect(mockAxiosGet).toHaveBeenCalledWith(
        'https://api.clickup.com/api/v2/team',
        { headers: { Authorization: 'real-access-token' } }
      );
    });

    it('should return disconnected if ClickUp API call fails (expired token)', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'encrypted-token' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'expired-token' });
      mockAxiosGet.mockRejectedValue(new Error('Request failed with status code 401'));

      const response = await request(app)
        .get('/api/oauth/clickup/status')
        .expect(200);

      expect(response.body).toEqual({ connected: false, workspaces: [] });
    });
  });

  // ============================================
  // GET /workspace/:teamId/docs
  // ============================================
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
  describe('POST /api/oauth/clickup/disconnect', () => {
    it('should remove clickup_access_token and preserve other secrets', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'enc-token', other_secret: 'keep-me' },
      });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/clickup/disconnect')
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(mockUpdateUser).toHaveBeenCalledWith('test-user-id', {
        secrets: { other_secret: 'keep-me' },
      });
    });

    it('should handle user with no secrets', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: null });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/clickup/disconnect')
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(mockUpdateUser).toHaveBeenCalledWith('test-user-id', {
        secrets: {},
      });
    });

    it('should handle user with no clickup token (already disconnected)', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { some_other: 'value' },
      });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/clickup/disconnect')
        .expect(200);

      expect(response.body).toEqual({ success: true });
    });

    it('should return 500 if database update fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { clickup_access_token: 'enc' },
      });
      mockUpdateUser.mockRejectedValue(new Error('DB error'));

      const response = await request(app)
        .post('/api/oauth/clickup/disconnect')
        .expect(500);

      expect(response.body.error).toBe('Failed to disconnect ClickUp');
    });
  });

  // ============================================
  // GET /init — OAuth flow
  // ============================================
  describe('GET /api/oauth/clickup/init', () => {
    it('should return authorization URL with required params', async () => {
      const response = await request(app)
        .get('/api/oauth/clickup/init')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.url).toContain('https://app.clickup.com/api');
      expect(response.body.url).toContain('client_id=test-client-id');
      expect(response.body.url).toContain('response_type=code');
      expect(response.body.url).toContain('state=');
    });

    it('should include a valid JWT state param', async () => {
      const response = await request(app)
        .get('/api/oauth/clickup/init')
        .expect(200);

      const url = new URL(response.body.url);
      const state = url.searchParams.get('state');
      expect(state).toBeTruthy();

      const decoded = jwt.verify(state!, 'test-jwt-secret-for-testing') as any;
      expect(decoded.userId).toBe('test-user-id');
      expect(decoded.nonce).toBeTruthy();
    });

    it('should return 500 if getClickUpConfig fails', async () => {
      mockGetClickUpConfig.mockRejectedValue(new Error('Secrets Manager unavailable'));

      const response = await request(app)
        .get('/api/oauth/clickup/init')
        .expect(500);

      expect(response.body.error).toBe('Failed to initialize ClickUp OAuth');
    });
  });

  // ============================================
  // GET /callback — OAuth redirect
  // ============================================
  describe('GET /api/oauth/clickup/callback', () => {
    it('should redirect to frontend callback with code and state', async () => {
      const response = await request(app)
        .get('/api/oauth/clickup/callback?code=auth-code-123&state=state-token')
        .expect(302);

      expect(response.headers.location).toContain('/oauth/clickup/callback');
      expect(response.headers.location).toContain('code=auth-code-123');
      expect(response.headers.location).toContain('state=state-token');
    });

    it('should redirect with error if ClickUp returns error', async () => {
      const response = await request(app)
        .get('/api/oauth/clickup/callback?error=access_denied')
        .expect(302);

      expect(response.headers.location).toContain('error=clickup_access_denied');
    });

    it('should redirect with error if no code provided', async () => {
      const response = await request(app)
        .get('/api/oauth/clickup/callback?state=some-state')
        .expect(302);

      expect(response.headers.location).toContain('error=no_code_provided');
    });
  });

  // ============================================
  // POST /finalize — Exchange code for token
  // ============================================
  describe('POST /api/oauth/clickup/finalize', () => {
    const generateValidState = () =>
      jwt.sign({ userId: 'test-user-id', nonce: 'abc123' }, 'test-jwt-secret-for-testing', { expiresIn: '15m' });

    it('should return 400 if code is missing', async () => {
      const state = generateValidState();
      const response = await request(app)
        .post('/api/oauth/clickup/finalize')
        .send({ state })
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing OAuth code');
    });

    it('should return 400 if state is missing', async () => {
      const response = await request(app)
        .post('/api/oauth/clickup/finalize')
        .send({ code: 'auth-code' })
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing state parameter');
    });

    it('should return 403 if state is invalid', async () => {
      const response = await request(app)
        .post('/api/oauth/clickup/finalize')
        .send({ code: 'auth-code', state: 'tampered-state' })
        .expect(403);

      expect(response.body.error).toContain('CSRF protection');
    });

    it('should return 403 if state userId does not match', async () => {
      const wrongUserState = jwt.sign(
        { userId: 'different-user', nonce: 'abc' },
        'test-jwt-secret-for-testing',
        { expiresIn: '15m' }
      );
      const response = await request(app)
        .post('/api/oauth/clickup/finalize')
        .send({ code: 'auth-code', state: wrongUserState })
        .expect(403);

      expect(response.body.error).toContain('CSRF protection');
    });

    it('should exchange code for token and return tokenSessionId', async () => {
      const state = generateValidState();
      mockAxiosPost.mockResolvedValue({ data: { access_token: 'cu_oauth_token_123' } });

      const response = await request(app)
        .post('/api/oauth/clickup/finalize')
        .send({ code: 'auth-code-123', state })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.tokenSessionId).toBeTruthy();
      expect(typeof response.body.tokenSessionId).toBe('string');
    });

    it('should return 500 if ClickUp token exchange fails', async () => {
      const state = generateValidState();
      mockAxiosPost.mockRejectedValue(new Error('Token exchange failed'));

      const response = await request(app)
        .post('/api/oauth/clickup/finalize')
        .send({ code: 'bad-code', state })
        .expect(500);

      expect(response.body.error).toBe('Failed to finalize ClickUp connection');
    });

    it('should return 500 if ClickUp returns no access_token', async () => {
      const state = generateValidState();
      mockAxiosPost.mockResolvedValue({ data: {} });

      const response = await request(app)
        .post('/api/oauth/clickup/finalize')
        .send({ code: 'auth-code', state })
        .expect(500);

      expect(response.body.error).toBe('No access token received from ClickUp');
    });
  });

  // ============================================
  // POST /connect — Persist OAuth token
  // ============================================
  describe('POST /api/oauth/clickup/connect', () => {
    const getTokenSessionId = async (): Promise<string> => {
      const state = jwt.sign(
        { userId: 'test-user-id', nonce: 'xyz' },
        'test-jwt-secret-for-testing',
        { expiresIn: '15m' }
      );
      mockAxiosPost.mockResolvedValueOnce({ data: { access_token: 'cu_oauth_access_token' } });
      const finalizeRes = await request(app)
        .post('/api/oauth/clickup/finalize')
        .send({ code: 'valid-code', state });
      return finalizeRes.body.tokenSessionId;
    };

    it('should return 400 if tokenSessionId is missing', async () => {
      const response = await request(app)
        .post('/api/oauth/clickup/connect')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Missing tokenSessionId');
    });

    it('should return 401 if tokenSessionId is invalid', async () => {
      const response = await request(app)
        .post('/api/oauth/clickup/connect')
        .send({ tokenSessionId: 'nonexistent-session' })
        .expect(401);

      expect(response.body.error).toContain('Invalid or expired token session');
    });

    it('should store OAuth token and return workspaces on success', async () => {
      const tokenSessionId = await getTokenSessionId();

      mockAxiosGet.mockResolvedValue({
        data: { teams: [{ id: 'ws-1', name: 'My Workspace', avatar: null }] },
      });
      mockEncryptPassword.mockReturnValue('encrypted-oauth-token');
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: { other: 'val' } });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/clickup/connect')
        .send({ tokenSessionId })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.workspaces).toEqual([{ id: 'ws-1', name: 'My Workspace', avatar: null }]);

      expect(mockEncryptPassword).toHaveBeenCalledWith('cu_oauth_access_token', 'test-user-id');
      expect(mockUpdateUser).toHaveBeenCalledWith('test-user-id', {
        secrets: { other: 'val', clickup_access_token: 'encrypted-oauth-token' },
      });
    });

    it('should be one-time use — second call with same session fails', async () => {
      const tokenSessionId = await getTokenSessionId();

      mockAxiosGet.mockResolvedValue({ data: { teams: [] } });
      mockEncryptPassword.mockReturnValue('enc');
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: {} });
      mockUpdateUser.mockResolvedValue(undefined);

      // First call succeeds
      await request(app)
        .post('/api/oauth/clickup/connect')
        .send({ tokenSessionId })
        .expect(200);

      // Second call with same session ID fails
      const response = await request(app)
        .post('/api/oauth/clickup/connect')
        .send({ tokenSessionId })
        .expect(401);

      expect(response.body.error).toContain('Invalid or expired token session');
    });

    it('should return 500 if workspace fetch fails during connect', async () => {
      const tokenSessionId = await getTokenSessionId();

      mockAxiosGet.mockRejectedValue(new Error('ClickUp API error'));

      const response = await request(app)
        .post('/api/oauth/clickup/connect')
        .send({ tokenSessionId })
        .expect(500);

      expect(response.body.error).toBe('Failed to connect ClickUp account');
    });
  });
});
