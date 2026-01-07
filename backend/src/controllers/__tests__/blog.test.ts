// Unit tests for blog controller functions

// Mock remark and related modules before importing blog module
jest.mock('remark', () => ({
  remark: jest.fn(() => ({
    use: jest.fn().mockReturnThis(),
    processSync: jest.fn(() => ({
      toString: jest.fn(() => '<p>Test Content</p>')
    }))
  }))
}));

jest.mock('remark-html', () => ({}));
jest.mock('remark-gfm', () => ({}));
jest.mock('remark-breaks', () => ({}));

// Mock LangChain LLMService before importing blog module
const mockGenerateJSONContent = jest.fn();
jest.mock('../../utils/llmService', () => ({
  createLLMService: jest.fn(() => ({
    generateJSONContent: mockGenerateJSONContent
  }))
}));

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({})
    })
  })),
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        SecretString: JSON.stringify({ apiKey: 'test-key' })
      })
    })
  }))
}));

// Mock secretsManager utility
const mockGetSecret = jest.fn().mockResolvedValue('test-secret-value');
const mockSecretExists = jest.fn().mockResolvedValue(false);

jest.mock('../../utils/secretsManager', () => ({
  getSecret: mockGetSecret,
  secretExists: mockSecretExists
}));

// Mock imageGeneration service
const mockGenerateImage = jest.fn().mockResolvedValue({
  success: true,
  imageUrl: 'https://example.com/image.png',
  filename: 'test.png'
});

const mockIsAvailable = jest.fn().mockResolvedValue(true);

jest.mock('../../services/imageGeneration', () => ({
  imageService: {
    generateImage: mockGenerateImage,
    isAvailable: mockIsAvailable
  }
}));

// Mock environment variables before importing
process.env.AZURE_OPENAI_API_KEY = 'test-key';
process.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-4';
process.env.AZURE_OPENAI_API_VERSION = '2024-01-01';
process.env.AWS_ACCESS_KEY_ID = 'test-key';
process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
process.env.AWS_REGION = 'us-west-2';

import { generateBlogContent, generateBlogHtml, generateBlogImage, generateImage } from '../blog';

