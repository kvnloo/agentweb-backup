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
      expect(mockService.youSearchWeb).toHaveBeenCalledWith('test query', 5);
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
      expect(mockService.generateImage).toHaveBeenCalledWith(
        'a cat', 'cat.png', '1024x1024', 'medium', [],
        'user-123', '', undefined, undefined, undefined, undefined
      );
    });
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
});
