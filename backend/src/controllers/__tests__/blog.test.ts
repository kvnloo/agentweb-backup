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

// Mock OpenAI before importing blog module
const mockCreate = jest.fn();
jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate
        }
      }
    }))
  };
});

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
jest.mock('../../utils/secretsManager', () => ({
  getSecret: jest.fn().mockResolvedValue('test-secret-value')
}));

// Mock imageGeneration service
jest.mock('../../services/imageGeneration', () => ({
  imageService: {
    generateImage: jest.fn().mockResolvedValue({
      success: true,
      imageUrl: 'https://example.com/image.png',
      filename: 'test.png'
    }),
    isAvailable: jest.fn().mockResolvedValue(true)
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

import { generateBlogContent, generateBlogHtml } from '../blog';

describe('Blog Controller - generateBlogContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Style Parameter', () => {
    it('should include Substack-style guidelines when style is "substack"', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'My Personal Take on Test Topic',
              description: 'A personal newsletter-style article',
              content: '# My Experience\n\nI\'ve been thinking about this topic...',
              imagePrompt: 'A personal, newsletter-style image'
            })
          }
        }]
      };

      mockCreate.mockResolvedValue(mockResponse as any);

      await generateBlogContent(
        'Test Topic',
        'keyword1',
        'conversational',
        'medium',
        '',
        '',
        'substack'
      );

      // Verify OpenAI was called
      expect(mockCreate).toHaveBeenCalled();

      // Get the prompt that was sent
      const callArgs = mockCreate.mock.calls[0];
      const messages = callArgs[0].messages;
      const userMessage = messages.find((m: any) => m.role === 'user');

      // Verify Substack-style guidelines are included
      expect(userMessage.content).toContain('Substack-Style Writing Guidelines');
      expect(userMessage.content).toContain('newsletter-like tone');
      expect(userMessage.content).toContain('first-person perspective');
      expect(userMessage.content).toContain('engaging hook');
      expect(userMessage.content).toContain('personal anecdotes');
      expect(userMessage.content).toContain('Address the reader directly');
    });

    it('should not include Substack-style guidelines when style is "default"', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'Test Blog Title',
              description: 'Test description',
              content: '# Test Content',
              imagePrompt: 'Test image prompt'
            })
          }
        }]
      };

      mockCreate.mockResolvedValue(mockResponse as any);

      await generateBlogContent(
        'Test Topic',
        '',
        'professional',
        'medium',
        '',
        '',
        'default'
      );

      // Verify OpenAI was called
      expect(mockCreate).toHaveBeenCalled();

      // Get the prompt that was sent
      const callArgs = mockCreate.mock.calls[0];
      const messages = callArgs[0].messages;
      const userMessage = messages.find((m: any) => m.role === 'user');

      // Verify Substack-style guidelines are NOT included
      expect(userMessage.content).not.toContain('Substack-Style Writing Guidelines');
      expect(userMessage.content).not.toContain('newsletter-like tone');
      expect(userMessage.content).not.toContain('first-person perspective');
    });

    it('should default to "default" style when style parameter is not provided', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'Test Blog Title',
              description: 'Test description',
              content: '# Test Content',
              imagePrompt: 'Test image prompt'
            })
          }
        }]
      };

      mockCreate.mockResolvedValue(mockResponse as any);

      await generateBlogContent(
        'Test Topic',
        '',
        'professional',
        'medium',
        '',
        ''
        // style parameter not provided
      );

      // Get the prompt that was sent
      const callArgs = mockCreate.mock.calls[0];
      const messages = callArgs[0].messages;
      const userMessage = messages.find((m: any) => m.role === 'user');

      // Verify Substack-style guidelines are NOT included (default behavior)
      expect(userMessage.content).not.toContain('Substack-Style Writing Guidelines');
    });
  });

  describe('Parameter Passing', () => {
    it('should pass all parameters correctly to the prompt', async () => {
      const mockResponse = {
        choices: [{
          message: {
            content: JSON.stringify({
              title: 'Test Title',
              description: 'Test description',
              content: 'Test content',
              imagePrompt: 'Test prompt'
            })
          }
        }]
      };

      mockCreate.mockResolvedValue(mockResponse as any);

      await generateBlogContent(
        'My Topic',
        'seo, keywords',
        'casual',
        'long',
        'Research context here',
        'Special requirements',
        'substack'
      );

      const callArgs = mockCreate.mock.calls[0];
      const messages = callArgs[0].messages;
      const userMessage = messages.find((m: any) => m.role === 'user');

      // Verify all parameters are in the prompt
      expect(userMessage.content).toContain('My Topic');
      expect(userMessage.content).toContain('seo, keywords');
      expect(userMessage.content).toContain('casual');
      expect(userMessage.content).toContain('long');
      expect(userMessage.content).toContain('Research context here');
      expect(userMessage.content).toContain('Special requirements');
      expect(userMessage.content).toContain('Substack-Style Writing Guidelines');
    });
  });
});

describe('Blog Controller - generateBlogHtml', () => {
  describe('Style Parameter', () => {
    it('should generate Substack-style HTML when style is "substack"', () => {
      const html = generateBlogHtml(
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

    it('should generate default-style HTML when style is "default"', () => {
      const html = generateBlogHtml(
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

    it('should default to default style when style parameter is not provided', () => {
      const html = generateBlogHtml(
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
    it('should include all required elements in Substack style', () => {
      const html = generateBlogHtml(
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

    it('should include all required elements in default style', () => {
      const html = generateBlogHtml(
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
    it('should include CSS styling for images in Substack style', () => {
      const html = generateBlogHtml(
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

    it('should include CSS styling for images in default style', () => {
      const html = generateBlogHtml(
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

    it('should include CSS styling for iframes in Substack style', () => {
      const html = generateBlogHtml(
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

    it('should include CSS styling for iframes in default style', () => {
      const html = generateBlogHtml(
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

    it('should include CSS styling for video tags in Substack style', () => {
      const html = generateBlogHtml(
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

    it('should include CSS styling for video tags in default style', () => {
      const html = generateBlogHtml(
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

    it('should style images and videos in both Substack and default styles', () => {
      const substackHtml = generateBlogHtml(
        'Test',
        'Desc',
        '![Image](https://example.com/img.jpg)',
        'https://example.com/hero.png',
        'substack'
      );

      const defaultHtml = generateBlogHtml(
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

