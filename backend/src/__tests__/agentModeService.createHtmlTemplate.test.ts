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
    generateHTML: jest.fn()
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
});
