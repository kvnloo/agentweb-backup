// Tests for blog article screenshot support and Webflow publishing fixes

import { AgentModeService } from '../services/agentModeService';

// Mock axios
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

// Mock blog controller
const mockGetWebflowConfig = jest.fn();
const mockGenerateBlogContent = jest.fn();
const mockGenerateBlogImage = jest.fn();
const mockGenerateBlogHtml = jest.fn();
jest.mock('../controllers/blog', () => ({
  getWebflowConfig: (...args: any[]) => mockGetWebflowConfig(...args),
  generateBlogContent: (...args: any[]) => mockGenerateBlogContent(...args),
  generateBlogImage: (...args: any[]) => mockGenerateBlogImage(...args),
  generateBlogHtml: (...args: any[]) => mockGenerateBlogHtml(...args),
  restyleContent: jest.fn(),
}));

// Mock s3
const mockUploadFileToS3 = jest.fn();
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: (...args: any[]) => mockUploadFileToS3(...args),
}));

// Mock database
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn().mockResolvedValue({}),
  },
}));

describe('Blog Fixes', () => {
  let agentModeService: AgentModeService;
  let mockGetUserById: jest.Mock;
  let mockAxiosGet: jest.Mock;
  let mockAxiosPost: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();

    const dbModule = require('../services/db');
    mockGetUserById = dbModule.userDb.getUserById;

    const axiosModule = require('axios');
    mockAxiosGet = axiosModule.default.get;
    mockAxiosPost = axiosModule.default.post;
  });

  // ============================================================
  // Bug 1: Screenshot / image_urls support in create_blog_article
  // ============================================================

  describe('create_blog_article — image_urls support', () => {
    const setupCreateMocks = () => {
      mockGenerateBlogContent.mockResolvedValue({
        title: 'Test Title',
        description: 'Test description',
        content: '# Step 1\n\nDo this first.\n\n# Step 2\n\nDo this next.',
        imagePrompt: 'A test image',
      });
      mockGenerateBlogImage.mockResolvedValue({
        imageUrl: 'https://s3.example.com/hero.png',
      });
      mockGenerateBlogHtml.mockReturnValue('<html>test</html>');
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/blog-123.html',
      });
    };

    // FAILURE TEST 1: image_urls with invalid URLs should be skipped gracefully
    it('should skip invalid image URLs without failing', async () => {
      setupCreateMocks();

      const result = await (agentModeService as any).createBlogArticle(
        'Test Title',
        '# Content\n\nSome text here.',
        'medium',
        '',
        '',
        'user-1',
        'session-1',
        'default',
        false,
        ['not-a-url', '', null] // invalid image_urls
      );

      expect(result.success).toBe(true);
      // Should still create the article without images
    });

    // FAILURE TEST 2: empty image_urls array should work same as no images
    it('should handle empty image_urls array same as omitted', async () => {
      setupCreateMocks();

      const result = await (agentModeService as any).createBlogArticle(
        'Test Title',
        '# Content\n\nSome text.',
        'medium',
        '',
        '',
        'user-1',
        'session-1',
        'default',
        false,
        [] // empty array
      );

      expect(result.success).toBe(true);
      // generateBlogHtml should receive the content without any injected images
      expect(mockGenerateBlogHtml).toHaveBeenCalled();
      const htmlCallContent = mockGenerateBlogHtml.mock.calls[0][2]; // 3rd arg = content
      expect(htmlCallContent).not.toContain('<img');
    });

    // FAILURE TEST 3: image_urls should not break when content has no headings
    it('should append images at end when content has no section breaks', async () => {
      mockGenerateBlogContent.mockResolvedValue({
        title: 'Simple Post',
        description: 'Desc',
        content: 'Just a plain paragraph without any headings or sections.',
        imagePrompt: 'test',
      });
      mockGenerateBlogImage.mockResolvedValue({
        imageUrl: 'https://s3.example.com/hero.png',
      });
      mockGenerateBlogHtml.mockReturnValue('<html>test</html>');
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/blog.html',
      });

      const result = await (agentModeService as any).createBlogArticle(
        'Simple',
        'Plain text.',
        'medium',
        '',
        '',
        'user-1',
        'session-1',
        'default',
        false,
        ['https://s3.example.com/screenshot1.png']
      );

      expect(result.success).toBe(true);
      const htmlCallContent = mockGenerateBlogHtml.mock.calls[0][2];
      expect(htmlCallContent).toContain('https://s3.example.com/screenshot1.png');
    });

    // SUCCESS TEST: image_urls should be embedded in the generated content
    it('should embed provided image URLs between content sections', async () => {
      setupCreateMocks();

      const result = await (agentModeService as any).createBlogArticle(
        'User Guide',
        '# Step 1\n\nDo this.\n\n# Step 2\n\nDo that.',
        'medium',
        '',
        '',
        'user-1',
        'session-1',
        'default',
        false,
        ['https://s3.example.com/step1.png', 'https://s3.example.com/step2.png']
      );

      expect(result.success).toBe(true);
      // The content passed to generateBlogHtml should contain the image URLs
      const htmlCallContent = mockGenerateBlogHtml.mock.calls[0][2];
      expect(htmlCallContent).toContain('https://s3.example.com/step1.png');
      expect(htmlCallContent).toContain('https://s3.example.com/step2.png');
    });
  });

  // ============================================================
  // Bug 2: Webflow draft endpoint and field placement fixes
  // ============================================================

  describe('publish_blog_article — Webflow fixes', () => {
    const mockHtml = `<!DOCTYPE html><html><head><title>Test</title></head><body><div class="content"><p>Blog content</p></div></body></html>`;

    const mockWebflowConfig = {
      apiToken: 'test-token',
      siteId: 'test-site-id',
      collectionId: 'test-collection-id',
      fieldMappings: {
        summary: 'post-summary',
        body: 'post-body',
        image: 'main-image',
      },
    };

    const setupPublishMocks = () => {
      mockGetUserById.mockResolvedValue({
        userId: 'user-1',
        cmsType: 'Webflow',
      });
      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig);
      mockAxiosGet.mockResolvedValue({ data: mockHtml });
      mockAxiosPost.mockResolvedValue({
        data: { id: 'item-123', fieldData: { name: 'Test' } },
      });
    };

    // FAILURE TEST 1: draft endpoint should NOT include /sites/ prefix
    it('should use correct Webflow v2 draft endpoint without /sites/ prefix', async () => {
      setupPublishMocks();

      await agentModeService.publishBlogArticle(
        'Test Title',
        'Description',
        'https://example.com/hero.png',
        'https://example.com/blog.html',
        'user-1',
        'session-1',
        'draft'
      );

      const postCall = mockAxiosPost.mock.calls[0];
      const endpoint = postCall[0];

      // Should NOT contain /sites/ for draft endpoint in v2
      expect(endpoint).toBe(
        `https://api.webflow.com/v2/collections/${mockWebflowConfig.collectionId}/items`
      );
      expect(endpoint).not.toContain('/sites/');
    });

    // FAILURE TEST 2: _draft/_archived should NOT be inside fieldData
    it('should not put _draft and _archived inside fieldData', async () => {
      setupPublishMocks();

      await agentModeService.publishBlogArticle(
        'Test Title',
        'Description',
        'https://example.com/hero.png',
        'https://example.com/blog.html',
        'user-1',
        'session-1',
        'draft'
      );

      const postCall = mockAxiosPost.mock.calls[0];
      const requestBody = postCall[1];

      // _draft and _archived should NOT be in fieldData
      expect(requestBody.fieldData._draft).toBeUndefined();
      expect(requestBody.fieldData._archived).toBeUndefined();
    });

    // FAILURE TEST 3: should return failure when Webflow response has no item id
    it('should return failure when Webflow response lacks item id', async () => {
      setupPublishMocks();
      mockAxiosPost.mockResolvedValue({ data: {} }); // no id in response

      const result = await agentModeService.publishBlogArticle(
        'Test Title',
        'Description',
        'https://example.com/hero.png',
        'https://example.com/blog.html',
        'user-1',
        'session-1',
        'draft'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Webflow');
    });

    // SUCCESS TEST: published articles should use correct live endpoint
    it('should use /items/live endpoint for published status', async () => {
      setupPublishMocks();
      // Add category mapping for published status
      mockGetWebflowConfig.mockResolvedValue({
        ...mockWebflowConfig,
        categories: { 'User Guide': 'cat-123' },
      });

      await agentModeService.publishBlogArticle(
        'Test Title',
        'Description',
        'https://example.com/hero.png',
        'https://example.com/blog.html',
        'user-1',
        'session-1',
        'published',
        undefined,
        ['User Guide']
      );

      const postCall = mockAxiosPost.mock.calls[0];
      const endpoint = postCall[0];
      const body = postCall[1];

      expect(endpoint).toContain('/items/live');
      // isArchived/isDraft should be at top level for live
      expect(body.isArchived).toBe(false);
      expect(body.isDraft).toBe(false);
    });
  });
});
