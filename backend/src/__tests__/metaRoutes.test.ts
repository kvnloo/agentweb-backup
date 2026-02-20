
import request from 'supertest';
import express from 'express';
// We need to mock the dependencies before importing the router
// using jest.mock

// Mock dependencies
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'user123' };
    next();
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  taskDb: {
    getTaskExecutions: jest.fn(),
    getTaskExecutionById: jest.fn(),
    updateTaskExecution: jest.fn(),
  },
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn(),
}));

// Mock metaApiFetch which is dynamically imported
jest.mock('../utils/metaApiFetch', () => ({
  fetchWithRetryAndPaging: jest.fn(),
}));

// Mock global fetch
global.fetch = jest.fn() as jest.Mock;

import metaRouter from '../routes/meta';
import { userDb, taskDb } from '../services/db';
import { getMetaAccessToken } from '../utils/secretsManager';
import { fetchWithRetryAndPaging } from '../utils/metaApiFetch';

const app = express();
app.use(express.json());
app.use('/api/meta', metaRouter);

describe('Meta Legacy Routes', () => {
  const mockUser = {
    id: 'user123',
    userId: 'user123',
    adAccount: '123456789',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({
      json: async () => ({}),
      ok: true,
      text: async () => '',
    });
  });

  describe('GET /account-status', () => {
    it('should return hasAdAccount: true when user has ad account', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

      const response = await request(app).get('/api/meta/account-status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ hasAdAccount: true });
    });

    it('should return hasAdAccount: false when user has no ad account', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ ...mockUser, adAccount: '' });

      const response = await request(app).get('/api/meta/account-status');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ hasAdAccount: false });
    });

    it('should return 404 if user not found', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(null);

      const response = await request(app).get('/api/meta/account-status');

      expect(response.status).toBe(404);
    });
  });

  describe('GET /ad-performance', () => {
    it('should return 400 if ad account not configured', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue({ ...mockUser, adAccount: '' });

      const response = await request(app).get('/api/meta/ad-performance?timeframe=7d');

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Ad account not configured');
    });

    it('should fetch and process performance data successfully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (getMetaAccessToken as jest.Mock).mockResolvedValue('mock-token');
      
      // Mock validation token check
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ id: '123', name: 'Test User' }),
        ok: true,
      });

      // Mock fetchWithRetryAndPaging responses for campaigns, adsets, ads, and insights
      const mockFetch = fetchWithRetryAndPaging as jest.Mock;
      mockFetch.mockResolvedValueOnce({ data: [] }); // campaigns
      mockFetch.mockResolvedValueOnce({ data: [] }); // adsets
      mockFetch.mockResolvedValueOnce({ data: [] }); // ads
      mockFetch.mockResolvedValueOnce({ data: [] }); // ad insights
      mockFetch.mockResolvedValueOnce({ data: [] }); // adset insights
      mockFetch.mockResolvedValueOnce({ data: [] }); // campaign insights

      const response = await request(app).get('/api/meta/ad-performance?timeframe=7d');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('adPerformance');
      expect(response.body).toHaveProperty('campaignSummary');
    });

    it('should handle token validation failure', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (getMetaAccessToken as jest.Mock).mockResolvedValue('mock-token');

      // Mock validation token check failure
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: async () => ({ error: { message: 'Invalid token' } }),
        ok: true,
      });

      const response = await request(app).get('/api/meta/ad-performance');

      expect(response.status).toBe(401);
      expect(response.body.message).toContain('Meta access token validation failed');
    });
  });

  describe('GET /campaigns-and-adsets', () => {
    it('should fetch campaigns, adsets, and pages', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (getMetaAccessToken as jest.Mock).mockResolvedValue('mock-token');

      const mockFetch = global.fetch as jest.Mock;
      // 1. Campaigns
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ data: [{ id: 'c1', name: 'Campaign 1' }] }),
        ok: true,
      });
      // 2. AdSets
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ data: [{ id: 'as1', name: 'AdSet 1', status: 'ACTIVE', is_dynamic_creative: true }] }),
        ok: true,
      });
      // 3. Business Account
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ business: { id: 'biz1' } }),
        ok: true,
      });
      // 4. Pages
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ data: [{ id: 'p1', name: 'Page 1' }] }),
        ok: true,
      });

      const response = await request(app).get('/api/meta/campaigns-and-adsets');

      expect(response.status).toBe(200);
      expect(response.body.campaigns).toHaveLength(1);
      expect(response.body.adSets).toHaveLength(1);
      expect(response.body.adSets[0]).toHaveProperty('is_dynamic_creative', true);
      expect(response.body.pages).toHaveLength(1);
    });

    it('should handle missing business account', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (getMetaAccessToken as jest.Mock).mockResolvedValue('mock-token');

      const mockFetch = global.fetch as jest.Mock;
      // Campaigns
      mockFetch.mockResolvedValueOnce({ json: async () => ({ data: [] }), ok: true });
      // AdSets
      mockFetch.mockResolvedValueOnce({ json: async () => ({ data: [] }), ok: true });
      // Business Account (missing)
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ business: null }),
        ok: true,
      });

      const response = await request(app).get('/api/meta/campaigns-and-adsets');

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('No business account found');
    });
  });

  describe('GET /ads-history/:taskId', () => {
    it('should return ads history for a task', async () => {
      (taskDb.getTaskExecutions as jest.Mock).mockResolvedValue([
        {
          executionId: 'exec1',
          userId: 'user123',
          createdAt: new Date().toISOString(),
          result_files: [
            {
              url: 'http://image.url',
              filename: 'ad.jpg',
              meta_ad: { id: 'ad1' }
            }
          ]
        }
      ]);

      const response = await request(app).get('/api/meta/ads-history/task1');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe('ad1');
    });

    it('should return empty array if no executions found', async () => {
      (taskDb.getTaskExecutions as jest.Mock).mockResolvedValue(null);

      const response = await request(app).get('/api/meta/ads-history/task1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });

  describe('POST /create-ad', () => {
    const validPayload = {
      imageUrl: 'http://example.com/image.jpg',
      campaignId: 'c1',
      adSetId: 'as1',
      adName: 'Test Ad',
      primary_texts: ['Ad Body'],
      headlines: ['Ad Headline'],
      url_descriptions: ['Ad Description'],
      utm_params: { utm_source: 'fb', utm_medium: 'cpc' },
      pageId: 'p1',
      taskId: 't1',
      executionId: 'e1'
    };

    it('should create an ad successfully', async () => {
      (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
      (getMetaAccessToken as jest.Mock).mockResolvedValue('mock-token');

      const mockFetch = global.fetch as jest.Mock;
      
      // 1. Account verification
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ account_status: 1 }),
        ok: true,
      });
      // 2. Download image
      mockFetch.mockResolvedValueOnce({
        arrayBuffer: async () => Buffer.from('image-data'),
        ok: true,
      });
      // 3. Upload image to Meta (adimages) - Not used directly in new flow?, wait, checking meta.ts
      // In meta.ts, it uses sharp? No, it tries to use sharp but has fallback.
      // It posts to /act_{adAccount}/adimages
      
      // We need to mock the sequence of calls in meta.ts logic:
      // - Account Check
      // - Image Download
      // - Image Upload (POST adimages) -> returns images: { filename: { hash: 'h1' } }
      // - Create Creative (POST adcreatives) -> returns { id: 'cr1' }
      // - Create Ad (POST ads) -> returns { id: 'ad1' }
      
      // 3. Upload Image Response
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ images: { 'image.jpg': { hash: 'hash1' } } }),
        ok: true,
      });
      
      // 4. Create Creative Response
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ id: 'creative1' }),
        ok: true,
      });

      // 5. Create Ad Response
      mockFetch.mockResolvedValueOnce({
        json: async () => ({ id: 'ad1' }),
        ok: true,
      });

      const response = await request(app).post('/api/meta/create-ad').send(validPayload);

      expect(response.status).toBe(200);
      expect(response.body.adId).toBe('ad1');
      expect(response.body.success).toBe(true);

      const fetchCalls = mockFetch.mock.calls;
      const creativeCall = fetchCalls.find(call => typeof call[0] === 'string' && call[0].includes('/adcreatives'));
      if (creativeCall) {
        const bodyStr = typeof creativeCall[1]?.body === 'string' ? creativeCall[1].body : '';
        expect(bodyStr).toContain('Ad Body');
        expect(bodyStr).toContain('Ad Headline');
        expect(bodyStr).toContain('Ad Description');
        expect(bodyStr).toContain('utm_source=fb');
        expect(bodyStr).toContain('utm_medium=cpc');
      }
    });

    it('should validate required fields', async () => {
      const response = await request(app).post('/api/meta/create-ad').send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Missing required fields');
    });
  });
});
