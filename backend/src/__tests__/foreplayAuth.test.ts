/**
 * Unit tests for Foreplay API Token routes
 * Tests cover: save-token, status, board ads, swipefile ads, disconnect
 */
import request from 'supertest';
import express, { Application } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: (...args: any[]) => mockGetUserById(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
  },
}));

const mockEncryptPassword = jest.fn();
const mockDecryptPassword = jest.fn();
jest.mock('../utils/crypto', () => ({
  encryptPassword: (...args: any[]) => mockEncryptPassword(...args),
  decryptPassword: (...args: any[]) => mockDecryptPassword(...args),
}));

const mockGetForeplayApiKey = jest.fn().mockResolvedValue(null);
jest.mock('../utils/secretsManager', () => ({
  getForeplayApiKey: (...args: any[]) => mockGetForeplayApiKey(...args),
}));

jest.mock('axios');

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
}));

import foreplayAuthRouter from '../routes/foreplayAuth';
import axios from 'axios';

const createTestApp = (): Application => {
  const app = express();
  app.use(express.json());
  app.use('/api/oauth/foreplay', foreplayAuthRouter);
  return app;
};

describe('Foreplay Auth Routes', () => {
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
  describe('POST /api/oauth/foreplay/save-token', () => {
    it('should return 400 if token is missing', async () => {
      const response = await request(app)
        .post('/api/oauth/foreplay/save-token')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing Foreplay API token');
    });

    it('should return 400 if token is empty string', async () => {
      const response = await request(app)
        .post('/api/oauth/foreplay/save-token')
        .send({ token: '   ' })
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing Foreplay API token');
    });

    it('should return 400 if token is not a string', async () => {
      const response = await request(app)
        .post('/api/oauth/foreplay/save-token')
        .send({ token: 12345 })
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing Foreplay API token');
    });

    it('should return 401 if Foreplay API rejects the token (401)', async () => {
      mockAxiosGet.mockRejectedValue({ response: { status: 401 } });

      const response = await request(app)
        .post('/api/oauth/foreplay/save-token')
        .send({ token: 'invalid-token' })
        .expect(401);

      expect(response.body.error).toBe('Invalid Foreplay API token. Please check and try again.');
    });

    it('should return 401 if Foreplay API rejects the token (403)', async () => {
      mockAxiosGet.mockRejectedValue({ response: { status: 403 } });

      const response = await request(app)
        .post('/api/oauth/foreplay/save-token')
        .send({ token: 'forbidden-token' })
        .expect(401);

      expect(response.body.error).toBe('Invalid Foreplay API token. Please check and try again.');
    });

    it('should return 500 if Foreplay API returns an unexpected error', async () => {
      mockAxiosGet.mockRejectedValue(new Error('Network error'));

      const response = await request(app)
        .post('/api/oauth/foreplay/save-token')
        .send({ token: 'valid-token' })
        .expect(500);

      expect(response.body.error).toBe('Failed to save Foreplay token');
    });

    it('should save token and return boards on success', async () => {
      // First call = getUsage, second call = listBoards
      mockAxiosGet
        .mockResolvedValueOnce({ data: { data: { credits_used: 0, credits_remaining: 1000 } } })
        .mockResolvedValueOnce({
          data: {
            data: [
              { id: 'board-1', name: 'Inspiration' },
              { id: 'board-2', name: 'Competitors' },
            ],
          },
        });
      mockEncryptPassword.mockReturnValue('encrypted-token');
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: { existing_key: 'val' } });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/foreplay/save-token')
        .send({ token: 'fp_valid_token' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.boards).toHaveLength(2);
      expect(response.body.boards[0].name).toBe('Inspiration');

      expect(mockEncryptPassword).toHaveBeenCalledWith('fp_valid_token', 'test-user-id');
      expect(mockUpdateUser).toHaveBeenCalledWith('test-user-id', {
        secrets: { existing_key: 'val', foreplay_api_token: 'encrypted-token' },
      });
    });

    it('should handle user with no existing secrets', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({ data: { data: {} } })
        .mockResolvedValueOnce({ data: { data: [] } });
      mockEncryptPassword.mockReturnValue('encrypted-token');
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: null });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/foreplay/save-token')
        .send({ token: 'fp_token' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockUpdateUser).toHaveBeenCalledWith('test-user-id', {
        secrets: { foreplay_api_token: 'encrypted-token' },
      });
    });
  });

  // ============================================
  // GET /status
  // ============================================
  describe('GET /api/oauth/foreplay/status', () => {
    it('should return disconnected if no token in secrets', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: {} });

      const response = await request(app)
        .get('/api/oauth/foreplay/status')
        .expect(200);

      expect(response.body).toEqual({ connected: false, boards: [] });
    });

    it('should return disconnected if decryption fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { foreplay_api_token: 'corrupted' },
      });
      mockDecryptPassword.mockImplementation(() => { throw new Error('Decryption failed'); });

      const response = await request(app)
        .get('/api/oauth/foreplay/status')
        .expect(200);

      expect(response.body).toEqual({ connected: false, boards: [] });
    });

    it('should return connected with boards on valid token', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { foreplay_api_token: 'encrypted-token' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'real-token' });
      mockAxiosGet.mockResolvedValue({
        data: { data: [{ id: 'board-1', name: 'Board 1' }] },
      });

      const response = await request(app)
        .get('/api/oauth/foreplay/status')
        .expect(200);

      expect(response.body).toEqual({
        connected: true,
        boards: [{ id: 'board-1', name: 'Board 1', description: undefined }],
      });
    });

    it('should return disconnected if Foreplay API fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { foreplay_api_token: 'encrypted-token' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'expired-token' });
      mockAxiosGet.mockRejectedValue(new Error('401'));

      const response = await request(app)
        .get('/api/oauth/foreplay/status')
        .expect(200);

      expect(response.body).toEqual({ connected: false, boards: [] });
    });
  });

  // ============================================
  // GET /boards/:boardId/ads
  // ============================================
  describe('GET /api/oauth/foreplay/boards/:boardId/ads', () => {
    it('should return 401 if not connected', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: {} });

      const response = await request(app)
        .get('/api/oauth/foreplay/boards/board-1/ads')
        .expect(401);

      expect(response.body.error).toBe('Foreplay not connected');
    });

    it('should return ads for a board', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { foreplay_api_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'token' });
      mockAxiosGet.mockResolvedValue({
        data: {
          data: [{ id: 'ad-1', name: 'Cool Ad', headline: 'Buy Now' }],
          metadata: { cursor: 'next' },
        },
      });

      const response = await request(app)
        .get('/api/oauth/foreplay/boards/board-1/ads?limit=10')
        .expect(200);

      expect(response.body.ads).toHaveLength(1);
      expect(response.body.cursor).toBe('next');
    });

    it('should return 500 on API error', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { foreplay_api_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'token' });
      mockAxiosGet.mockRejectedValue(new Error('API Error'));

      const response = await request(app)
        .get('/api/oauth/foreplay/boards/board-1/ads')
        .expect(500);

      expect(response.body.error).toBe('Failed to fetch board ads');
    });
  });

  // ============================================
  // GET /swipefile/ads
  // ============================================
  describe('GET /api/oauth/foreplay/swipefile/ads', () => {
    it('should return 401 if not connected', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'test-user-id', secrets: {} });

      const response = await request(app)
        .get('/api/oauth/foreplay/swipefile/ads')
        .expect(401);

      expect(response.body.error).toBe('Foreplay not connected');
    });

    it('should return swipefile ads', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { foreplay_api_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'token' });
      mockAxiosGet.mockResolvedValue({
        data: {
          data: [{ id: 'ad-1', name: 'Saved Ad' }],
          metadata: {},
        },
      });

      const response = await request(app)
        .get('/api/oauth/foreplay/swipefile/ads?limit=25')
        .expect(200);

      expect(response.body.ads).toHaveLength(1);
    });

    it('should return 500 on API error', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { foreplay_api_token: 'encrypted' },
      });
      mockDecryptPassword.mockReturnValue({ password: 'token' });
      mockAxiosGet.mockRejectedValue(new Error('API Error'));

      const response = await request(app)
        .get('/api/oauth/foreplay/swipefile/ads')
        .expect(500);

      expect(response.body.error).toBe('Failed to fetch swipefile ads');
    });
  });

  // ============================================
  // POST /disconnect
  // ============================================
  describe('POST /api/oauth/foreplay/disconnect', () => {
    it('should remove foreplay_api_token and preserve other secrets', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { foreplay_api_token: 'enc-token', other_secret: 'keep-me' },
      });
      mockUpdateUser.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/oauth/foreplay/disconnect')
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
        .post('/api/oauth/foreplay/disconnect')
        .expect(200);

      expect(response.body).toEqual({ success: true });
      expect(mockUpdateUser).toHaveBeenCalledWith('test-user-id', {
        secrets: {},
      });
    });

    it('should return 500 if database update fails', async () => {
      mockGetUserById.mockResolvedValue({
        userId: 'test-user-id',
        secrets: { foreplay_api_token: 'enc' },
      });
      mockUpdateUser.mockRejectedValue(new Error('DB error'));

      const response = await request(app)
        .post('/api/oauth/foreplay/disconnect')
        .expect(500);

      expect(response.body.error).toBe('Failed to disconnect Foreplay');
    });
  });
});
