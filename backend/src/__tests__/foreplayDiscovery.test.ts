/**
 * Tests for Foreplay discovery search via emmaApi route.
 * Covers: no-token error message, successful discovery search, credit note.
 */
import request from 'supertest';
import express, { Application } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
}));

// ENG-973 put a token-quota gate in front of this router. This suite covers
// discovery-search behaviour, not the gate, so the meter is stubbed as "under
// allowance". Gate behaviour itself is covered by emmaApiTokenBudget.test.ts.
jest.mock('../services/tokenUsageService', () => ({
  checkTokenUsage: jest.fn().mockResolvedValue({
    allowed: true,
    warning: false,
    used: 0,
    allowance: null,
    bonus: 0,
    effectiveAllowance: null,
    percentUsed: 0,
    month: '2026-08',
  }),
}));

const mockSearchForeplayDiscovery = jest.fn();
const mockSearchForeplayAds = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    searchForeplayDiscovery: (...args: any[]) => mockSearchForeplayDiscovery(...args),
    searchForeplayAds: (...args: any[]) => mockSearchForeplayAds(...args),
    searchKnowledgeBase: jest.fn(),
    listKnowledgeBaseFiles: jest.fn(),
    readKnowledgeBaseFiles: jest.fn(),
    createKnowledgeBase: jest.fn(),
    updateKnowledgeBaseFile: jest.fn(),
    searchWeb: jest.fn(),
    performDeepResearchTool: jest.fn(),
    generateImage: jest.fn(),
    getImageApiDefaultModel: jest.fn(),
  },
}));

import emmaApiRouter from '../routes/emmaApi';

const createTestApp = (): Application => {
  const app = express();
  app.use(express.json());
  app.use('/api/emma', emmaApiRouter);
  return app;
};

describe('Foreplay Discovery via emmaApi', () => {
  let app: Application;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/emma/search-foreplay-discovery', () => {
    it('should return discovery results with credit note', async () => {
      mockSearchForeplayDiscovery.mockResolvedValue({
        success: true,
        message: 'Found 2 ads in Foreplay discovery database matching "ecommerce"',
        query: 'ecommerce',
        results: [
          { content: '# Ad One\n**Brand:** Acme', source: 'foreplay-discovery/Acme/Ad One' },
          { content: '# Ad Two\n**Brand:** Brand', source: 'foreplay-discovery/Brand/Ad Two' },
        ],
        totalResults: 2,
        hasMore: false,
        note: "Each result costs 1 Foreplay credit. Discovery searches Foreplay's full database of millions of ads, not just your saved swipefile.",
      });

      const response = await request(app)
        .post('/api/emma/search-foreplay-discovery')
        .send({ query: 'ecommerce', max_results: 10 })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.results).toHaveLength(2);
      expect(response.body.note).toContain('credit');
      expect(mockSearchForeplayDiscovery).toHaveBeenCalledWith(
        'ecommerce',
        expect.objectContaining({ maxResults: 10 }),
        'test-user-id'
      );
    });

    it('should propagate missing platform key error', async () => {
      mockSearchForeplayDiscovery.mockResolvedValue({
        success: false,
        message: 'Foreplay is not configured. The platform-wide Foreplay API key is missing from AWS Secrets Manager — an admin needs to add it. Users can also connect their own Foreplay account in Knowledge Base settings.',
        results: [],
        totalResults: 0,
      });

      const response = await request(app)
        .post('/api/emma/search-foreplay-discovery')
        .send({ query: 'checkout' })
        .expect(200);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('AWS Secrets Manager');
      expect(response.body.message).toContain('admin');
    });

    it('should pass filters to service', async () => {
      mockSearchForeplayDiscovery.mockResolvedValue({ success: true, results: [], totalResults: 0 });

      await request(app)
        .post('/api/emma/search-foreplay-discovery')
        .send({
          query: 'skincare',
          format: ['video'],
          platform: ['facebook'],
          niche: ['beauty'],
          live: true,
          sort: 'longest_running',
        })
        .expect(200);

      expect(mockSearchForeplayDiscovery).toHaveBeenCalledWith(
        'skincare',
        expect.objectContaining({
          format: ['video'],
          platform: ['facebook'],
          niche: ['beauty'],
          live: true,
          sort: 'longest_running',
        }),
        'test-user-id'
      );
    });
  });

  describe('POST /api/emma/search-ads-knowledge-base error message', () => {
    it('should return admin-actionable error when platform key missing', async () => {
      mockSearchForeplayAds.mockResolvedValue({
        success: false,
        message: 'Foreplay is not configured. The platform-wide Foreplay API key is missing from AWS Secrets Manager — an admin needs to add it. Users can also connect their own Foreplay account in Knowledge Base settings.',
        results: [],
        totalResults: 0,
      });

      const response = await request(app)
        .post('/api/emma/search-ads-knowledge-base')
        .send({ query: 'checkout' })
        .expect(200);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('AWS Secrets Manager');
      expect(response.body.message).not.toContain('Connect your Foreplay account in Knowledge Base settings');
    });
  });
});
