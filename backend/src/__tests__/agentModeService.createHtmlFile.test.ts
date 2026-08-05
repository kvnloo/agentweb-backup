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
// `create` matters even though this suite never calls it: when SLACK_BOT_TOKEN is
// set in the environment, importing agentModeService constructs a Slack WebClient
// at module load, which calls axios.create(). Without it the suite fails to load.
jest.mock('axios', () => {
  const instance = {
    get: jest.fn(),
    post: jest.fn(),
    request: jest.fn(),
    defaults: { headers: { common: {}, post: {} } },
    interceptors: {
      request: { use: jest.fn(), eject: jest.fn() },
      response: { use: jest.fn(), eject: jest.fn() }
    }
  };
  return {
    get: jest.fn(),
    post: jest.fn(),
    create: jest.fn(() => instance)
  };
});

// Mock crypto
jest.mock('crypto', () => ({
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('mock-hash')
  })),
  randomUUID: jest.fn().mockReturnValue('mock-uuid-1234'),
  randomBytes: jest.fn((size: number) => Buffer.alloc(size, 0)),
  randomFillSync: jest.fn((arr: Uint8Array) => {
    for (let i = 0; i < arr.length; i++) arr[i] = 0;
    return arr;
  }),
  getRandomValues: jest.fn((arr: Uint8Array) => {
    for (let i = 0; i < arr.length; i++) arr[i] = 0;
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

    // Reset static flag so emma tools get re-registered on each test instance.
    // Without this, if another test suite ran initialize() first and set
    // toolsRegistered=true, the emma tool bridge (which registers create_html_file)
    // is skipped and executeTool throws "Unknown tool: create_html_file".
    (AgentModeService as any).toolsRegistered = false;

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
        expect.any(Function),
        { userId: expect.any(String), sessionId: expect.any(String), feature: 'content_gen' }
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

    // ENG-873: a render failure must no longer discard the draft. The draft is
    // rendered deterministically instead, so the deliverable still exists.
    it('degrades to a deterministic render when the LLM generation errors', async () => {
      mockGenerateHTML.mockRejectedValue(new Error('LLM API error'));

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.degraded).toBe(true);
      expect(result.degraded_reason).toContain('LLM API error');
      expect(result.s3_url).toBeDefined();

      consoleWarnSpy.mockRestore();
    });

    it('degrades to a deterministic render when the LLM returns empty content', async () => {
      mockGenerateHTML.mockResolvedValue('');

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.degraded).toBe(true);
      expect(result.degraded_reason).toContain('LLM did not generate HTML content');

      consoleWarnSpy.mockRestore();
    });

    it('degrades to a deterministic render when the LLM returns whitespace-only content', async () => {
      mockGenerateHTML.mockResolvedValue('   \n\t  ');

      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.degraded).toBe(true);
      expect(result.degraded_reason).toContain('LLM did not generate HTML content');

      consoleWarnSpy.mockRestore();
    });

    // ENG-203: the final HTML render is a single long-running LLM call that can
    // hit the Bedrock 5-minute requestTimeout. Without a retry, one transient
    // timeout discards ALL completed upstream work. createHtmlFile must retry the
    // render step on transient errors so a single blip no longer loses the report.
    describe('transient render failure retry (ENG-203)', () => {
      beforeEach(() => {
        // Reset the render mock's queue so each test starts clean. jest.clearAllMocks()
        // only clears call data, not queued mockRejectedValueOnce/mockResolvedValueOnce
        // values — without this reset, a test's leftover once-values could leak into the
        // next test depending on how many times the fix happens to call generateHTML.
        mockGenerateHTML.mockReset();
        // Avoid real backoff delays in tests.
        jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined);
      });

      it('retries the render step on a transient timeout and then succeeds', async () => {
        const timeoutError = Object.assign(new Error('Connection timed out'), { name: 'TimeoutError' });
        mockGenerateHTML
          .mockRejectedValueOnce(timeoutError)
          .mockResolvedValueOnce(mockHtmlContent);

        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

        const result = await (agentModeService as any).createHtmlFile(
          'Test Title',
          'Test content',
          '',
          'user123',
          'session123'
        );

        expect(result.success).toBe(true);
        expect(result.s3_url).toBeDefined();
        expect(mockGenerateHTML).toHaveBeenCalledTimes(2);

        consoleWarnSpy.mockRestore();
      });

      it('does NOT retry a non-transient render error', async () => {
        // "invalid" is a terminal error — retrying the identical call is pointless.
        mockGenerateHTML.mockRejectedValue(new Error('invalid request payload'));

        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

        const result = await (agentModeService as any).createHtmlFile(
          'Test Title',
          'Test content',
          '',
          'user123',
          'session123'
        );

        expect(mockGenerateHTML).toHaveBeenCalledTimes(1);
        // ENG-873: terminal or not, the draft is still delivered.
        expect(result.success).toBe(true);
        expect(result.degraded).toBe(true);
        expect(result.degraded_reason).toContain('invalid request payload');

        consoleWarnSpy.mockRestore();
      });

      it('stops retrying after exhausting attempts on a persistent transient error', async () => {
        const timeoutError = Object.assign(new Error('Connection timed out'), { name: 'TimeoutError' });
        mockGenerateHTML.mockRejectedValue(timeoutError);

        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

        const result = await (agentModeService as any).createHtmlFile(
          'Test Title',
          'Test content',
          '',
          'user123',
          'session123'
        );

        expect(mockGenerateHTML).toHaveBeenCalledTimes(3);
        expect(result.degraded).toBe(true);
        expect(result.degraded_reason).toContain('timed out');
        // Exhaustion on a transient error is logged distinctly so it can be
        // separated from one-off blips and terminal errors (ENG-203 observability).
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('exhausted all 3 attempts on a transient error'),
          expect.anything()
        );

        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
      });
    });

    // ENG-873: a scheduled 40-competitor report completed 100% of its research and
    // then lost the deliverable entirely — create_html_file timed out twice on a
    // ~45K-char draft ("Stream timed out because of no activity for 300000 ms"),
    // each attempt burning the full retry budget, and the session ended with no
    // HTML report at all. A render timeout on a draft that large is a deterministic
    // property of the payload, not a blip: re-running the same monolithic render
    // spends another five minutes reaching the same failure. So the render stops
    // retrying, and the completed draft is delivered as a deterministically
    // rendered HTML document instead of being discarded.
    describe('large-draft render timeout degrades gracefully (ENG-873)', () => {
      const largeDraft = `# Monthly Competitor Intelligence Report\n\n${'Competitor detail line.\n'.repeat(2000)}`;

      beforeEach(() => {
        mockGenerateHTML.mockReset();
        jest.spyOn(agentModeService as any, 'sleep').mockResolvedValue(undefined);
      });

      const streamTimeout = () =>
        new Error('Stream timed out because of no activity for 300000 ms');

      it('does not retry the render after the first timeout on a large draft', async () => {
        mockGenerateHTML.mockRejectedValue(streamTimeout());
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

        await (agentModeService as any).createHtmlFile(
          'Monthly Competitor Intelligence Report',
          largeDraft,
          '',
          'user123',
          'session123'
        );

        expect(mockGenerateHTML).toHaveBeenCalledTimes(1);

        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
      });

      it('delivers the draft as a deterministically rendered HTML file instead of failing', async () => {
        mockGenerateHTML.mockRejectedValue(streamTimeout());
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

        const result = await (agentModeService as any).createHtmlFile(
          'Monthly Competitor Intelligence Report',
          largeDraft,
          '',
          'user123',
          'session123'
        );

        expect(result.success).toBe(true);
        expect(result.s3_url).toBeDefined();
        expect(result.degraded).toBe(true);
        expect(result.degraded_reason).toContain('timed out');
        // The model must be told not to re-issue the identical call — a second
        // monolithic attempt is what stranded the reported session.
        expect(result.message).toMatch(/do not call create_html_file again/i);

        // The uploaded file is a complete HTML document carrying the draft content.
        const [uploadedContent, uploadedName, uploadedUser, uploadedType] =
          mockUploadFileToS3.mock.calls[0];
        expect(uploadedContent.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(uploadedContent).toContain('Monthly Competitor Intelligence Report');
        expect(uploadedContent).toContain('Competitor detail line.');
        expect(uploadedName).toMatch(/\.html$/);
        expect(uploadedUser).toBe('user123');
        expect(uploadedType).toBe('text/html');

        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
      });

      it('reports a real failure when the fallback upload also fails', async () => {
        mockGenerateHTML.mockRejectedValue(streamTimeout());
        mockUploadFileToS3.mockResolvedValue({ success: false, error: 'S3 upload failed' });
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
        const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

        const result = await (agentModeService as any).createHtmlFile(
          'Monthly Competitor Intelligence Report',
          largeDraft,
          '',
          'user123',
          'session123'
        );

        expect(result.success).toBe(false);
        expect(result.message).toBe('Failed to create HTML file');
        expect(result.error).toContain('timed out');

        consoleErrorSpy.mockRestore();
        consoleWarnSpy.mockRestore();
      });
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

    it('should default to document mode and report an HTML file', async () => {
      const result = await (agentModeService as any).createHtmlFile(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.document_type).toBe('document');
      expect(result.message).toBe('HTML file created successfully');
      // Document mode uses the general HTML-document system prompt
      expect(mockGenerateHTML).toHaveBeenCalledWith(
        expect.stringContaining('professional HTML document'),
        expect.stringContaining('professional HTML document'),
        expect.any(Function),
        { userId: expect.any(String), sessionId: expect.any(String), feature: 'content_gen' }
      );
    });

    it('should use an email-client-safe prompt when document_type is email', async () => {
      const result = await (agentModeService as any).createHtmlFile(
        'Aquila May 2026 Newsletter',
        'Big product news this month...',
        '',
        'user123',
        'session123',
        'email'
      );

      expect(result.success).toBe(true);
      expect(result.document_type).toBe('email');
      expect(result.message).toBe('HTML email created successfully');

      const [systemPrompt, userPrompt] = mockGenerateHTML.mock.calls[0];
      // Email mode must steer toward email-client-safe markup
      expect(systemPrompt).toContain('HTML email designer');
      expect(systemPrompt).toContain('table-based layout');
      expect(systemPrompt).toContain('INLINE styles');
      // And must NOT produce reusable {{variable}} templates
      expect(systemPrompt).toContain('not a reusable template');
      expect(userPrompt).toContain('ready-to-send HTML email');
    });

    it('should pass format requirements through in email mode', async () => {
      await (agentModeService as any).createHtmlFile(
        'Aquila May 2026 Newsletter',
        'Content',
        'Use brand color #1a73e8 and a Book a Demo CTA',
        'user123',
        'session123',
        'email'
      );

      expect(mockGenerateHTML).toHaveBeenCalledWith(
        expect.stringContaining('#1a73e8'),
        expect.any(String),
        expect.any(Function),
        { userId: expect.any(String), sessionId: expect.any(String), feature: 'content_gen' }
      );
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
      // The execute handler in emma/tools.ts calls agentModeService.createHtmlFile on the
      // module-level singleton. Spy on the singleton so assertions can verify it was called.
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
        'session123',
        'document'
      );
    });

    it('should pass document_type=email through to createHtmlFile', async () => {
      const result = await (agentModeService as any).executeTool(
        'gpt-4',
        'create_html_file',
        {
          title: 'Aquila May 2026 Newsletter',
          content_draft: 'Newsletter content',
          document_type: 'email'
        },
        'user123',
        'session123',
        false
      );

      expect(result.success).toBe(true);
      expect((singletonAgentService as any).createHtmlFile).toHaveBeenCalledWith(
        'Aquila May 2026 Newsletter',
        'Newsletter content',
        '',
        'user123',
        'session123',
        'email'
      );
    });

    it('should default document_type to document when omitted', async () => {
      await (agentModeService as any).executeTool(
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

      expect((singletonAgentService as any).createHtmlFile).toHaveBeenCalledWith(
        'Test Title',
        'Test content',
        '',
        'user123',
        'session123',
        'document'
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
        'session123',
        'document'
      );
    });

    it('should return error when title is missing', async () => {
      const result = await (agentModeService as any).executeTool(
        'gpt-4',
        'create_html_file',
        {
          content_draft: 'Test content'
        },
        'user123',
        'session123',
        false
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Missing required argument "title"')
      });
      expect((singletonAgentService as any).createHtmlFile).not.toHaveBeenCalled();
    });

    it('should return error when content_draft is missing', async () => {
      const result = await (agentModeService as any).executeTool(
        'gpt-4',
        'create_html_file',
        {
          title: 'Test Title'
        },
        'user123',
        'session123',
        false
      );

      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Missing required argument "content_draft"')
      });
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
      expect(result.error).toContain('Missing required argument "title"');
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
      expect(result.error).toContain('Missing required argument "content_draft"');
    });

    it('should repair update_html_file replacement_json alias in direct executeTool calls', async () => {
      const result = await (agentModeService as any).executeTool(
        'gpt-4',
        'update_html_file',
        {
          file_url: 'https://example.com/report.html',
          update_type: 'full',
          replacement_json: JSON.stringify([
            {
              old_content_hash: 'abc123',
              new_content: '<!doctype html><html><body>Updated</body></html>',
              expected_count: 1,
            },
          ]),
        },
        'user123',
        'session123',
        true
      );

      expect(result.success).toBe(true);
      expect(result.s3_url).toContain('mock-s3-bucket');
      expect(result.replacements).toEqual([
        expect.objectContaining({
          old_content_hash: 'abc123',
          new_content: '<!doctype html><html><body>Updated</body></html>',
          expected_count: 1,
          success: true,
        }),
      ]);
    });

    it('should validate and repair contracts in direct executeTool calls before registry execution', async () => {
      const execute = jest.fn(async (args) => ({ success: true, args }));
      (agentModeService as any).toolRegistry.register({
        name: 'contract_test_tool',
        definition: {
          type: 'function',
          function: {
            name: 'contract_test_tool',
            description: 'Test-only contract tool',
            parameters: {
              type: 'object',
              properties: {
                canonical: { type: 'string', 'x-aliases': ['alias'] },
              },
              required: ['canonical'],
              additionalProperties: false,
            },
          },
        },
        execute,
      });

      const repaired = await (agentModeService as any).executeTool(
        'gpt-4',
        'contract_test_tool',
        { alias: 'value' },
        'user123',
        'session123',
        false
      );

      expect(repaired).toEqual({ success: true, args: { canonical: 'value' } });
      expect(execute).toHaveBeenCalledWith(
        { canonical: 'value' },
        expect.objectContaining({ userId: 'user123', sessionId: 'session123' })
      );

      execute.mockClear();
      const invalid = await (agentModeService as any).executeTool(
        'gpt-4',
        'contract_test_tool',
        {},
        'user123',
        'session123',
        false
      );

      expect(invalid).toMatchObject({
        success: false,
        error: expect.stringContaining('Missing required argument "canonical"'),
      });
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
