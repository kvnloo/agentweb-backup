import { AgentModeService, agentModeService as singletonAgentService } from '../services/agentModeService';

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    }))
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  config: {
    update: jest.fn()
  }
}));

// Mock axios
jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn()
}));

// Mock crypto
jest.mock('crypto', () => ({
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('mock-hash')
  })),
  getRandomValues: jest.fn((arr) => {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  })
}));

// Mock LLMService
jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn().mockReturnValue({
    generateHTML: jest.fn()
  })
}));

// Mock s3Utils
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/bucket/html_1234567890_Test_Title.html'
  })
}));

describe('AgentModeService - createHtmlFile', () => {
  let agentModeService: AgentModeService;
  let mockGenerateHTML: jest.Mock;
  let mockUploadFileToS3: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Create service instance
    agentModeService = new AgentModeService();
    await agentModeService.initialize();

    // Get mocked functions
    const { createLLMService } = require('../utils/llmService');
    const mockLLMService = createLLMService();
    mockGenerateHTML = mockLLMService.generateHTML;

    const { uploadFileToS3 } = require('../utils/s3Utils');
    mockUploadFileToS3 = uploadFileToS3;
  });

  describe('createHtmlFile', () => {
    const mockHtmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Title</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    h1 { color: #333; }
  </style>
</head>
<body>
  <h1>Test Title</h1>
  <p>This is test content.</p>
</body>
</html>`;

    beforeEach(() => {
      mockGenerateHTML.mockResolvedValue(mockHtmlContent);
      mockUploadFileToS3.mockResolvedValue({
        success: true,
        url: 'https://s3.amazonaws.com/bucket/html_1234567890_Test_Title.html'
      });
    });

    it('should create HTML file with title and content draft', async () => {
      const result = await (agentModeService as any).createHtmlFile(
        'Test Title',
        'This is test content.',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.s3_url).toBe('https://s3.amazonaws.com/bucket/html_1234567890_Test_Title.html');
      expect(result.title).toBe('Test Title');
      expect(result.filename).toContain('html_');
      expect(result.filename).toContain('Test_Title');
      expect(mockGenerateHTML).toHaveBeenCalled();
      expect(mockUploadFileToS3).toHaveBeenCalled();
    });

    it('should include format requirements in the prompt', async () => {
      await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        'Use dark theme with modern design',
        'user123',
        'session123'
      );

      expect(mockGenerateHTML).toHaveBeenCalledWith(
        expect.stringContaining('dark theme'),
        expect.stringContaining('Format Requirements:\nUse dark theme with modern design'),
        expect.any(Function)
      );
    });

    it('should use Claude model by default', async () => {
      const { createLLMService } = require('../utils/llmService');
      
      await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(createLLMService).toHaveBeenCalledWith(
        'anthropic.claude-sonnet-4-6',
        0.8,
        64000
      );
    });

    it('should sanitize title in filename', async () => {
      const result = await (agentModeService as any).createHtmlFile(
        'Test Title with Special/Characters!',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(result.filename).toMatch(/html_\d+_Test_Title_with_Special_Characters/);
    });

    it('should handle S3 upload errors', async () => {
      mockUploadFileToS3.mockResolvedValue({
        success: false,
        error: 'S3 upload failed'
      });

      const result = await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to create HTML file');
      expect(result.error).toContain('S3 upload failed');
    });

    it('should handle LLM generation errors', async () => {
      mockGenerateHTML.mockRejectedValue(new Error('LLM API error'));

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to create HTML file');
      expect(result.error).toContain('LLM API error');
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    it('should handle empty HTML content from LLM', async () => {
      mockGenerateHTML.mockResolvedValue('');

      const result = await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to create HTML file');
      expect(result.error).toContain('LLM did not generate HTML content');
    });

    it('should handle whitespace-only HTML content', async () => {
      mockGenerateHTML.mockResolvedValue('   \n\t  ');

      const result = await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to create HTML file');
      expect(result.error).toContain('LLM did not generate HTML content');
    });

    it('should pass correct parameters to uploadFileToS3', async () => {
      await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(mockUploadFileToS3).toHaveBeenCalledWith(
        mockHtmlContent,
        expect.stringMatching(/^html_\d+_Test_Title\.html$/),
        'user123',
        'text/html'
      );
    });

    it('should truncate long titles in filename', async () => {
      const longTitle = 'A'.repeat(100);
      const result = await (agentModeService as any).createHtmlFile(
        longTitle,
        'Test content',
        '',
        'user123',
        'session123'
      );

      // Filename should be truncated to 50 characters (plus extension)
      expect(result.filename.length).toBeLessThan(100);
      expect(result.filename).toMatch(/^html_\d+_A{1,50}\.html$/);
    });

    it('should log success message', async () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(consoleLogSpy).toHaveBeenCalledWith(
        'AgentMode: Generating HTML file with LLMService (Claude model)'
      );
      // console.log is called with two arguments: message and URL
      expect(consoleLogSpy).toHaveBeenCalledWith(
        'AgentMode: HTML file created and uploaded successfully to:',
        expect.stringContaining('https://s3.amazonaws.com')
      );

      consoleLogSpy.mockRestore();
    });
  });

  describe('create_html_file function call handler', () => {
    beforeEach(() => {
      jest.spyOn(singletonAgentService as any, 'createHtmlFile').mockImplementation(async (title, content_draft, format_requirements, userId, sessionId) => {
        if (!title) return { success: false, message: 'title is required' };
        if (!content_draft) return { success: false, message: 'content_draft is required' };
        return {
          success: true,
          s3_url: 'https://s3.amazonaws.com/bucket/test.html',
          filename: 'test.html',
          title: 'Test Title',
          message: 'HTML file created successfully'
        };
      });
    });

    it('should handle create_html_file function call with all parameters', async () => {
      const result = await (agentModeService as any).executeTool(
        'gpt-4',
        'create_html_file',
        {
          title: 'Test Title',
          content_draft: 'Test content',
          format_requirements: 'Use modern design'
        },
        'user123',
        'session123',
        false
      );

      expect(result.success).toBe(true);
      expect((singletonAgentService as any).createHtmlFile).toHaveBeenCalledWith(
        'Test Title',
        'Test content',
        'Use modern design',
        'user123',
        'session123'
      );
    });

    it('should handle create_html_file without format_requirements', async () => {
      const result = await (agentModeService as any).executeTool(
        'gpt-4',
        'create_html_file',
        {
          title: 'Test Title',
          content_draft: 'Test content'
        },
        'user123',
        'session123',
        false
      );

      expect(result.success).toBe(true);
      expect((singletonAgentService as any).createHtmlFile).toHaveBeenCalledWith(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );
    });

    it('should return error when title is missing', async () => {
      await expect(
        (agentModeService as any).executeTool(
          'gpt-4',
          'create_html_file',
          {
            content_draft: 'Test content'
          },
          'user123',
          'session123',
          false
        )
      ).rejects.toThrow('title is required and must be a string');

      expect((singletonAgentService as any).createHtmlFile).not.toHaveBeenCalled();
    });

    it('should return error when content_draft is missing', async () => {
      await expect(
        (agentModeService as any).executeTool(
          'gpt-4',
          'create_html_file',
          {
            title: 'Test Title'
          },
          'user123',
          'session123',
          false
        )
      ).rejects.toThrow('content_draft is required and must be a string');

      expect((singletonAgentService as any).createHtmlFile).not.toHaveBeenCalled();
    });

    it('should handle mock mode for create_html_file', async () => {
      const result = await (agentModeService as any).executeTool(
        'gpt-4',
        'create_html_file',
        {
          title: 'Test Title',
          content_draft: 'Test content',
          format_requirements: 'Modern design'
        },
        'user123',
        'session123',
        true // mockMode = true
      );

      expect(result.success).toBe(true);
      expect(result.s3_url).toContain('mock-s3-bucket');
      expect(result.title).toBe('Test Title');
      expect(result.message).toContain('Mock HTML file created successfully');
      expect((singletonAgentService as any).createHtmlFile).not.toHaveBeenCalled();
    });

    it('should validate title in mock mode', async () => {
      const result = await (agentModeService as any).executeTool(
        'gpt-4',
        'create_html_file',
        {
          content_draft: 'Test content'
        },
        'user123',
        'session123',
        true // mockMode = true
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('title is required');
    });

    it('should validate content_draft in mock mode', async () => {
      const result = await (agentModeService as any).executeTool(
        'gpt-4',
        'create_html_file',
        {
          title: 'Test Title'
        },
        'user123',
        'session123',
        true // mockMode = true
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('content_draft is required');
    });
  });
});

