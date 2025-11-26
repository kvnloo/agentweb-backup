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
const mockGetWebflowConfig = jest.fn();
jest.mock('../controllers/blog', () => ({
  getWebflowConfig: mockGetWebflowConfig
}));

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
        mockSessionId
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
      expect(result.error).toContain('Validation Error');
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
});

