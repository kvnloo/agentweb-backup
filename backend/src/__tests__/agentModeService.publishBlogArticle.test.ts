// Unit tests for publish_blog_article function in agentModeService

import { AgentModeService } from '../services/agentModeService';

// Mock axios
const mockAxiosGet = jest.fn();
const mockAxiosPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn()
  }
}));

// Mock blog controller
var mockGetWebflowConfig: jest.Mock;
var mockGetWordPressConfig: jest.Mock;
jest.mock('../controllers/blog', () => ({
  getWebflowConfig: (...args: any[]) => mockGetWebflowConfig(...args),
  getWordPressConfig: (...args: any[]) => mockGetWordPressConfig(...args)
}));
mockGetWebflowConfig = jest.fn();
mockGetWordPressConfig = jest.fn();

// Mock secrets manager for Payload CMS credentials
var mockGetSecret: jest.Mock;
jest.mock('../utils/secretsManager', () => ({
  getSecret: (...args: any[]) => mockGetSecret ? mockGetSecret(...args) : Promise.resolve(null),
  getGCSPPrivateKey: jest.fn(),
}));
mockGetSecret = jest.fn();

// Mock database
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  }
}));

describe('AgentModeService - publish_blog_article function', () => {
  let agentModeService: AgentModeService;
  let mockGetUserById: jest.Mock;
  let mockAxiosGet: jest.Mock;
  let mockAxiosPost: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    process.env.NODE_ENV = 'development';
    
    // Get the mocked functions
    const dbModule = require('../services/db');
    mockGetUserById = dbModule.userDb.getUserById;
    
    // Get axios mocks
    const axiosModule = require('axios');
    mockAxiosGet = axiosModule.default.get;
    mockAxiosPost = axiosModule.default.post;
    
    // Reset axios mocks
    mockAxiosGet.mockClear();
    mockAxiosPost.mockClear();

    // Default: no Payload secret (falls through to Webflow for existing tests)
    mockGetSecret.mockResolvedValue(null);
  });

  const mockUserId = 'test-user-123';
  const mockSessionId = 'test-session-123';
  const mockBlogHtmlUrl = 'https://example.com/blog.html';
  const mockHeroImageUrl = 'https://example.com/hero.png';

  const mockHtmlContent = `
    <!DOCTYPE html>
    <html>
    <head><title>Test Blog</title></head>
    <body>
      <div class="content">
        <p>Test blog content here</p>
      </div>
    </body>
    </html>
  `;

  const mockWebflowConfig = {
    apiToken: 'test-api-token',
    siteId: 'test-site-id',
    collectionId: 'test-collection-id',
    fieldMappings: {
      summary: 'post-summary',
      body: 'post-body',
      image: 'main-image'
    }
  };

  const mockWebflowResponse = {
    data: {
      id: 'test-item-id',
      fieldData: {
        name: 'Test Blog Title',
        'post-body': '<p>Test blog content here</p>',
        'post-summary': 'Test description'
      }
    }
  };

  describe('Webflow publishing with per-user config', () => {
    it('should use per-user Webflow config when userId is provided', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'draft' // status
      );

      // Verify getWebflowConfig was called with userId
      expect(mockGetWebflowConfig).toHaveBeenCalledWith(mockUserId);
      expect(result.success).toBe(true);
      expect(result.data.cmsType).toBe('Webflow');
      expect(result.data.title).toBe('Test Blog Title');
    });

    it('should fall back to global Webflow config when per-user secret does not exist', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      // Simulate per-user secret not existing (secretExists returns false)
      // getWebflowConfig will fall back to global secret
      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      // Verify getWebflowConfig was called with userId (it will handle fallback internally)
      expect(mockGetWebflowConfig).toHaveBeenCalledWith(mockUserId);
      expect(result.success).toBe(true);
    });

    it('should sanitize response by removing post-body field', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      // Verify post-body was removed from response
      expect(result.data.cmsResponse.fieldData['post-body']).toBeUndefined();
      expect(result.data.cmsResponse.fieldData['body']).toBeUndefined();
      // Other fields should still be present
      expect(result.data.cmsResponse.id).toBe('test-item-id');
    });

    it('should return error when CMS Type is not configured', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: undefined
      });

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('CMS Type not configured');
      expect(mockGetWebflowConfig).not.toHaveBeenCalled();
    });

    it('should return error when CMS Type is Basehub (not supported)', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Basehub'
      });

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Basehub CMS is not supported');
      expect(mockGetWebflowConfig).not.toHaveBeenCalled();
    });

    it('should handle Webflow API errors with detailed error messages', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      const webflowError = {
        response: {
          status: 400,
          statusText: 'Bad Request',
          data: {
            message: 'Validation Error',
            details: [
              { param: 'post-body', description: 'Field is required' }
            ]
          }
        }
      };

      mockAxiosPost.mockRejectedValueOnce(webflowError);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Webflow API validation error');
    });

    it('should extract content from HTML correctly', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      // Verify the Webflow API was called with cleaned HTML (no newlines)
      const webflowCall = mockAxiosPost.mock.calls[0];
      const fieldData = webflowCall[1].fieldData;
      expect(fieldData['post-body']).not.toContain('\n');
      expect(fieldData['post-body']).not.toContain('\r');
    });

    it('should use field mappings from Webflow config', async () => {
      const customFieldMappings = {
        summary: 'custom-summary',
        body: 'custom-body',
        image: 'custom-image'
      };

      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      mockGetWebflowConfig.mockResolvedValue({
        ...mockWebflowConfig,
        fieldMappings: customFieldMappings
      });

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      // Verify custom field mappings were used
      const webflowCall = mockAxiosPost.mock.calls[0];
      const fieldData = webflowCall[1].fieldData;
      expect(fieldData['custom-summary']).toBe('Test description');
      expect(fieldData['custom-body']).toBeDefined();
      expect(fieldData['custom-image']).toBe(mockHeroImageUrl);
    });
  });

  describe('Status parameter and live publishing', () => {
    it('should use draft endpoint when status is "draft"', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'draft'
      );

      // Verify draft endpoint was used
      const webflowCall = mockAxiosPost.mock.calls[0];
      const endpoint = webflowCall[0];
      expect(endpoint).toContain('/sites/');
      expect(endpoint).toContain('/collections/');
      expect(endpoint).toContain('/items');
      expect(endpoint).not.toContain('/items/live');
    });

    it('should use live endpoint when status is "published"', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      const configWithCategories = {
        ...mockWebflowConfig,
        categories: {
          'Technology': 'cat-id-123',
          'Marketing': 'cat-id-456'
        }
      };

      mockGetWebflowConfig.mockResolvedValue(configWithCategories);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'published',
        'John Doe',
        ['Technology']
      );

      // Verify live endpoint was used
      const webflowCall = mockAxiosPost.mock.calls[0];
      const endpoint = webflowCall[0];
      expect(endpoint).toContain('/collections/');
      expect(endpoint).toContain('/items/live');
      expect(endpoint).toContain('skipInvalidFiles=true');
      expect(endpoint).not.toContain('/sites/');
    });

    it('should default to "draft" when status is not provided', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
        // status not provided
      );

      // Verify draft endpoint was used
      const webflowCall = mockAxiosPost.mock.calls[0];
      const endpoint = webflowCall[0];
      expect(endpoint).toContain('/sites/');
      expect(endpoint).not.toContain('/items/live');
    });
  });

  describe('Author and categories parameters', () => {
    it('should include author field when author parameter is provided', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      const configWithAuthor = {
        ...mockWebflowConfig,
        fieldMappings: {
          ...mockWebflowConfig.fieldMappings,
          author: 'post-author'
        }
      };

      mockGetWebflowConfig.mockResolvedValue(configWithAuthor);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'draft',
        'Jane Smith' // author
      );

      // Verify author was included in field data
      const webflowCall = mockAxiosPost.mock.calls[0];
      const fieldData = webflowCall[1].fieldData;
      expect(fieldData['post-author']).toBe('Jane Smith');
    });

    it('should convert category names to IDs using category mapping', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      const configWithCategories = {
        ...mockWebflowConfig,
        fieldMappings: {
          ...mockWebflowConfig.fieldMappings,
          category: 'post-categories'
        },
        categories: {
          'Technology': 'cat-tech-123',
          'Marketing': 'cat-mkt-456',
          'Business': 'cat-biz-789'
        }
      };

      mockGetWebflowConfig.mockResolvedValue(configWithCategories);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'published',
        'John Doe',
        ['Technology', 'Marketing'] // category names
      );

      // Verify category IDs were used
      const webflowCall = mockAxiosPost.mock.calls[0];
      const fieldData = webflowCall[1].fieldData;
      expect(fieldData['post-categories']).toEqual(['cat-tech-123', 'cat-mkt-456']);
    });

    it('should handle empty categories for draft status', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'draft',
        undefined,
        [] // empty categories - OK for draft
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Category validation', () => {
    it('should return error when published without categories', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      const configWithCategories = {
        ...mockWebflowConfig,
        categories: {
          'Technology': 'cat-id-123'
        }
      };

      mockGetWebflowConfig.mockResolvedValue(configWithCategories);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'published',
        'John Doe',
        [] // empty categories - NOT OK for published
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Cannot publish article without categories');
      expect(result.message).toContain('Available categories');
      expect(result.availableCategories).toEqual(['Technology']);
    });

    it('should return error when category mapping is not configured', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig); // no categories

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'published',
        'John Doe',
        ['Technology']
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Category mapping is not configured');
      expect(result.invalidCategories).toEqual(['Technology']);
      expect(result.availableCategories).toEqual([]);
    });

    it('should return error with available categories when invalid categories are provided', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      const configWithCategories = {
        ...mockWebflowConfig,
        categories: {
          'Technology': 'cat-tech-123',
          'Marketing': 'cat-mkt-456'
        }
      };

      mockGetWebflowConfig.mockResolvedValue(configWithCategories);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'published',
        'John Doe',
        ['InvalidCategory', 'AnotherInvalid']
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('All provided category names are invalid');
      expect(result.message).toContain('InvalidCategory, AnotherInvalid');
      expect(result.message).toContain('Available categories: Technology, Marketing');
      expect(result.invalidCategories).toEqual(['InvalidCategory', 'AnotherInvalid']);
      expect(result.availableCategories).toEqual(['Technology', 'Marketing']);
    });

    it('should filter out invalid categories and use only valid ones', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });

      const configWithCategories = {
        ...mockWebflowConfig,
        fieldMappings: {
          ...mockWebflowConfig.fieldMappings,
          category: 'post-categories'
        },
        categories: {
          'Technology': 'cat-tech-123',
          'Marketing': 'cat-mkt-456'
        }
      };

      mockGetWebflowConfig.mockResolvedValue(configWithCategories);

      mockAxiosGet.mockResolvedValue({
        data: mockHtmlContent
      });

      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'published',
        'John Doe',
        ['Technology', 'InvalidCategory', 'Marketing'] // mixed valid and invalid
      );

      // Should succeed with valid categories only
      expect(result.success).toBe(true);

      // Verify only valid category IDs were used
      const webflowCall = mockAxiosPost.mock.calls[0];
      const fieldData = webflowCall[1].fieldData;
      expect(fieldData['post-categories']).toEqual(['cat-tech-123', 'cat-mkt-456']);
    });
  });

  describe('HTML content extraction and format validation', () => {
    const setupMocks = (htmlContent: string) => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow'
      });
      mockGetWebflowConfig.mockResolvedValue(mockWebflowConfig);
      mockAxiosGet.mockResolvedValue({ data: htmlContent });
      mockAxiosPost.mockResolvedValueOnce(mockWebflowResponse as any);
    };

    it('should return requiresRepair error when HTML has no <div class="content"> wrapper', async () => {
      const htmlWithoutContentDiv = `
        <!DOCTYPE html>
        <html>
        <head><title>Test</title></head>
        <body>
          <h1>Article Title</h1>
          <p>Article body content</p>
        </body>
        </html>
      `;

      setupMocks(htmlWithoutContentDiv);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'draft'
      );

      expect(result.success).toBe(false);
      expect(result.requiresRepair).toBe(true);
      expect(result.articleUrl).toBe(mockBlogHtmlUrl);
      expect(result.message).toContain('repair_blog_article');
    });

    it('should extract and prepend <style> blocks from <head> to body content', async () => {
      const htmlWithStyles = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test</title>
          <style>
            .stat-card { background: #f0f0f0; padding: 20px; }
            .tldr-box { border-left: 4px solid blue; }
          </style>
        </head>
        <body>
          <div class="content">
            <div class="stat-card">Some stat</div>
            <div class="tldr-box">TL;DR content</div>
          </div>
        </body>
        </html>
      `;

      setupMocks(htmlWithStyles);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'draft'
      );

      expect(result.success).toBe(true);

      const webflowCall = mockAxiosPost.mock.calls[0];
      const fieldData = webflowCall[1].fieldData;
      const bodyContent = fieldData['post-body'];
      // Style block should be prepended
      expect(bodyContent).toContain('.stat-card');
      expect(bodyContent).toContain('.tldr-box');
      expect(bodyContent).toContain('<style>');
      // Body content should still be present
      expect(bodyContent).toContain('Some stat');
      expect(bodyContent).toContain('TL;DR content');
    });

    it('should still extract from <div class="content"> when it exists (regression)', async () => {
      setupMocks(mockHtmlContent);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'draft'
      );

      expect(result.success).toBe(true);

      const webflowCall = mockAxiosPost.mock.calls[0];
      const fieldData = webflowCall[1].fieldData;
      expect(fieldData['post-body']).toContain('Test blog content here');
    });

    it('should preserve h1 inside <div class="content"> (create_blog_article compatibility)', async () => {
      const htmlWithH1InContent = `
        <!DOCTYPE html>
        <html>
        <head><title>Test</title></head>
        <body>
          <h1>Page Title</h1>
          <img src="https://example.com/hero.png" class="hero-image">
          <div class="content">
            <h1>Content H1 That Should Stay</h1>
            <p>Article content</p>
          </div>
        </body>
        </html>
      `;

      setupMocks(htmlWithH1InContent);

      const result = await (agentModeService as any).publishBlogArticle(
        'Page Title',
        'Description',
        'https://example.com/hero.png',
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'draft'
      );

      expect(result.success).toBe(true);

      const webflowCall = mockAxiosPost.mock.calls[0];
      const fieldData = webflowCall[1].fieldData;
      const bodyContent = fieldData['post-body'];
      expect(bodyContent).toContain('Content H1 That Should Stay');
      expect(bodyContent).toContain('Article content');
    });
  });

  describe('Payload CMS publishing', () => {
    const mockPayloadSecret = JSON.stringify({
      PAYLOAD_PUBLISH_ENDPOINT: 'https://www.agentweb.pro/api/publish-post',
      PAYLOAD_PUBLISH_SECRET: 'test-payload-secret-123',
    });

    const mockPayloadResponse = {
      data: {
        id: 'payload-post-123',
        slug: 'test-blog-title',
        title: 'Test Blog Title',
        status: 'draft',
      },
    };

    beforeEach(() => {
      // Mock user with Webflow cmsType. Payload should publish before any
      // legacy Webflow/BaseHub configuration is required.
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: 'Webflow',
      });

      // Mock Webflow config for the legacy fallback path when Payload is absent.
      mockGetWebflowConfig.mockResolvedValue({
        apiToken: 'test-api-token',
        siteId: 'test-site-id',
        collectionId: 'test-collection-id',
        fieldMappings: { summary: 'post-summary', body: 'post-body', image: 'main-image' },
      });

      // Mock getSecret to return Payload CMS credentials
      mockGetSecret.mockImplementation((key: string) => {
        if (key.includes('PayloadCMS')) {
          return Promise.resolve(mockPayloadSecret);
        }
        return Promise.resolve(null);
      });
    });

    it('should publish to Payload CMS when secret is available', async () => {
      // Mock HTML fetch (first axios.get call)
      mockAxiosGet.mockResolvedValueOnce({ data: mockHtmlContent });
      // Mock Payload CMS publish (axios.post call)
      mockAxiosPost.mockResolvedValueOnce(mockPayloadResponse);

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(result.data.cmsType).toBe('Payload');
      expect(result.message).toContain('Payload CMS');
      expect(mockGetWebflowConfig).not.toHaveBeenCalled();
      expect(mockGetUserById).not.toHaveBeenCalled();
    });

    it('should publish to Payload CMS even when the user has no CMS configured', async () => {
      mockGetUserById.mockResolvedValue({
        userId: mockUserId,
        cmsType: null,
      });
      mockAxiosGet.mockResolvedValueOnce({ data: mockHtmlContent });
      mockAxiosPost.mockResolvedValueOnce(mockPayloadResponse);

      const result = await (agentModeService as any).publishBlogArticle(
        'Landing Page Blog',
        'Payload should not depend on user CMS config',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId,
        'published',
        'Fangfang',
        ['Thought Leadership']
      );

      expect(result.success).toBe(true);
      expect(result.data.cmsType).toBe('Payload');
      expect(mockGetUserById).not.toHaveBeenCalled();
      expect(mockGetWebflowConfig).not.toHaveBeenCalled();

      const body = mockAxiosPost.mock.calls[0][1];
      expect(body.status).toBe('published');
      expect(body.author).toBe('fangfang');
      expect(body.category).toBe('Thought Leadership');
    });

    it('should send correct payload to Payload CMS endpoint', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: mockHtmlContent });
      mockAxiosPost.mockResolvedValueOnce(mockPayloadResponse);

      await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'A great test article',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      // Verify the Payload CMS API was called
      expect(mockAxiosPost).toHaveBeenCalledTimes(1);
      const [url, body, config] = mockAxiosPost.mock.calls[0];

      // Verify endpoint
      expect(url).toBe('https://www.agentweb.pro/api/publish-post');

      // Verify auth header
      expect(config.headers.Authorization).toBe('Bearer test-payload-secret-123');

      // Verify body fields
      expect(body.title).toBe('Test Blog Title');
      expect(body.slug).toBe('test-blog-title');
      expect(body.summary).toBe('A great test article');
      expect(body.bodyHtml).toBeDefined();
      expect(body.bodyHtml).toContain('Test blog content here');
      expect(body.category).toBeDefined();
      expect(body.author).toBeDefined();
      expect(body.featuredImageUrl).toBe(mockHeroImageUrl);
      expect(body.status).toBeDefined();
      expect(body.publishedAt).toBeDefined();
    });

    it('should map author names to Payload slugs correctly', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: mockHtmlContent });
      mockAxiosPost.mockResolvedValueOnce(mockPayloadResponse);

      // Default author (no author specified) should map to 'emma'
      await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      const body = mockAxiosPost.mock.calls[0][1];
      expect(body.author).toBe('emma');
    });

    it('should return slug-based URL for Payload CMS posts', async () => {
      mockAxiosGet.mockResolvedValueOnce({ data: mockHtmlContent });
      mockAxiosPost.mockResolvedValueOnce(mockPayloadResponse);

      const result = await (agentModeService as any).publishBlogArticle(
        'My Great Post',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      expect(result.data.slug).toBe('my-great-post');
      expect(result.data.url).toBe('/blog/my-great-post');
    });

    it('should fall back to Webflow when Payload secret is not available', async () => {
      // Override getSecret to return null for Payload
      mockGetSecret.mockImplementation(() => Promise.resolve(null));

      mockAxiosGet.mockResolvedValueOnce({ data: mockHtmlContent });
      mockAxiosPost.mockResolvedValueOnce({
        data: {
          id: 'webflow-item-id',
          fieldData: { name: 'Test Blog Title' },
        },
      });

      const result = await (agentModeService as any).publishBlogArticle(
        'Test Blog Title',
        'Test description',
        mockHeroImageUrl,
        mockBlogHtmlUrl,
        mockUserId,
        mockSessionId
      );

      expect(result.success).toBe(true);
      expect(result.data.cmsType).toBe('Webflow');
    });

  });
});
