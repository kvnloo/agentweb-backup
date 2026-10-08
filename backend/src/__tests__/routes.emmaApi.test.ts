/**
 * Tests for routes/emmaApi.ts
 * Tests the REST endpoints for AI operations with mocked agentModeService.
 */

import express from 'express';
import request from 'supertest';

// Mock auth middleware to inject user
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'test@example.com', isAdmin: false };
    next();
  },
  AuthenticatedRequest: jest.fn(),
}));

// ENG-973 put a token-quota gate in front of this router. This suite covers
// handler behaviour, not the gate, so the meter is stubbed as "under allowance".
// Gate behaviour itself is covered by emmaApiTokenBudget.test.ts.
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

// Mock agentModeService
const mockService = {
  youSearchWeb: jest.fn(),
  searchKnowledgeBase: jest.fn(),
  listKnowledgeBaseFiles: jest.fn(),
  readKnowledgeBaseFiles: jest.fn(),
  generateImage: jest.fn(),
  generateVideo: jest.fn(),
  describeImage: jest.fn(),
  describeVideo: jest.fn(),
  saveFile: jest.fn(),
  createSocialMediaPosts: jest.fn(),
  linkedinOutreach: jest.fn(),
  postOnConnectedAccount: jest.fn(),
  performDataAnalysis: jest.fn(),
  readFileContent: jest.fn(),
  createHtmlFile: jest.fn(),
  listHtmlTemplates: jest.fn(),
  listTaskTemplates: jest.fn(),
  searchLeads: jest.fn(),
  repairBlogArticle: jest.fn(),
  callMetaMarketingApi: jest.fn(),
  getMetaAdsMetrics: jest.fn(),
};

jest.mock('../services/agentModeService', () => ({
  agentModeService: mockService,
}));

const mockChatbotDb = { getChatSession: jest.fn() };
jest.mock('../services/chatbotService', () => ({
  chatbotDb: mockChatbotDb,
}));

import emmaApiRoutes from '../routes/emmaApi';

