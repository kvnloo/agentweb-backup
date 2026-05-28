jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listCampaigns: jest.fn().mockResolvedValue([
      { id: '1', name: 'Test Campaign', status: 'ENABLED', type: 'SEARCH', resourceName: 'customers/123/campaigns/1' },
    ]),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  },
}));

import request from 'supertest';
import express from 'express';
import router from '../routes/googleAds';

const app = express();
app.use(express.json());
app.use('/', router);

describe('GET /campaigns', () => {
  it('returns campaigns for a valid customerId', async () => {
    const res = await request(app)
      .get('/campaigns?customerId=1234567890')
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].name).toBe('Test Campaign');
  });

  it('returns 400 when customerId is missing', async () => {
    const res = await request(app).get('/campaigns').expect(400);
    expect(res.body.error).toMatch(/customerId/i);
  });

  it('returns 401 when auth error thrown', async () => {
    const { googleAdsService } = require('../services/googleAdsService');
    const err = new Error('Google Ads account not found');
    (err as any).isGoogleAdsAuthError = true;
    googleAdsService.listCampaigns.mockRejectedValueOnce(err);

    const res = await request(app)
      .get('/campaigns?customerId=1234567890')
      .expect(401);
    expect(res.body.error).toContain('not found');
  });
});
