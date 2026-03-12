import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

// ── Mocks ──────────────────────────────────────────────────────────────────
jest.mock('../config/integrations', () => ({
  getYouTubeConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/youtube/callback',
    scopes: [
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    channelsUrl: 'https://www.googleapis.com/youtube/v3/channels',
  }),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn().mockResolvedValue({
    platform: 'youtube',
    account_id: 'UC1234567890',
    account_name: 'Test Channel',
    config: {
      account_type: 'channel',
      channel_id: 'UC1234567890',
      channel_name: 'Test Channel',
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_expires_at: Date.now() + 3600000,
      granted_scopes: ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.readonly'],
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'user@example.com' };
    next();
  },
}));

jest.mock('axios');
const axios = require('axios');

// ── App setup ──────────────────────────────────────────────────────────────
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';

import youtubeAuthRouter from '../routes/youtubeAuth';

const app = express();
app.use(express.json());
app.use('/api/oauth/youtube', youtubeAuthRouter);

// ── Helpers ────────────────────────────────────────────────────────────────
const generateValidState = (userId: string) =>
  jwt.sign({ userId, nonce: 'testnonce' }, 'test-jwt-secret', { expiresIn: '15m' });

// ── Tests ──────────────────────────────────────────────────────────────────
describe('YouTube OAuth Routes', () => {

  beforeEach(() => jest.clearAllMocks());

  // ── GET /init ────────────────────────────────────────────────────────────
  describe('GET /init', () => {
    it('returns an authorization URL', async () => {
      const res = await request(app).get('/api/oauth/youtube/init');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.url).toMatch(/accounts\.google\.com/);
    });

    it('URL contains required OAuth params', async () => {
      const res = await request(app).get('/api/oauth/youtube/init');
      const url = new URL(res.body.url);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('client_id')).toBe('test-client-id');
      expect(url.searchParams.get('redirect_uri')).toBeTruthy();
    });

    it('URL includes YouTube scopes', async () => {
      const res = await request(app).get('/api/oauth/youtube/init');
      const url = new URL(res.body.url);
      const scope = url.searchParams.get('scope') || '';
      expect(scope).toContain('youtube');
      expect(scope).toContain('userinfo.email');
    });
  });

  // ── GET /callback ────────────────────────────────────────────────────────
  describe('GET /callback', () => {
    it('redirects with code and state to frontend on success', async () => {
      const res = await request(app)
        .get('/api/oauth/youtube/callback?code=authcode123&state=somestate');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('localhost:5174');
      expect(res.headers.location).toContain('code=authcode123');
      expect(res.headers.location).toContain('state=somestate');
    });

    it('redirects with error when Google returns error', async () => {
      const res = await request(app)
        .get('/api/oauth/youtube/callback?error=access_denied');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=youtube_access_denied');
    });

    it('redirects with error when code is missing', async () => {
      const res = await request(app)
        .get('/api/oauth/youtube/callback?state=somestate');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=no_code_provided');
    });
  });

  // ── POST /finalize ───────────────────────────────────────────────────────
  describe('POST /finalize', () => {
    const mockTokenResponse = {
      data: {
        access_token: 'google-access-token',
        refresh_token: 'google-refresh-token',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
        token_type: 'Bearer',
      },
    };
    const mockProfileResponse = {
      data: {
        id: '12345',
        email: 'test@gmail.com',
        name: 'Test User',
        picture: 'https://example.com/photo.jpg',
        verified_email: true,
      },
    };
    const mockChannelsResponse = {
      data: {
        items: [{
          id: 'UC1234567890',
          snippet: {
            title: 'Test Channel',
            thumbnails: { default: { url: 'https://example.com/channel.jpg' } },
          },
          statistics: {
            subscriberCount: '1000',
            videoCount: '50',
          },
        }],
      },
    };

    it('exchanges code for tokens and returns channel + tokenSessionId', async () => {
      axios.post.mockResolvedValueOnce(mockTokenResponse);
      axios.get.mockResolvedValueOnce(mockProfileResponse);
      axios.get.mockResolvedValueOnce(mockChannelsResponse);

      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/youtube/finalize')
        .send({ code: 'valid-code', state });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.channel.id).toBe('UC1234567890');
      expect(res.body.channel.title).toBe('Test Channel');
      expect(res.body.tokenSessionId).toBeDefined();
    });

    it('returns 400 when code is missing', async () => {
      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/youtube/finalize')
        .send({ state });
      expect(res.status).toBe(400);
    });

    it('returns 400 when state is missing', async () => {
      const res = await request(app)
        .post('/api/oauth/youtube/finalize')
        .send({ code: 'some-code' });
      expect(res.status).toBe(400);
    });

    it('returns 403 when state JWT is invalid (CSRF)', async () => {
      const res = await request(app)
        .post('/api/oauth/youtube/finalize')
        .send({ code: 'some-code', state: 'invalid-state-token' });
      expect(res.status).toBe(403);
    });

    it('returns 403 when state userId does not match authenticated user', async () => {
      const state = generateValidState('different-user-456');
      const res = await request(app)
        .post('/api/oauth/youtube/finalize')
        .send({ code: 'some-code', state });
      expect(res.status).toBe(403);
    });

    it('returns 422 when required YouTube scopes were not granted', async () => {
      axios.post.mockResolvedValueOnce({
        data: {
          ...mockTokenResponse.data,
          scope: 'https://www.googleapis.com/auth/userinfo.email',
        },
      });

      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/youtube/finalize')
        .send({ code: 'valid-code', state });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain('insufficient_scopes');
    });

    it('returns 422 when no YouTube channel found', async () => {
      axios.post.mockResolvedValueOnce(mockTokenResponse);
      axios.get.mockResolvedValueOnce(mockProfileResponse);
      axios.get.mockResolvedValueOnce({ data: { items: [] } });

      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/youtube/finalize')
        .send({ code: 'valid-code', state });

      expect(res.status).toBe(422);
      expect(res.body.error).toContain('no_channel');
    });

    it('returns 500 when Google token exchange fails', async () => {
      axios.post.mockRejectedValueOnce(new Error('Google API error'));

      const state = generateValidState('user-123');
      const res = await request(app)
        .post('/api/oauth/youtube/finalize')
        .send({ code: 'bad-code', state });
      expect(res.status).toBe(500);
    });
  });

  // ── POST /connect ────────────────────────────────────────────────────────
  describe('POST /connect', () => {
    it('returns 400 when tokenSessionId is missing', async () => {
      const res = await request(app)
        .post('/api/oauth/youtube/connect')
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 401 when tokenSessionId is invalid or expired', async () => {
      const res = await request(app)
        .post('/api/oauth/youtube/connect')
        .send({ tokenSessionId: 'nonexistent-session' });
      expect(res.status).toBe(401);
    });
  });
});
