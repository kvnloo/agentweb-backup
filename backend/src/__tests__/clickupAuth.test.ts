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

// Create test app
const createTestApp = (): Application => {
  const app = express();
  app.use(express.json());
  app.use('/api/oauth/clickup', clickupAuthRouter);
  return app;
};

describe('ClickUp Auth Routes', () => {
  let app: Application;
  const mockAxiosGet = axios.get as jest.Mock;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
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

      expect(response.body.error).toBe('Failed to decrypt ClickUp token');
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
});
