// Unit tests for create_blog_article function in agentModeService

import { AgentModeService } from '../services/agentModeService';

// Mock dependencies
jest.mock('../controllers/blog', () => ({
  generateBlogContent: jest.fn(),
  generateBlogImage: jest.fn(),
  generateBlogHtml: jest.fn(),
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn().mockResolvedValue({})
  }
}));

describe('AgentModeService - create_blog_article function', () => {
  let agentModeService: AgentModeService;
  let mockGenerateBlogContent: jest.Mock;
  let mockGenerateBlogImage: jest.Mock;
  let mockGenerateBlogHtml: jest.Mock;
  let mockUploadFileToS3: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create AgentModeService instance
    agentModeService = new AgentModeService();

    // Get mocked functions
    const blogModule = require('../controllers/blog');
    const s3UtilsModule = require('../utils/s3Utils');
    
    mockGenerateBlogContent = blogModule.generateBlogContent;
    mockGenerateBlogImage = blogModule.generateBlogImage;
    mockGenerateBlogHtml = blogModule.generateBlogHtml;
    mockUploadFileToS3 = s3UtilsModule.uploadFileToS3;
  });

  describe('Default Style', () => {
    it('should create blog article with default style', async () => {
      const mockBlogData = {
        title: 'Test Blog Title',
        description: 'Test description',
        content: '# Test Content\n\nThis is test content.',
        imagePrompt: 'A test image prompt'
      };

      const mockImageData = {
        imageUrl: 'https://example.com/image.png',
        filename: 'test-image.png'
      };

      const mockHtmlContent = '<html>Test HTML</html>';
      const mockS3Url = 'https://s3.example.com/blog-123.html';

      mockGenerateBlogContent.mockResolvedValue(mockBlogData);
      mockGenerateBlogImage.mockResolvedValue(mockImageData);
      mockGenerateBlogHtml.mockReturnValue(mockHtmlContent);
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: mockS3Url
      });

      const result = await (agentModeService as any).createBlogArticle(
        'Test Topic',
        'keyword1, keyword2',
        'professional',
        'medium',
        '',
        '',
        'user123',
        'session123',
        'default'
      );

      // Verify generateBlogContent was called with correct parameters
      expect(mockGenerateBlogContent).toHaveBeenCalledWith(
        'Test Topic',
        'keyword1, keyword2',
        'professional',
        'medium',
        '',
        '',
        'default'
      );

      // Verify generateBlogImage was called
      expect(mockGenerateBlogImage).toHaveBeenCalledWith(
        'A test image prompt',
        'user123'
      );

      // Verify generateBlogHtml was called with default style
      expect(mockGenerateBlogHtml).toHaveBeenCalledWith(
        'Test Blog Title',
        'Test description',
        '# Test Content\n\nThis is test content.',
        'https://example.com/image.png',
        'default'
      );

      // Verify S3 upload was called
      expect(mockUploadFileToS3).toHaveBeenCalledWith(
        mockHtmlContent,
        expect.stringMatching(/^blog-\d+\.html$/),
        'user123',
        'text/html'
      );

      // Verify result
      expect(result.success).toBe(true);
      expect(result.data.title).toBe('Test Blog Title');
      expect(result.data.description).toBe('Test description');
      expect(result.data.imageUrl).toBe('https://example.com/image.png');
      expect(result.data.htmlUrl).toBe(mockS3Url);
    });

    it('should use default style when style parameter is not provided', async () => {
      const mockBlogData = {
        title: 'Test Blog Title',
        description: 'Test description',
        content: '# Test Content',
        imagePrompt: 'A test image prompt'
      };

      const mockImageData = {
        imageUrl: 'https://example.com/image.png',
        filename: 'test-image.png'
      };

      mockGenerateBlogContent.mockResolvedValue(mockBlogData);
      mockGenerateBlogImage.mockResolvedValue(mockImageData);
      mockGenerateBlogHtml.mockReturnValue('<html>Test</html>');
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/blog.html'
      });

      const result = await (agentModeService as any).createBlogArticle(
        'Test Topic',
        '',
        'professional',
        'medium',
        '',
        '',
        'user123',
        'session123'
        // style parameter not provided - should default to 'default'
      );

      expect(mockGenerateBlogContent).toHaveBeenCalledWith(
        'Test Topic',
        '',
        'professional',
        'medium',
        '',
        '',
        'default' // Should default to 'default'
      );

      expect(mockGenerateBlogHtml).toHaveBeenCalledWith(
        'Test Blog Title',
        'Test description',
        '# Test Content',
        'https://example.com/image.png',
        'default' // Should default to 'default'
      );

      expect(result.success).toBe(true);
    });
  });

  describe('Substack Style', () => {
    it('should create blog article with Substack style', async () => {
      const mockBlogData = {
        title: 'My Personal Take on Test Topic',
        description: 'A personal newsletter-style article',
        content: '# My Experience\n\nI\'ve been thinking about this topic...',
        imagePrompt: 'A personal, newsletter-style image'
      };

      const mockImageData = {
        imageUrl: 'https://example.com/image.png',
        filename: 'test-image.png'
      };

      const mockHtmlContent = '<html>Substack Style HTML</html>';
      const mockS3Url = 'https://s3.example.com/blog-substack.html';

      mockGenerateBlogContent.mockResolvedValue(mockBlogData);
      mockGenerateBlogImage.mockResolvedValue(mockImageData);
      mockGenerateBlogHtml.mockReturnValue(mockHtmlContent);
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: mockS3Url
      });

      const result = await (agentModeService as any).createBlogArticle(
        'Test Topic',
        'keyword1',
        'conversational',
        'medium',
        '',
        '',
        'user123',
        'session123',
        'substack'
      );

      // Verify generateBlogContent was called with substack style
      expect(mockGenerateBlogContent).toHaveBeenCalledWith(
        'Test Topic',
        'keyword1',
        'conversational',
        'medium',
        '',
        '',
        'substack'
      );

      // Verify generateBlogHtml was called with substack style
      expect(mockGenerateBlogHtml).toHaveBeenCalledWith(
        'My Personal Take on Test Topic',
        'A personal newsletter-style article',
        '# My Experience\n\nI\'ve been thinking about this topic...',
        'https://example.com/image.png',
        'substack'
      );

      expect(result.success).toBe(true);
      expect(result.data.htmlUrl).toBe(mockS3Url);
    });

    it('should pass Substack style through entire workflow', async () => {
      const mockBlogData = {
        title: 'Newsletter Article',
        description: 'Substack style',
        content: 'First person content...',
        imagePrompt: 'Image prompt'
      };

      mockGenerateBlogContent.mockResolvedValue(mockBlogData);
      mockGenerateBlogImage.mockResolvedValue({
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png'
      });
      mockGenerateBlogHtml.mockReturnValue('<html>Substack HTML</html>');
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/blog.html'
      });

      await (agentModeService as any).createBlogArticle(
        'Topic',
        '',
        'friendly',
        'long',
        'Research context',
        'Requirements',
        'user123',
        'session123',
        'substack'
      );

      // Verify style is passed to content generation
      expect(mockGenerateBlogContent).toHaveBeenCalledWith(
        'Topic',
        '',
        'friendly',
        'long',
        'Research context',
        'Requirements',
        'substack'
      );

      // Verify style is passed to HTML generation
      expect(mockGenerateBlogHtml).toHaveBeenCalledWith(
        'Newsletter Article',
        'Substack style',
        'First person content...',
        'https://example.com/image.png',
        'substack'
      );
    });
  });

  describe('Parameter Handling', () => {
    it('should handle all parameters correctly', async () => {
      const mockBlogData = {
        title: 'Test Title',
        description: 'Test description',
        content: 'Test content',
        imagePrompt: 'Test prompt'
      };

      mockGenerateBlogContent.mockResolvedValue(mockBlogData);
      mockGenerateBlogImage.mockResolvedValue({
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png'
      });
      mockGenerateBlogHtml.mockReturnValue('<html>Test</html>');
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/blog.html'
      });

      await (agentModeService as any).createBlogArticle(
        'My Topic',
        'seo, keywords',
        'casual',
        'short',
        'Research context here',
        'Special requirements',
        'user456',
        'session789',
        'substack'
      );

      expect(mockGenerateBlogContent).toHaveBeenCalledWith(
        'My Topic',
        'seo, keywords',
        'casual',
        'short',
        'Research context here',
        'Special requirements',
        'substack'
      );
    });

    it('should handle empty optional parameters', async () => {
      const mockBlogData = {
        title: 'Test Title',
        description: 'Test description',
        content: 'Test content',
        imagePrompt: 'Test prompt'
      };

      mockGenerateBlogContent.mockResolvedValue(mockBlogData);
      mockGenerateBlogImage.mockResolvedValue({
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png'
      });
      mockGenerateBlogHtml.mockReturnValue('<html>Test</html>');
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/blog.html'
      });

      await (agentModeService as any).createBlogArticle(
        'Topic Only',
        '',
        'professional',
        'medium',
        '',
        '',
        'user123',
        'session123'
      );

      expect(mockGenerateBlogContent).toHaveBeenCalledWith(
        'Topic Only',
        '',
        'professional',
        'medium',
        '',
        '',
        'default'
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle blog content generation failure', async () => {
      mockGenerateBlogContent.mockResolvedValue({
        title: '',
        description: '',
        content: '',
        imagePrompt: ''
      });

      const result = await (agentModeService as any).createBlogArticle(
        'Test Topic',
        '',
        'professional',
        'medium',
        '',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to create blog article');
      expect(result.error).toBe('Blog content generation failed');
    });

    it('should handle image generation failure', async () => {
      const mockBlogData = {
        title: 'Test Title',
        description: 'Test description',
        content: 'Test content',
        imagePrompt: 'Test prompt'
      };

      mockGenerateBlogContent.mockResolvedValue(mockBlogData);
      mockGenerateBlogImage.mockResolvedValue({
        imageUrl: '',
        filename: ''
      });

      const result = await (agentModeService as any).createBlogArticle(
        'Test Topic',
        '',
        'professional',
        'medium',
        '',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Image generation failed');
    });

    it('should handle S3 upload failure', async () => {
      const mockBlogData = {
        title: 'Test Title',
        description: 'Test description',
        content: 'Test content',
        imagePrompt: 'Test prompt'
      };

      mockGenerateBlogContent.mockResolvedValue(mockBlogData);
      mockGenerateBlogImage.mockResolvedValue({
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png'
      });
      mockGenerateBlogHtml.mockReturnValue('<html>Test</html>');
      mockUploadFileToS3.mockResolvedValue({
        success: false,
        error: 'S3 upload failed'
      });

      const result = await (agentModeService as any).createBlogArticle(
        'Test Topic',
        '',
        'professional',
        'medium',
        '',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('S3 upload failed');
    });

    it('should handle exceptions during blog creation', async () => {
      mockGenerateBlogContent.mockRejectedValue(new Error('Network error'));

      const result = await (agentModeService as any).createBlogArticle(
        'Test Topic',
        '',
        'professional',
        'medium',
        '',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to create blog article');
      expect(result.error).toBe('Network error');
    });
  });

  describe('Style Parameter in Function Call', () => {
    it('should use default style when style parameter is not provided in function call', async () => {
      const mockBlogData = {
        title: 'Test Title',
        description: 'Test description',
        content: 'Test content',
        imagePrompt: 'Test prompt'
      };

      mockGenerateBlogContent.mockResolvedValue(mockBlogData);
      mockGenerateBlogImage.mockResolvedValue({
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png'
      });
      mockGenerateBlogHtml.mockReturnValue('<html>Test</html>');
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/blog.html'
      });

      // Simulate function call without style parameter
      const result = await (agentModeService as any).createBlogArticle(
        'Test Topic',
        'keyword1',
        'professional',
        'medium',
        '',
        '',
        'user123',
        'session123'
        // style not provided - should default to 'default'
      );

      expect(mockGenerateBlogContent).toHaveBeenCalledWith(
        'Test Topic',
        'keyword1',
        'professional',
        'medium',
        '',
        '',
        'default'
      );

      expect(result.success).toBe(true);
    });

    it('should use substack style when style parameter is provided in function call', async () => {
      const mockBlogData = {
        title: 'Test Title',
        description: 'Test description',
        content: 'Test content',
        imagePrompt: 'Test prompt'
      };

      mockGenerateBlogContent.mockResolvedValue(mockBlogData);
      mockGenerateBlogImage.mockResolvedValue({
        imageUrl: 'https://example.com/image.png',
        filename: 'image.png'
      });
      mockGenerateBlogHtml.mockReturnValue('<html>Test</html>');
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/blog.html'
      });

      // Simulate function call with substack style
      const result = await (agentModeService as any).createBlogArticle(
        'Test Topic',
        '',
        'professional',
        'medium',
        '',
        '',
        'user123',
        'session123',
        'substack'
      );

      expect(mockGenerateBlogContent).toHaveBeenCalledWith(
        'Test Topic',
        '',
        'professional',
        'medium',
        '',
        '',
        'substack'
      );

      expect(mockGenerateBlogHtml).toHaveBeenCalledWith(
        'Test Title',
        'Test description',
        'Test content',
        'https://example.com/image.png',
        'substack'
      );

      expect(result.success).toBe(true);
    });
  });
});