describe('Blog Controller - generateBlogContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Style Parameter', () => {
    it('should include Substack-style guidelines when style is "substack"', async () => {
      const mockResponse = {
        title: 'My Personal Take on Test Topic',
        description: 'A personal newsletter-style article',
        content: '# My Experience\n\nI\'ve been thinking about this topic...',
        imagePrompt: 'A personal, newsletter-style image'
      };

      mockGenerateJSONContent.mockResolvedValue(mockResponse);

      const result = await generateBlogContent(
        'Test Title Draft',
        '# Test Content Draft',
        'medium',
        '',
        '',
        'substack'
      );

      // Verify LLMService was called
      expect(mockGenerateJSONContent).toHaveBeenCalled();

      // Get the prompts that were sent
      const callArgs = mockGenerateJSONContent.mock.calls[0];
      const systemPrompt = callArgs[0];
      const userPrompt = callArgs[1];

      // Verify Substack-style guidelines are included in user prompt
      expect(userPrompt).toContain('Substack-Style Writing Guidelines');
      expect(userPrompt).toContain('newsletter-like tone');
      expect(userPrompt).toContain('first-person perspective');
      expect(userPrompt).toContain('engaging hook');
      expect(userPrompt).toContain('personal anecdotes');
      expect(userPrompt).toContain('Address the reader directly');

      // Verify result
      expect(result.title).toBe(mockResponse.title);
      expect(result.content).toBe(mockResponse.content);
    });

    it('should not include Substack-style guidelines when style is "default"', async () => {
      const mockResponse = {
        title: 'Test Blog Title',
        description: 'Test description',
        content: '# Test Content',
        imagePrompt: 'Test image prompt'
      };

      mockGenerateJSONContent.mockResolvedValue(mockResponse);

      const result = await generateBlogContent(
        'Test Title Draft',
        '# Test Content Draft',
        'medium',
        '',
        '',
        'default'
      );

      // Verify LLMService was called
      expect(mockGenerateJSONContent).toHaveBeenCalled();

      // Get the prompts that were sent
      const callArgs = mockGenerateJSONContent.mock.calls[0];
      const userPrompt = callArgs[1];

      // Verify Substack-style guidelines are NOT included
      expect(userPrompt).not.toContain('Substack-Style Writing Guidelines');
      expect(userPrompt).not.toContain('newsletter-like tone');
      expect(userPrompt).not.toContain('first-person perspective');

      // Verify result
      expect(result.title).toBe(mockResponse.title);
    });

    it('should default to "default" style when style parameter is not provided', async () => {
      const mockResponse = {
        title: 'Test Blog Title',
        description: 'Test description',
        content: '# Test Content',
        imagePrompt: 'Test image prompt'
      };

      mockGenerateJSONContent.mockResolvedValue(mockResponse);

      const result = await generateBlogContent(
        'Test Title Draft',
        '# Test Content Draft',
        'medium',
        '',
        ''
        // style parameter not provided
      );

      // Get the prompts that were sent
      const callArgs = mockGenerateJSONContent.mock.calls[0];
      const userPrompt = callArgs[1];

      // Verify Substack-style guidelines are NOT included (default behavior)
      expect(userPrompt).not.toContain('Substack-Style Writing Guidelines');

      // Verify result
      expect(result.title).toBe(mockResponse.title);
    });
  });

  describe('Parameter Passing', () => {
    it('should pass all parameters correctly to the prompt', async () => {
      const mockResponse = {
        title: 'Test Title',
        description: 'Test description',
        content: 'Test content',
        imagePrompt: 'Test prompt'
      };

      mockGenerateJSONContent.mockResolvedValue(mockResponse);

      const result = await generateBlogContent(
        'My Title Draft',
        '# My Content Draft with seo, keywords',
        'long',
        'Research context here',
        'Special requirements',
        'substack'
      );

      const callArgs = mockGenerateJSONContent.mock.calls[0];
      const userPrompt = callArgs[1];

      // Verify all parameters are in the prompt
      expect(userPrompt).toContain('My Title Draft');
      expect(userPrompt).toContain('My Content Draft with seo, keywords');
      expect(userPrompt).toContain('long');
      expect(userPrompt).toContain('Research context here');
      expect(userPrompt).toContain('Special requirements');
      expect(userPrompt).toContain('Substack-Style Writing Guidelines');

      // Verify result
      expect(result.title).toBe(mockResponse.title);
    });
  });
});

