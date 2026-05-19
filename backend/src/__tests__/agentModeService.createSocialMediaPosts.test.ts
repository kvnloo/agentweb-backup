// Unit tests for create_social_media_posts function in agentModeService

import { AgentModeService } from '../services/agentModeService';

// Mock dependencies
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn(),
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    addMessageToSession: jest.fn().mockResolvedValue({})
  }
}));

// Mock remark modules (ES modules)
jest.mock('remark', () => ({
  remark: jest.fn(() => ({
    use: jest.fn().mockReturnThis(),
    processSync: jest.fn((content: string) => ({
      toString: () => `<p>${content}</p>`
    }))
  }))
}));

jest.mock('remark-html', () => ({
  __esModule: true,
  default: jest.fn()
}));

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: jest.fn()
}));

jest.mock('remark-breaks', () => ({
  __esModule: true,
  default: jest.fn()
}));

describe('AgentModeService - create_social_media_posts function', () => {
  let agentModeService: AgentModeService;
  let mockUploadFileToS3: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Create AgentModeService instance
    agentModeService = new AgentModeService();

    // Get mocked functions
    const s3UtilsModule = require('../utils/s3Utils');
    mockUploadFileToS3 = s3UtilsModule.uploadFileToS3;
  });

  describe('Successful Creation', () => {
    it('should create social media posts with multiple post types', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'This is a LinkedIn post about our new product launch!'
        },
        {
          type: 'x/twitter',
          content: 'Excited to announce our latest feature! 🚀'
        },
        {
          type: 'instagram',
          content: 'Check out our amazing new collection! #fashion #style',
          image_url: 'https://example.com/image1.jpg'
        }
      ];

      const mockS3Url = 'https://s3.example.com/social-media-posts-123.html';

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: mockS3Url
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      // Verify S3 upload was called
      expect(mockUploadFileToS3).toHaveBeenCalledWith(
        expect.stringContaining('<!DOCTYPE html>'),
        expect.stringMatching(/^social-media-posts-\d+\.html$/),
        'user123',
        'text/html'
      );

      // Verify result
      expect(result.success).toBe(true);
      expect(result.message).toBe('Successfully created 3 social media posts');
      expect(result.htmlUrl).toBe(mockS3Url);
      expect(result.postsCount).toBe(3);
    });

    it('should create posts with all supported types', async () => {
      const mockPosts = [
        { type: 'linkedin', content: 'LinkedIn post' },
        { type: 'x/twitter', content: 'Twitter post' },
        { type: 'instagram', content: 'Instagram post' },
        { type: 'facebook', content: 'Facebook post' },
        { type: 'custom', content: 'Custom post' }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.postsCount).toBe(5);
    });

    it('should create posts with images', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Post with image',
          image_url: 'https://example.com/image.jpg'
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      
      // Verify HTML contains image
      const uploadCall = mockUploadFileToS3.mock.calls[0];
      const htmlContent = uploadCall[0];
      expect(htmlContent).toContain('https://example.com/image.jpg');
      expect(htmlContent).toContain('<img');
    });

    it('should create posts without images', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Post without image'
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      
      // Verify HTML does not contain image tag when no image_url provided
      const uploadCall = mockUploadFileToS3.mock.calls[0];
      const htmlContent = uploadCall[0];
      // Check that there's no img tag with src attribute (CSS may contain "post-image" class name)
      const imgTagMatch = htmlContent.match(/<img[^>]*src[^>]*>/);
      expect(imgTagMatch).toBeNull();
    });

    it('should convert markdown content to HTML', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: '# Heading\n\nThis is **bold** text and *italic* text.'
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      // Verify markdown processor was used
      const uploadCall = mockUploadFileToS3.mock.calls[0];
      const htmlContent = uploadCall[0];
      expect(htmlContent).toContain('post-content');
    });

    it('should generate HTML with proper structure', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Test post'
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      const uploadCall = mockUploadFileToS3.mock.calls[0];
      const htmlContent = uploadCall[0];
      
      // Verify HTML structure
      expect(htmlContent).toContain('<!DOCTYPE html>');
      expect(htmlContent).toContain('<html lang="en">');
      expect(htmlContent).toContain('<title>Social Media Posts</title>');
      expect(htmlContent).toContain('Post 1');
      expect(htmlContent).toContain('LinkedIn');
      expect(htmlContent).toContain('Copy Content');
      expect(htmlContent).toContain('copyPostContent');
    });

    it('should handle single post', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Single post'
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('Successfully created 1 social media post');
      expect(result.postsCount).toBe(1);
    });
  });

  describe('Error Handling', () => {
    it('should handle empty posts array', async () => {
      const result = await (agentModeService as any).createSocialMediaPosts(
        [],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('No posts provided');
      expect(result.error).toBe('invalid_input');
      expect(mockUploadFileToS3).not.toHaveBeenCalled();
    });

    it('should handle null posts', async () => {
      const result = await (agentModeService as any).createSocialMediaPosts(
        null,
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('No posts provided');
      expect(mockUploadFileToS3).not.toHaveBeenCalled();
    });

    it('should handle undefined posts', async () => {
      const result = await (agentModeService as any).createSocialMediaPosts(
        undefined,
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('No posts provided');
      expect(mockUploadFileToS3).not.toHaveBeenCalled();
    });

    it('should handle non-array posts', async () => {
      const result = await (agentModeService as any).createSocialMediaPosts(
        'not an array',
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('No posts provided');
      expect(mockUploadFileToS3).not.toHaveBeenCalled();
    });

    it('should handle S3 upload failure', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Test post'
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: false,
        error: 'S3 upload failed'
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to create social media posts');
      expect(result.error).toBe('S3 upload failed');
    });

    it('should handle S3 upload with no URL', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Test post'
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: null
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to create social media posts');
      expect(result.error).toContain('Failed to upload HTML file to S3');
    });

    it('should handle exceptions during post creation', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Test post'
        }
      ];

      mockUploadFileToS3.mockRejectedValue(new Error('Network error'));

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to create social media posts');
      expect(result.error).toBe('Network error');
    });
  });

  describe('Gemini JSON-string serialization', () => {
    it('should handle array items serialized as JSON strings by Gemini', async () => {
      // Gemini sometimes sends array items as JSON strings instead of objects
      const postsAsStrings = [
        JSON.stringify({ type: 'linkedin', content: 'LinkedIn post from Gemini' }),
        JSON.stringify({ type: 'x/twitter', content: 'Twitter post from Gemini' }),
      ] as any;

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        postsAsStrings,
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.postsCount).toBe(2);

      const uploadCall = mockUploadFileToS3.mock.calls[0];
      const htmlContent = uploadCall[0];
      expect(htmlContent).toContain('data-type="linkedin"');
      expect(htmlContent).toContain('data-type="x/twitter"');
      expect(htmlContent).not.toContain('data-type="undefined"');
      expect(htmlContent).toContain('LinkedIn post from Gemini');
    });

    it('should handle mixed array of objects and JSON strings', async () => {
      const mixedPosts = [
        { type: 'linkedin', content: 'Regular object post' },
        JSON.stringify({ type: 'instagram', content: 'String-serialized post' }),
      ] as any;

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mixedPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.postsCount).toBe(2);

      const htmlContent = mockUploadFileToS3.mock.calls[0][0];
      expect(htmlContent).not.toContain('undefined');
      expect(htmlContent).toContain('Regular object post');
      expect(htmlContent).toContain('String-serialized post');
    });
  });

  describe('Post Content Handling', () => {
    it('should handle posts with empty content', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: ''
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
    });

    it('should handle posts with special characters', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Post with special chars: <>&"\''
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
    });

    it('should handle posts with long content', async () => {
      const longContent = 'A'.repeat(10000);
      const mockPosts = [
        {
          type: 'linkedin',
          content: longContent
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      const result = await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
    });
  });

  describe('HTML Generation', () => {
    it('should include copy functionality in HTML', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Test post'
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      const uploadCall = mockUploadFileToS3.mock.calls[0];
      const htmlContent = uploadCall[0];
      
      expect(htmlContent).toContain('copyPostContent');
      expect(htmlContent).toContain('Copy Content');
      expect(htmlContent).toContain('post-raw-content');
    });

    it('should include proper styling for different post types', async () => {
      const mockPosts = [
        { type: 'linkedin', content: 'LinkedIn' },
        { type: 'x/twitter', content: 'Twitter' },
        { type: 'instagram', content: 'Instagram' },
        { type: 'facebook', content: 'Facebook' },
        { type: 'custom', content: 'Custom' }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      const uploadCall = mockUploadFileToS3.mock.calls[0];
      const htmlContent = uploadCall[0];
      
      // Verify platform-specific styling
      expect(htmlContent).toContain('data-type="linkedin"');
      expect(htmlContent).toContain('data-type="x/twitter"');
      expect(htmlContent).toContain('data-type="instagram"');
      expect(htmlContent).toContain('data-type="facebook"');
      expect(htmlContent).toContain('data-type="custom"');
    });

    it('should generate proper post numbering', async () => {
      const mockPosts = [
        { type: 'linkedin', content: 'Post 1' },
        { type: 'linkedin', content: 'Post 2' },
        { type: 'linkedin', content: 'Post 3' }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      const uploadCall = mockUploadFileToS3.mock.calls[0];
      const htmlContent = uploadCall[0];
      
      expect(htmlContent).toContain('Post 1');
      expect(htmlContent).toContain('Post 2');
      expect(htmlContent).toContain('Post 3');
    });

    it('should style images in post content with proper CSS', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Check out this image: ![Alt text](https://example.com/image-in-content.jpg)'
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      const uploadCall = mockUploadFileToS3.mock.calls[0];
      const htmlContent = uploadCall[0];
      
      // Verify CSS styling for images in post content exists
      expect(htmlContent).toContain('.post-content img');
      expect(htmlContent).toContain('max-width: 100%');
      expect(htmlContent).toContain('height: auto');
      expect(htmlContent).toContain('border-radius: 4px');
      expect(htmlContent).toContain('box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1)');
      expect(htmlContent).toContain('margin: 15px 0');
      expect(htmlContent).toContain('display: block');
    });

    it('should style images in content even when image_url parameter is also provided', async () => {
      const mockPosts = [
        {
          type: 'linkedin',
          content: 'Post with both: ![Image in content](https://example.com/content-image.jpg)',
          image_url: 'https://example.com/parameter-image.jpg'
        }
      ];

      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.example.com/posts.html'
      });

      await (agentModeService as any).createSocialMediaPosts(
        mockPosts,
        'user123',
        'session123'
      );

      const uploadCall = mockUploadFileToS3.mock.calls[0];
      const htmlContent = uploadCall[0];
      
      // Verify both image styling classes exist
      expect(htmlContent).toContain('.post-content img');
      expect(htmlContent).toContain('.post-image img');
      
      // Verify CSS properties for content images
      expect(htmlContent).toContain('max-width: 100%');
      expect(htmlContent).toContain('border-radius: 4px');
    });
  });
});

