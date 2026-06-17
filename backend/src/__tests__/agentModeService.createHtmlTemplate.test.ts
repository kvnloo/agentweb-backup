import { AgentModeService } from '../services/agentModeService';

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
  randomUUID: jest.fn().mockReturnValue('mock-uuid-1234'),
  randomFillSync: jest.fn((arr) => {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  }),
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
    generateHTML: jest.fn(),
    generateJsonRobust: jest.fn()
  })
}));

// Mock settingsService
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn()
  }
}));

// Mock chatbotService for getChatSession
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      userId: 'test-user-123'
    })
  }
}));

// Mock global fetch
global.fetch = jest.fn();

describe('AgentModeService - createHtmlTemplate', () => {
  let agentModeService: AgentModeService;
  let mockGenerateHTML: jest.Mock;
  let mockGenerateJsonRobust: jest.Mock;
  let mockGetSetting: jest.Mock;
  let mockSetSetting: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Create service instance
    agentModeService = new AgentModeService();
    await agentModeService.initialize();

    // Get mocked functions
    const { createLLMService } = require('../utils/llmService');
    const mockLLMService = createLLMService();
    mockGenerateHTML = mockLLMService.generateHTML;
    mockGenerateJsonRobust = mockLLMService.generateJsonRobust;

    const { settingsService } = require('../services/settingsService');
    mockGetSetting = settingsService.getSetting;
    mockSetSetting = settingsService.setSetting;
  });

  describe('createHtmlTemplate', () => {
    const mockInputHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Welcome Email</title>
  <style>
    body { font-family: Arial, sans-serif; }
  </style>
</head>
<body>
  <h1>Welcome to Our Service</h1>
  <p>Hello, User!</p>
  <p>We're excited to have you on board.</p>
</body>
</html>`;

    const mockEnhancedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Welcome Email</title>
  <style>
    body { font-family: Arial, sans-serif; }
  </style>
</head>
<body>
  <h1>Welcome to Our Service</h1>
  <p>Hello, {{user_name}}!</p>
  <p>We're excited to have you on board at {{company_name}}.</p>
  <ul>
    <li>{{features_n}}: {{features_n_description}}</li>
  </ul>
</body>
</html>`;

    it('should create HTML template from HTML content', async () => {
      // Setup mocks
      mockGenerateHTML.mockResolvedValue(mockEnhancedHtml);
      mockGetSetting.mockResolvedValue(null); // No existing templates
      mockSetSetting.mockResolvedValue(undefined);

      // Execute
      const result = await agentModeService.createHtmlTemplate(
        mockInputHtml,
        undefined,
        'welcome_email',
        'Welcome to {{company_name}}!',
        'Add variables for user name and company name',
        'test-user-123',
        'test-session-123'
      );

      // Verify
      expect(result.success).toBe(true);
      expect(result.template_name).toBe('welcome_email');
      expect(result.subject).toBe('Welcome to {{company_name}}!');
      expect(result.variables).toEqual(expect.arrayContaining(['user_name', 'company_name']));
      expect(result.arrayVariables).toEqual(expect.arrayContaining(['features_n', 'features_n_description']));

      // Verify LLM was called with correct prompts
      expect(mockGenerateHTML).toHaveBeenCalledWith(
        expect.stringContaining('HTML email template designer'),
        expect.stringContaining('welcome_email'),
        expect.any(Function),
        { userId: expect.any(String), sessionId: expect.any(String), feature: 'content_gen' }
      );

      // Verify template was saved
      expect(mockSetSetting).toHaveBeenCalledWith(
        'templates_test-user-123',
        expect.stringContaining('welcome_email'),
        'User templates',
        'test-user-123'
      );
    });

    it('should create HTML template from S3 URL', async () => {
      // Setup mocks
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(mockInputHtml)
      });
      mockGenerateHTML.mockResolvedValue(mockEnhancedHtml);
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      // Execute
      const result = await agentModeService.createHtmlTemplate(
        'https://s3.amazonaws.com/bucket/test.html',
        undefined,
        'welcome_email',
        'Welcome!',
        '',
        'test-user-123',
        'test-session-123'
      );

      // Verify
      expect(result.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith('https://s3.amazonaws.com/bucket/test.html');
    });

    it('should update existing template', async () => {
      // Setup mocks - existing template
      const existingTemplates = [
        {
          template_name: 'welcome_email',
          subject: 'Old Subject',
          html_content: '<html>Old content</html>',
          variables: [],
          arrayVariables: [],
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z'
        }
      ];

      mockGetSetting.mockResolvedValue({
        settingValue: JSON.stringify(existingTemplates)
      });
      mockGenerateHTML.mockResolvedValue(mockEnhancedHtml);
      mockSetSetting.mockResolvedValue(undefined);

      // Execute
      const result = await agentModeService.createHtmlTemplate(
        mockInputHtml,
        undefined,
        'welcome_email',
        'Welcome to {{company_name}}!',
        'Add variables',
        'test-user-123',
        'test-session-123'
      );

      // Verify
      expect(result.success).toBe(true);

      // Verify the saved templates preserve created_at
      const savedData = JSON.parse(mockSetSetting.mock.calls[0][1]);
      expect(savedData[0].created_at).toBe('2024-01-01T00:00:00.000Z');
      expect(savedData[0].updated_at).not.toBe('2024-01-01T00:00:00.000Z'); // Should be updated
    });

    it('should handle fetch errors', async () => {
      // Setup mocks
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        statusText: 'Not Found'
      });

      // Execute
      const result = await agentModeService.createHtmlTemplate(
        'https://s3.amazonaws.com/bucket/nonexistent.html',
        undefined,
        'test_template',
        'Test Subject',
        '',
        'test-user-123',
        'test-session-123'
      );

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toContain('Not Found');
    });

    it('should return a clean error when html_source is undefined (no startsWith crash)', async () => {
      // Reproduces "Cannot read properties of undefined (reading 'startsWith')"
      const result = await agentModeService.createHtmlTemplate(
        undefined as any,
        undefined,
        'test_template',
        'Test Subject',
        'Build a newsletter',
        'test-user-123',
        'test-session-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('html_source is required');
      expect(result.error).not.toContain('startsWith');
      // Must fail validation before invoking the LLM
      expect(mockGenerateHTML).not.toHaveBeenCalled();
    });

    it('should return a clean error when html_source is an empty string', async () => {
      const result = await agentModeService.createHtmlTemplate(
        '   ',
        undefined,
        'test_template',
        'Test Subject',
        '',
        'test-user-123',
        'test-session-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('html_source is required');
      expect(mockGenerateHTML).not.toHaveBeenCalled();
    });

    it('should handle LLM generation errors', async () => {
      // Setup mocks
      mockGenerateHTML.mockResolvedValue(''); // Empty response
      mockGetSetting.mockResolvedValue(null);

      // Execute
      const result = await agentModeService.createHtmlTemplate(
        mockInputHtml,
        undefined,
        'test_template',
        'Test Subject',
        '',
        'test-user-123',
        'test-session-123'
      );

      // Verify
      expect(result.success).toBe(false);
      expect(result.error).toContain('did not generate HTML content');
    });

    it('should correctly extract array variables with suffixes', async () => {
      const htmlWithArrayVars = `<html>
        <body>
          <p>{{user_name}}</p>
          <ul>
            <li>{{features_n}}: {{features_n_title}} - {{features_n_description}}</li>
          </ul>
        </body>
      </html>`;

      // Setup mocks
      mockGenerateHTML.mockResolvedValue(htmlWithArrayVars);
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      // Execute
      const result = await agentModeService.createHtmlTemplate(
        mockInputHtml,
        undefined,
        'test_template',
        'Test {{company_name}}',
        '',
        'test-user-123',
        'test-session-123'
      );

      // Verify
      expect(result.success).toBe(true);
      expect(result.variables).toContain('user_name');
      expect(result.variables).toContain('company_name');
      expect(result.arrayVariables).toEqual(
        expect.arrayContaining(['features_n', 'features_n_title', 'features_n_description'])
      );
    });



    it('should never touch public keys when saving', async () => {
      mockGenerateHTML.mockResolvedValue(mockEnhancedHtml);
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      await agentModeService.createHtmlTemplate(
        mockInputHtml,
        undefined,
        'welcome_email',
        'Welcome!',
        '',
        'test-user-123',
        'test-session-123'
      );

      const calledKeys = mockSetSetting.mock.calls.map((c: any[]) => c[0]);
      expect(calledKeys).not.toContain('templates_public');
      expect(calledKeys).not.toContain('email_templates_public');
    });

    it('should add template to existing templates list', async () => {
      // Setup mocks - existing templates
      const existingTemplates = [
        {
          template_name: 'newsletter',
          subject: 'Monthly Newsletter',
          html_content: '<html>Newsletter</html>',
          variables: [],
          arrayVariables: [],
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z'
        }
      ];

      mockGetSetting.mockResolvedValue({
        settingValue: JSON.stringify(existingTemplates)
      });
      mockGenerateHTML.mockResolvedValue(mockEnhancedHtml);
      mockSetSetting.mockResolvedValue(undefined);

      // Execute
      const result = await agentModeService.createHtmlTemplate(
        mockInputHtml,
        undefined,
        'welcome_email',
        'Welcome!',
        '',
        'test-user-123',
        'test-session-123'
      );

      // Verify
      expect(result.success).toBe(true);

      // Verify both templates exist
      const savedData = JSON.parse(mockSetSetting.mock.calls[0][1]);
      expect(savedData).toHaveLength(2);
      expect(savedData[0].template_name).toBe('newsletter');
      expect(savedData[1].template_name).toBe('welcome_email');
    });
  });

  describe('createHtmlTemplate - large document path (>16K, fidelity-preserving)', () => {
    // A large base64 blob pushes the doc well past the LLM-rewrite threshold and
    // simulates the Aquila newsletter's embedded images. The model must NOT see
    // this payload, and the stored template must keep it byte-for-byte.
    const bigBase64 = 'A'.repeat(60000);
    const buildBigHtml = (body: string) => `<!DOCTYPE html>
<html><head><style>
@page { size: 8.5in 11in; margin: 0; }
@media print { .page { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
.page { width: 8.5in; background: #3C1B78; }
.mast { color: #FF6E6D; }
</style></head>
<body>
  <div class="page">
    <img src="data:image/png;base64,${bigBase64}" alt="logo">
    ${body}
  </div>
</body></html>`;

    it('stores large HTML verbatim (base64 + print CSS preserved), never calling generateHTML', async () => {
      const inputHtml = buildBigHtml('<h1 class="mast">Aquila Monthly</h1><p>Hello FirstName</p>');
      mockGenerateJsonRobust.mockResolvedValue({
        variables: [{ name: 'first_name', anchor: 'FirstName', isArray: false }]
      });
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      const result = await agentModeService.createHtmlTemplate(
        inputHtml,
        undefined,
        'Aquila Newsletter',
        'Aquila {{month}}',
        'Parameterize the recipient name',
        'test-user-123',
        'test-session-123'
      );

      expect(result.success).toBe(true);
      // Large path must bypass the lossy full-rewrite call entirely.
      expect(mockGenerateHTML).not.toHaveBeenCalled();
      expect(mockGenerateJsonRobust).toHaveBeenCalled();

      const stored = JSON.parse(mockSetSetting.mock.calls[0][1])[0];
      // Fidelity: base64 image, print CSS and brand colors survive untouched.
      expect(stored.html_content).toContain(`data:image/png;base64,${bigBase64}`);
      expect(stored.html_content).toContain('@page');
      expect(stored.html_content).toContain('@media print');
      expect(stored.html_content).toContain('print-color-adjust');
      expect(stored.html_content).toContain('#3C1B78');
      expect(stored.html_content).toContain('#FF6E6D');
      // The detected variable was applied at its anchor.
      expect(stored.html_content).toContain('{{first_name}}');
      expect(stored.html_content).not.toContain('Hello FirstName');
      expect(result.variables).toContain('first_name');
    });

    it('strips base64 payloads from the prompt sent to the model', async () => {
      const inputHtml = buildBigHtml('<p>Hello FirstName</p>');
      mockGenerateJsonRobust.mockResolvedValue({ variables: [] });
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      await agentModeService.createHtmlTemplate(
        inputHtml, undefined, 'Aquila Newsletter', 'Subject', '', 'test-user-123', 'test-session-123'
      );

      const userPromptSent = mockGenerateJsonRobust.mock.calls[0][1] as string;
      // The model must never receive the raw base64 blob (token cost + corruption risk).
      expect(userPromptSent).not.toContain(bigBase64);
    });

    it('skips suggestions whose anchor is not found verbatim (no corruption)', async () => {
      const inputHtml = buildBigHtml('<p>Hello FirstName</p>');
      mockGenerateJsonRobust.mockResolvedValue({
        variables: [{ name: 'ghost', anchor: 'TextThatDoesNotExist', isArray: false }]
      });
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      const result = await agentModeService.createHtmlTemplate(
        inputHtml, undefined, 'Aquila Newsletter', 'Subject', '', 'test-user-123', 'test-session-123'
      );

      expect(result.success).toBe(true);
      const stored = JSON.parse(mockSetSetting.mock.calls[0][1])[0];
      // Unmatched anchor must not alter the document.
      expect(stored.html_content).not.toContain('{{ghost}}');
      expect(stored.html_content).toContain('Hello FirstName');
    });

    it('stores verbatim when the model returns no usable variables', async () => {
      const inputHtml = buildBigHtml('<p>Static content only</p>');
      mockGenerateJsonRobust.mockResolvedValue({ variables: [] });
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      const result = await agentModeService.createHtmlTemplate(
        inputHtml, undefined, 'Aquila Newsletter', 'Subject', '', 'test-user-123', 'test-session-123'
      );

      expect(result.success).toBe(true);
      const stored = JSON.parse(mockSetSetting.mock.calls[0][1])[0];
      expect(stored.html_content).toContain(`data:image/png;base64,${bigBase64}`);
      expect(stored.html_content).toContain('Static content only');
    });

    it('still stores verbatim when the suggestion call throws', async () => {
      const inputHtml = buildBigHtml('<p>Static content only</p>');
      mockGenerateJsonRobust.mockRejectedValue(new Error('model timeout'));
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      const result = await agentModeService.createHtmlTemplate(
        inputHtml, undefined, 'Aquila Newsletter', 'Subject', '', 'test-user-123', 'test-session-123'
      );

      expect(result.success).toBe(true);
      const stored = JSON.parse(mockSetSetting.mock.calls[0][1])[0];
      expect(stored.html_content).toContain(`data:image/png;base64,${bigBase64}`);
    });

    it('replaces ALL body occurrences of a repeated value but never inside style/title/attributes', async () => {
      // "Aquila" appears in <title>, in a <style> rule, in an attribute, and
      // twice in body text. Only the two body occurrences must be parameterized.
      const inputHtml = `<!DOCTYPE html>
<html><head><title>Aquila</title><style>.brand::after{content:'Aquila'}</style></head>
<body>
  <div class="page" data-app="Aquila">
    <img src="data:image/png;base64,${bigBase64}" alt="Aquila logo">
    <h1>Aquila Monthly</h1>
    <p>Welcome to Aquila.</p>
  </div>
</body></html>`;
      mockGenerateJsonRobust.mockResolvedValue({
        variables: [{ name: 'brand', anchor: 'Aquila', isArray: false }]
      });
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      const result = await agentModeService.createHtmlTemplate(
        inputHtml, undefined, 'Aquila Newsletter', 'Subject', '', 'test-user-123', 'test-session-123'
      );

      expect(result.success).toBe(true);
      const stored = JSON.parse(mockSetSetting.mock.calls[0][1])[0].html_content as string;
      // Both body occurrences replaced.
      expect(stored).toContain('{{brand}} Monthly');
      expect(stored).toContain('Welcome to {{brand}}.');
      // Protected contexts untouched.
      expect(stored).toContain('<title>Aquila</title>');
      expect(stored).toContain("content:'Aquila'");
      expect(stored).toContain('data-app="Aquila"');
      expect(stored).toContain('alt="Aquila logo"');
    });

    it('rejects malformed variable names (keeps {{...}} well-formed)', async () => {
      const inputHtml = buildBigHtml('<p>Hello FirstName</p>');
      mockGenerateJsonRobust.mockResolvedValue({
        variables: [
          { name: 'first name', anchor: 'FirstName' },        // space — invalid
          { name: 'x}}<script>', anchor: 'FirstName' },        // injection — invalid
          { name: '', anchor: 'FirstName' }                    // empty — invalid
        ]
      });
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      const result = await agentModeService.createHtmlTemplate(
        inputHtml, undefined, 'Aquila Newsletter', 'Subject', '', 'test-user-123', 'test-session-123'
      );

      expect(result.success).toBe(true);
      const stored = JSON.parse(mockSetSetting.mock.calls[0][1])[0].html_content as string;
      expect(stored).toContain('Hello FirstName');     // unchanged
      expect(stored).not.toContain('{{first name}}');
      expect(stored).not.toContain('<script>');
    });

    it('does not parameterize a value that only appears inside an attribute', async () => {
      const inputHtml = buildBigHtml('<a href="https://example.com/promo">Click</a>');
      mockGenerateJsonRobust.mockResolvedValue({
        variables: [{ name: 'cta_url', anchor: 'https://example.com/promo' }]
      });
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      const result = await agentModeService.createHtmlTemplate(
        inputHtml, undefined, 'Aquila Newsletter', 'Subject', '', 'test-user-123', 'test-session-123'
      );

      expect(result.success).toBe(true);
      const stored = JSON.parse(mockSetSetting.mock.calls[0][1])[0].html_content as string;
      // Attribute value is a documented coverage limit — left literal, not corrupted.
      expect(stored).toContain('href="https://example.com/promo"');
      expect(stored).not.toContain('{{cta_url}}');
    });

    it('leaves the small-document path unchanged (uses generateHTML, not the var-map)', async () => {
      const smallHtml = '<!DOCTYPE html><html><body><h1>Hi</h1><p>Hello User</p></body></html>';
      mockGenerateHTML.mockResolvedValue('<!DOCTYPE html><html><body><h1>Hi</h1><p>Hello {{user_name}}</p></body></html>');
      mockGetSetting.mockResolvedValue(null);
      mockSetSetting.mockResolvedValue(undefined);

      const result = await agentModeService.createHtmlTemplate(
        smallHtml, undefined, 'small', 'Subject', '', 'test-user-123', 'test-session-123'
      );

      expect(result.success).toBe(true);
      expect(mockGenerateHTML).toHaveBeenCalled();
      expect(mockGenerateJsonRobust).not.toHaveBeenCalled();
    });
  });
});