describe('Blog Controller - generateBlogHtml', () => {
  describe('Style Parameter', () => {
    it('should generate Substack-style HTML when style is "substack"', async () => {
      const html = await generateBlogHtml(
        'Test Title',
        'Test description',
        '# Test Content\n\nThis is test content.',
        'https://example.com/image.png',
        'substack'
      );

      // Verify Substack-style characteristics
      expect(html).toContain('font-family: Georgia');
      expect(html).toContain('max-width: 680px');
      expect(html).toContain('line-height: 1.75');
      expect(html).toContain('font-size: 20px');
      expect(html).toContain('font-size: 42px'); // H1 size
      expect(html).toContain('Published on'); // Date format
    });

    it('should generate default-style HTML when style is "default"', async () => {
      const html = await generateBlogHtml(
        'Test Title',
        'Test description',
        '# Test Content\n\nThis is test content.',
        'https://example.com/image.png',
        'default'
      );

      // Verify default-style characteristics
      expect(html).toContain('font-family: -apple-system');
      expect(html).toContain('max-width: 800px');
      expect(html).toContain('line-height: 1.6');
      expect(html).not.toContain('font-family: Georgia');
    });

    it('should default to default style when style parameter is not provided', async () => {
      const html = await generateBlogHtml(
        'Test Title',
        'Test description',
        '# Test Content',
        'https://example.com/image.png'
        // style parameter not provided
      );

      // Verify default-style characteristics
      expect(html).toContain('font-family: -apple-system');
      expect(html).not.toContain('font-family: Georgia');
    });
  });

  describe('HTML Structure', () => {
    it('should include all required elements in Substack style', async () => {
      const html = await generateBlogHtml(
        'My Newsletter Article',
        'A personal take on the topic',
        '# Introduction\n\nThis is my story.',
        'https://example.com/hero.png',
        'substack'
      );

      expect(html).toContain('<title>My Newsletter Article</title>');
      expect(html).toContain('<meta name="description" content="A personal take on the topic">');
      expect(html).toContain('<h1>My Newsletter Article</h1>');
      expect(html).toContain('src="https://example.com/hero.png"');
      expect(html).toContain('class="hero-image"');
    });

    it('should include all required elements in default style', async () => {
      const html = await generateBlogHtml(
        'Blog Article',
        'A standard blog post',
        '# Content',
        'https://example.com/image.png',
        'default'
      );

      expect(html).toContain('<title>Blog Article</title>');
      expect(html).toContain('<h1>Blog Article</h1>');
      expect(html).toContain('src="https://example.com/image.png"');
    });
  });

  describe('Image and Video Styling', () => {
    it('should include CSS styling for images in Substack style', async () => {
      const html = await generateBlogHtml(
        'Test Title',
        'Test description',
        '![Alt text](https://example.com/image.jpg)',
        'https://example.com/hero.png',
        'substack'
      );

      // Verify image CSS is present
      expect(html).toContain('.content img {');
      expect(html).toContain('width: 100%');
      expect(html).toContain('max-width: 100%');
      expect(html).toContain('height: auto');
      expect(html).toContain('border-radius: 4px');
      expect(html).toContain('margin: 32px 0');
    });

    it('should include CSS styling for images in default style', async () => {
      const html = await generateBlogHtml(
        'Test Title',
        'Test description',
        '![Alt text](https://example.com/image.jpg)',
        'https://example.com/hero.png',
        'default'
      );

      // Verify image CSS is present
      expect(html).toContain('.content img {');
      expect(html).toContain('width: 100%');
      expect(html).toContain('max-width: 100%');
      expect(html).toContain('height: auto');
      expect(html).toContain('border-radius: 8px');
      expect(html).toContain('margin: 20px 0');
      expect(html).toContain('box-shadow: 0 2px 8px rgba(0,0,0,0.1)');
    });

    it('should include CSS styling for iframes in Substack style', async () => {
      const html = await generateBlogHtml(
        'Test Title',
        'Test description',
        'Content with iframe',
        'https://example.com/hero.png',
        'substack'
      );

      // Verify iframe CSS is present
      expect(html).toContain('.content iframe');
      expect(html).toContain('aspect-ratio: 16 / 9');
      expect(html).toContain('min-height: 400px');
    });

    it('should include CSS styling for iframes in default style', async () => {
      const html = await generateBlogHtml(
        'Test Title',
        'Test description',
        'Content with iframe',
        'https://example.com/hero.png',
        'default'
      );

      // Verify iframe CSS is present
      expect(html).toContain('.content iframe');
      expect(html).toContain('aspect-ratio: 16 / 9');
      expect(html).toContain('min-height: 400px');
      expect(html).toContain('box-shadow: 0 2px 8px rgba(0,0,0,0.1)');
    });

    it('should include CSS styling for video tags in Substack style', async () => {
      const html = await generateBlogHtml(
        'Test Title',
        'Test description',
        'Content with video',
        'https://example.com/hero.png',
        'substack'
      );

      // Verify video CSS is present
      expect(html).toContain('.content video {');
      expect(html).toContain('width: 100%');
      expect(html).toContain('height: auto');
    });

    it('should include CSS styling for video tags in default style', async () => {
      const html = await generateBlogHtml(
        'Test Title',
        'Test description',
        'Content with video',
        'https://example.com/hero.png',
        'default'
      );

      // Verify video CSS is present
      expect(html).toContain('.content video {');
      expect(html).toContain('width: 100%');
      expect(html).toContain('height: auto');
      expect(html).toContain('box-shadow: 0 2px 8px rgba(0,0,0,0.1)');
    });

    it('should style images and videos in both Substack and default styles', async () => {
      const substackHtml = await generateBlogHtml(
        'Test',
        'Desc',
        '![Image](https://example.com/img.jpg)',
        'https://example.com/hero.png',
        'substack'
      );

      const defaultHtml = await generateBlogHtml(
        'Test',
        'Desc',
        '![Image](https://example.com/img.jpg)',
        'https://example.com/hero.png',
        'default'
      );

      // Both should have image styling
      expect(substackHtml).toContain('.content img {');
      expect(defaultHtml).toContain('.content img {');

      // Both should have iframe styling
      expect(substackHtml).toContain('.content iframe');
      expect(defaultHtml).toContain('.content iframe');

      // Both should have video styling
      expect(substackHtml).toContain('.content video {');
      expect(defaultHtml).toContain('.content video {');
    });
  });
});