describe('Emma API Routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/emma', emmaApiRoutes);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── FAIL tests ───────────────────────────────────────────────────────

  describe('POST /api/emma/you-search-web - error cases', () => {
    it('should return 500 when service throws', async () => {
      mockService.youSearchWeb.mockRejectedValue(new Error('Search failed'));

      const res = await request(app)
        .post('/api/emma/you-search-web')
        .send({ query: 'test' });

      expect(res.status).toBe(500);
      expect(res.body.message).toBe('Search failed');
    });
  });

  describe('POST /api/emma/generate-image - error cases', () => {
    it('should return 500 when generation fails', async () => {
      mockService.generateImage.mockRejectedValue(new Error('Model unavailable'));

      const res = await request(app)
        .post('/api/emma/generate-image')
        .send({ prompt: 'a cat', filename: 'cat.png' });

      expect(res.status).toBe(500);
      expect(res.body.message).toBe('Model unavailable');
    });
  });

  describe('POST /api/emma/save-file - error cases', () => {
    it('should return 500 when save fails', async () => {
      mockService.saveFile.mockRejectedValue(new Error('Storage error'));

      const res = await request(app)
        .post('/api/emma/save-file')
        .send({ file_name: 'test.txt', file_content: 'hello' });

      expect(res.status).toBe(500);
      expect(res.body.message).toBe('Storage error');
    });
  });

  // ─── SUCCESS tests ────────────────────────────────────────────────────

  describe('POST /api/emma/you-search-web', () => {
    it('should search the web and return results', async () => {
      mockService.youSearchWeb.mockResolvedValue({ results: [{ title: 'Test' }] });

      const res = await request(app)
        .post('/api/emma/you-search-web')
        .send({ query: 'test query', max_results: 5 });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);
      /*
       * youSearchWeb gained freshness/includeDomains/userId (and a purpose default) on main; the
       * route passes them and only this assertion was left at the old arity. Production is
       * correct — the userId is what lets the search be attributed and billed to the caller.
       */
      expect(mockService.youSearchWeb).toHaveBeenCalledWith('test query', 5, undefined, undefined, 'user-123');
    });
  });

  describe('GET /api/emma/knowledge-bases', () => {
    it('should list knowledge bases for the user', async () => {
      mockService.listKnowledgeBaseFiles.mockResolvedValue({ files: [] });

      const res = await request(app)
        .get('/api/emma/knowledge-bases');

      expect(res.status).toBe(200);
      expect(mockService.listKnowledgeBaseFiles).toHaveBeenCalledWith('user-123', {
        modified_after: undefined,
        modified_before: undefined,
        limit: undefined,
        offset: undefined,
        kb_type: undefined,
      });
    });
  });

  describe('POST /api/emma/search-knowledge-base', () => {
    it('should search knowledge base', async () => {
      mockService.searchKnowledgeBase.mockResolvedValue({ results: [] });

      const res = await request(app)
        .post('/api/emma/search-knowledge-base')
        .send({ query: 'test', max_results: 3 });

      expect(res.status).toBe(200);
      expect(mockService.searchKnowledgeBase).toHaveBeenCalledWith('test', 3, 'user-123');
    });
  });

  describe('POST /api/emma/generate-image', () => {
    it('should generate an image with correct params', async () => {
      mockService.generateImage.mockResolvedValue({ url: 'https://s3/image.png' });

      const res = await request(app)
        .post('/api/emma/generate-image')
        .send({ prompt: 'a cat', filename: 'cat.png', size: '1024x1024' });

      expect(res.status).toBe(200);
      // ENG-343 widened the signature with (confirm, category). A request that
      // declares no category threads `undefined` through unchanged — the route
      // must NOT invent a default, because the service guard is what turns a
      // missing declaration into a visible failure (decision comment point 3).
      expect(mockService.generateImage).toHaveBeenCalledWith(
        'a cat', 'cat.png', '1024x1024', 'medium', [],
        'user-123', '', undefined, undefined, undefined, undefined
      );
    });

    // ENG-343: the MCP `generate_image` tool reaches the service over this HTTP
    // route, so a declared category has to survive the hop. Pin the VALUE, not
    // just the arity — an assertion that only counted arguments would still pass
    // if the route silently dropped the field.
    it.each(['ad', 'organic_post'])(
      'threads a declared category=%s through to the service',
      async (category) => {
        mockService.generateImage.mockResolvedValue({ url: 'https://s3/image.png' });

        const res = await request(app)
          .post('/api/emma/generate-image')
          .send({ prompt: 'a cat', filename: 'cat.png', category });

        expect(res.status).toBe(200);
        expect(mockService.generateImage).toHaveBeenCalledWith(
          'a cat', 'cat.png', '1024x1024', 'medium', [],
          'user-123', '', undefined, undefined, undefined, category
        );
      }
    );
  });

  describe('POST /api/emma/save-file', () => {
    it('should save a file', async () => {
      mockService.saveFile.mockResolvedValue({ url: 'https://s3/file.txt' });

      const res = await request(app)
        .post('/api/emma/save-file')
        .send({ file_name: 'test.txt', file_content: 'hello world' });

      expect(res.status).toBe(200);
      expect(mockService.saveFile).toHaveBeenCalledWith('test.txt', 'hello world', 'user-123', '');
    });
  });

  describe('POST /api/emma/social-posts', () => {
    it('should create social media posts', async () => {
      mockService.createSocialMediaPosts.mockResolvedValue({ created: 1 });

      const res = await request(app)
        .post('/api/emma/social-posts')
        .send({ posts: [{ content: 'test post' }] });

      expect(res.status).toBe(200);
      expect(mockService.createSocialMediaPosts).toHaveBeenCalledWith(
        [{ content: 'test post' }], 'user-123', undefined
      );
    });
  });

  describe('POST /api/emma/search-leads', () => {
    it('should search leads with filters', async () => {
      mockService.searchLeads.mockResolvedValue({ leads: [] });

      const res = await request(app)
        .post('/api/emma/search-leads')
        .send({
          list_id: 'list-1',
          filters: [{ field: 'email', operator: 'contains', value: '@test.com' }],
          limit: 10
        });

      expect(res.status).toBe(200);
      expect(mockService.searchLeads).toHaveBeenCalledWith(
        'list-1',
        [{ field: 'email', operator: 'contains', value: '@test.com' }],
        'user-123',
        10
      );
    });
  });

  describe('GET /api/emma/html-templates', () => {
    it('should list HTML templates', async () => {
      mockService.listHtmlTemplates.mockResolvedValue({ templates: [] });

      const res = await request(app)
        .get('/api/emma/html-templates');

      expect(res.status).toBe(200);
      expect(mockService.listHtmlTemplates).toHaveBeenCalledWith('user-123');
    });
  });

  describe('GET /api/emma/task-templates', () => {
    it('should list task templates', async () => {
      mockService.listTaskTemplates.mockResolvedValue({ templates: [] });

      const res = await request(app)
        .get('/api/emma/task-templates');

      expect(res.status).toBe(200);
      expect(mockService.listTaskTemplates).toHaveBeenCalled();
    });
  });

  // Greptile P1/security ("Session does not bind authorization"): session_id
  // feeds the Meta objective gate's confirmation check, so an authenticated
  // caller supplying a DIFFERENT user's session_id must be rejected, never
  // silently forwarded as if it were the caller's own confirmation.
  describe('POST /api/emma/meta-ads/marketing-api — session ownership', () => {
    it('proceeds when no session_id is provided (gate handles the no-session case itself)', async () => {
      mockService.callMetaMarketingApi.mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/api/emma/meta-ads/marketing-api')
        .send({ entity_type: 'CAMPAIGN', action: 'LIST', account_id: 'acct-1' });

      expect(res.status).toBe(200);
      expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
      expect(mockService.callMetaMarketingApi).toHaveBeenCalledWith(
        'user-123', 'CAMPAIGN', 'LIST', 'acct-1', undefined, undefined, undefined, undefined, undefined,
      );
    });

    it('proceeds when session_id belongs to the authenticated user', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({ sessionId: 'sess-1', userId: 'user-123' });
      mockService.callMetaMarketingApi.mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/api/emma/meta-ads/marketing-api')
        .send({ entity_type: 'CAMPAIGN', action: 'CREATE', account_id: 'acct-1', session_id: 'sess-1' });

      expect(res.status).toBe(200);
      expect(mockService.callMetaMarketingApi).toHaveBeenCalledWith(
        'user-123', 'CAMPAIGN', 'CREATE', 'acct-1', undefined, undefined, undefined, undefined, 'sess-1',
      );
    });

    it('REJECTS (403) when session_id belongs to a DIFFERENT user — never forwarded to the gate', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue({ sessionId: 'sess-1', userId: 'someone-else' });

      const res = await request(app)
        .post('/api/emma/meta-ads/marketing-api')
        .send({ entity_type: 'CAMPAIGN', action: 'CREATE', account_id: 'acct-1', session_id: 'sess-1' });

      expect(res.status).toBe(403);
      expect(mockService.callMetaMarketingApi).not.toHaveBeenCalled();
    });

    it('REJECTS (403) when session_id does not exist at all', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/emma/meta-ads/marketing-api')
        .send({ entity_type: 'CAMPAIGN', action: 'CREATE', account_id: 'acct-1', session_id: 'nonexistent' });

      expect(res.status).toBe(403);
      expect(mockService.callMetaMarketingApi).not.toHaveBeenCalled();
    });
  });

  /*
   * ENG-1725: this route used to destructure parent_id/entity_id/fields off the request body and
   * pass them positionally into callMetaMarketingApi's (campaign_id, ad_set_id, ad_id) slots —
   * none of those names exist in call_meta_marketing_api's own published tool schema
   * (emma/tools.ts), which documents campaign_id/ad_set_id/ad_id, and whose execute() handler (the
   * path every LLM/agent tool call actually takes) already passed those through correctly. `fields`
   * in particular was never an id at all — a caller supplying it could have it silently occupy the
   * ad_id slot. These pin that the route now reads the documented names directly, matching the
   * agent tool-calling path it was previously out of sync with.
   */
  describe('POST /api/emma/meta-ads/marketing-api — id field mapping (ENG-1725)', () => {
    it('threads campaign_id straight through to the campaign_id slot', async () => {
      mockService.callMetaMarketingApi.mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/api/emma/meta-ads/marketing-api')
        .send({ entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: 'acct-1', campaign_id: 'camp-9', params: { status: 'PAUSED' } });

      expect(res.status).toBe(200);
      expect(mockService.callMetaMarketingApi).toHaveBeenCalledWith(
        'user-123', 'CAMPAIGN', 'UPDATE', 'acct-1', 'camp-9', undefined, undefined, { status: 'PAUSED' }, undefined,
      );
    });

    it('threads ad_set_id straight through to the ad_set_id slot', async () => {
      mockService.callMetaMarketingApi.mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/api/emma/meta-ads/marketing-api')
        .send({ entity_type: 'AD_SET', action: 'UPDATE', account_id: 'acct-1', ad_set_id: 'adset-9', params: { status: 'PAUSED' } });

      expect(res.status).toBe(200);
      expect(mockService.callMetaMarketingApi).toHaveBeenCalledWith(
        'user-123', 'AD_SET', 'UPDATE', 'acct-1', undefined, 'adset-9', undefined, { status: 'PAUSED' }, undefined,
      );
    });

    it('threads ad_id straight through to the ad_id slot', async () => {
      mockService.callMetaMarketingApi.mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/api/emma/meta-ads/marketing-api')
        .send({ entity_type: 'AD', action: 'DELETE', account_id: 'acct-1', ad_id: 'ad-9' });

      expect(res.status).toBe(200);
      expect(mockService.callMetaMarketingApi).toHaveBeenCalledWith(
        'user-123', 'AD', 'DELETE', 'acct-1', undefined, undefined, 'ad-9', undefined, undefined,
      );
    });

    it('never lets params.fields land in an id slot', async () => {
      mockService.callMetaMarketingApi.mockResolvedValue({ success: true });

      const res = await request(app)
        .post('/api/emma/meta-ads/marketing-api')
        .send({
          entity_type: 'CAMPAIGN', action: 'LIST', account_id: 'acct-1',
          fields: 'id,name,status', // a genuine field-selection value, shaped nothing like an id
        });

      expect(res.status).toBe(200);
      const call = mockService.callMetaMarketingApi.mock.calls[0];
      // campaign_id, ad_set_id, ad_id (positions 4-6) must all stay undefined — `fields` has no
      // slot in this call at all anymore, so it cannot land in any of them.
      expect(call[4]).toBeUndefined();
      expect(call[5]).toBeUndefined();
      expect(call[6]).toBeUndefined();
    });
  });

  describe('POST /api/emma/meta-ads/metrics — typed gateway parity', () => {
    it.each([
      [{ campaign_ids: [' 123 ', '123'] }, ['123']],
      [{ campaign_ids: '["123","456"]' }, ['123', '456']],
      [{ campaign_id: '789' }, ['789']],
    ])('normalizes supported campaign-id shapes before service dispatch', async (body, expectedIds) => {
      mockService.getMetaAdsMetrics.mockResolvedValue({ success: true });

      const res = await request(app).post('/api/emma/meta-ads/metrics').send(body);

      expect(res.status).toBe(200);
      expect(mockService.getMetaAdsMetrics).toHaveBeenCalledWith('7d', 'user-123', expectedIds, undefined);
    });

    it('preserves the HTTP-200 invalid campaign_ids envelope', async () => {
      const res = await request(app).post('/api/emma/meta-ads/metrics').send({ timeframe: '7d' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: false,
        message: 'campaign_ids is required and must contain at least one campaign ID.',
        error: 'Invalid campaign_ids',
      });
      expect(mockService.getMetaAdsMetrics).not.toHaveBeenCalled();
    });
  });
});