describe('Blog Controller - Image Quality Defaulting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateBlogImage', () => {
    it('should default quality to "low" for blog article images', async () => {
      mockGenerateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'blog-hero-123.png'
      });

      await generateBlogImage(
        'A professional business illustration',
        'user123',
        'blog-hero-123.png'
      );

      // Verify that generateImage was called with quality: "low"
      expect(mockGenerateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'A professional business illustration',
          size: '1536x1024',
          quality: 'low', // Should default to low for blog images
          filename: 'blog-hero-123.png',
          userId: 'user123',
          inputImages: []
        })
      );
    });

    it('should use low quality even when filename is auto-generated', async () => {
      mockGenerateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'blog-hero-123.png'
      });

      await generateBlogImage(
        'A professional business illustration',
        'user123'
        // filename not provided - should auto-generate
      );

      // Verify that quality is still "low"
      expect(mockGenerateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          quality: 'low'
        })
      );
    });

    it('should pass low quality to imageService for hero images', async () => {
      mockGenerateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'test-hero.png'
      });

      const result = await generateBlogImage(
        'Test image prompt',
        'user456',
        'test-hero.png'
      );

      expect(result.imageUrl).toBe('https://example.com/image.png');
      expect(result.filename).toBe('test-hero.png');
      
      // Verify the call included quality: "low"
      const callArgs = mockGenerateImage.mock.calls[0][0];
      expect(callArgs.quality).toBe('low');
    });
  });

  describe('generateImage endpoint', () => {
    // Mock Express request and response
    const createMockRequest = (body: any) => ({
      body,
      user: { userId: 'user123', email: 'test@example.com' }
    } as any);

    const createMockResponse = () => {
      const res: any = {};
      res.status = jest.fn().mockReturnValue(res);
      res.json = jest.fn().mockReturnValue(res);
      return res;
    };

    it('should default quality to "low" when generating blog images', async () => {
      // Mock should return the filename that was requested
      mockGenerateImage.mockImplementation((params) => {
        return Promise.resolve({
          success: true,
          imageUrl: 'https://example.com/image.png',
          filename: params.filename || 'generated-blog-image.png'
        });
      });

      const req = createMockRequest({
        prompt: 'A beautiful hero image for a blog post',
        filename: 'blog-hero.png'
      });
      const res = createMockResponse();

      await generateImage(req, res);

      // Verify that generateImage was called with quality: "low"
      expect(mockGenerateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'A beautiful hero image for a blog post',
          size: '1536x1024',
          quality: 'low', // Should default to low for blog images
          filename: 'blog-hero.png',
          userId: 'user123',
          inputImages: []
        })
      );

      // Verify response
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            imageUrl: 'https://example.com/image.png',
            filename: 'blog-hero.png'
          })
        })
      );
    });

    it('should use low quality even when filename is auto-generated', async () => {
      mockGenerateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'generated-blog-image.png'
      });

      const req = createMockRequest({
        prompt: 'Test prompt'
        // filename not provided
      });
      const res = createMockResponse();

      await generateImage(req, res);

      // Verify that quality is still "low"
      const callArgs = mockGenerateImage.mock.calls[0][0];
      expect(callArgs.quality).toBe('low');
    });

    it('should always use low quality for blog article hero images', async () => {
      mockGenerateImage.mockResolvedValue({
        success: true,
        imageUrl: 'https://example.com/image.png',
        filename: 'hero.png'
      });

      const req = createMockRequest({
        prompt: 'A stunning hero image',
        filename: 'hero.png'
      });
      const res = createMockResponse();

      await generateImage(req, res);

      // Verify quality is explicitly set to "low" (not medium or high)
      const callArgs = mockGenerateImage.mock.calls[0][0];
      expect(callArgs.quality).toBe('low');
      expect(callArgs.quality).not.toBe('medium');
      expect(callArgs.quality).not.toBe('medium');
      expect(callArgs.quality).not.toBe('high');
    });
  });

  describe('getWebflowConfig', () => {
    const { getWebflowConfig } = require('../blog');
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

    beforeEach(() => {
      jest.clearAllMocks();
      process.env.NODE_ENV = 'development';
      mockGetSecret.mockClear();
      mockSecretExists.mockClear();
    });

    it('should use per-user secret when userId is provided and secret exists', async () => {
      const userId = 'test-user-123';
      mockSecretExists.mockResolvedValueOnce(true);
      mockGetSecret.mockResolvedValueOnce(JSON.stringify(mockWebflowConfig));

      const config = await getWebflowConfig(userId);

      expect(mockSecretExists).toHaveBeenCalledWith('dev/AgentWeb/Webflow/test-user-123');
      expect(mockGetSecret).toHaveBeenCalledWith('dev/AgentWeb/Webflow/test-user-123');
      expect(mockGetSecret).not.toHaveBeenCalledWith('dev/AgentWeb/Webflow');
      expect(config).toEqual({
        apiToken: 'test-api-token',
        siteId: 'test-site-id',
        collectionId: 'test-collection-id',
        fieldMappings: {
          summary: 'post-summary',
          body: 'post-body',
          image: 'main-image'
        }
      });
    });

    it('should fall back to global secret when userId is provided but per-user secret does not exist', async () => {
      const userId = 'test-user-123';
      mockSecretExists.mockResolvedValueOnce(false);
      mockGetSecret.mockResolvedValueOnce(JSON.stringify(mockWebflowConfig));

      const config = await getWebflowConfig(userId);

      expect(mockSecretExists).toHaveBeenCalledWith('dev/AgentWeb/Webflow/test-user-123');
      expect(mockGetSecret).toHaveBeenCalledWith('dev/AgentWeb/Webflow');
      expect(mockGetSecret).not.toHaveBeenCalledWith('dev/AgentWeb/Webflow/test-user-123');
      expect(config).toEqual({
        apiToken: 'test-api-token',
        siteId: 'test-site-id',
        collectionId: 'test-collection-id',
        fieldMappings: {
          summary: 'post-summary',
          body: 'post-body',
          image: 'main-image'
        }
      });
    });

    it('should use global secret when userId is not provided', async () => {
      mockGetSecret.mockResolvedValueOnce(JSON.stringify(mockWebflowConfig));

      const config = await getWebflowConfig();

      expect(mockSecretExists).not.toHaveBeenCalled();
      expect(mockGetSecret).toHaveBeenCalledWith('dev/AgentWeb/Webflow');
      expect(config).toEqual({
        apiToken: 'test-api-token',
        siteId: 'test-site-id',
        collectionId: 'test-collection-id',
        fieldMappings: {
          summary: 'post-summary',
          body: 'post-body',
          image: 'main-image'
        }
      });
    });

    it('should use production secret name in production environment', async () => {
      process.env.NODE_ENV = 'production';
      mockGetSecret.mockResolvedValueOnce(JSON.stringify(mockWebflowConfig));

      const config = await getWebflowConfig();

      expect(mockGetSecret).toHaveBeenCalledWith('prod/AgentWeb/Webflow');
      expect(config).toBeDefined();
    });

    it('should use default field mappings when not provided in secret', async () => {
      const configWithoutMappings = {
        apiToken: 'test-api-token',
        siteId: 'test-site-id',
        collectionId: 'test-collection-id'
      };
      mockGetSecret.mockResolvedValueOnce(JSON.stringify(configWithoutMappings));

      const config = await getWebflowConfig();

      expect(config.fieldMappings).toEqual({
        summary: 'post-summary',
        body: 'post-body',
        image: 'main-image',
        publishDate: undefined
      });
    });

    it('should throw error when required fields are missing', async () => {
      const invalidConfig = {
        apiToken: 'test-api-token'
        // Missing siteId and collectionId
      };
      mockGetSecret.mockResolvedValueOnce(JSON.stringify(invalidConfig));

      await expect(getWebflowConfig()).rejects.toThrow('Webflow configuration missing required fields');
    });

    it('should throw error with details when secret fetch fails', async () => {
      const error: any = new Error('Secret not found');
      error.code = 'ResourceNotFoundException';
      mockGetSecret.mockRejectedValueOnce(error);

      await expect(getWebflowConfig()).rejects.toThrow('Failed to fetch Webflow configuration from Secrets Manager');
    });
  });
});

