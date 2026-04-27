import { AgentModeService } from '../services/agentModeService';
import { settingsService } from '../services/settingsService';

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

// Mock settingsService
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn()
  }
}));

// Mock s3Utils
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/bucket/test-template.html'
  })
}));



describe('AgentModeService - createHtmlFromTemplate', () => {
  let agentModeService: AgentModeService;
  let mockS3: any;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Setup S3 mock
    const AWS = require('aws-sdk');
    mockS3 = new AWS.S3();

    // Setup crypto mock
    const { createHash } = require('crypto');
    const mockHash = {
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue('test-hash-123')
    };
    createHash.mockReturnValue(mockHash);

    // Create service instance
    agentModeService = new AgentModeService();
  });

  describe('createHtmlFromTemplate', () => {
    const mockTemplate = {
      template_id: 'test-template-id',
      template_name: 'test-template',
      html_content: '<html><body><h1>{{title}}</h1><p>{{content}}</p></body></html>',
      subject: 'Test Subject: {{title}}',
      variables: ['title', 'content'],
      arrayVariables: []
    };

    beforeEach(() => {
      // Mock the settingsService to return the template
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([mockTemplate])
      });

      // Mock callLLM to return a successful response
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              final_html: '<html><body><h1>Test Title</h1><p>Test Content</p></body></html>',
              final_subject: 'Test Subject: Test Title'
            })
          }
        }]
      });

      // Mock S3 upload
      mockS3.upload().promise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/bucket/test-template.html'
      });
    });

    it('should create HTML from template with valid parameters', async () => {

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.s3_url).toBe('https://s3.amazonaws.com/bucket/test-template.html');
      expect(result.final_subject).toBe('Test Subject: Test Title');
      expect(agentModeService.callLLM).toHaveBeenCalledWith(
        agentModeService.default_model,
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('You are a template engine')
          })
        ]),
        expect.objectContaining({
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      );

    });

    it('should handle array variables correctly', async () => {
      const templateWithArrays = {
        ...mockTemplate,
        arrayVariables: ['items'],
        html_content: '<html><body><ul>{{#items}}<li>{{item}}</li>{{/items}}</ul></body></html>'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithArrays])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        { items: [{ item: 'Item 1' }, { item: 'Item 2' }] },
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(agentModeService.callLLM).toHaveBeenCalled();
    });

    it('should validate that all required variables are provided', async () => {
      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title' }, // Missing 'content'
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required variables');
      expect(result.message).toContain('content');
    });

    it('should validate that no extra variables are provided', async () => {
      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content', extra: 'Extra' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Extra variables provided');
      expect(result.message).toContain('extra');
    });

    it('should validate array variables are arrays', async () => {
      const templateWithArrays = {
        ...mockTemplate,
        arrayVariables: ['items']
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithArrays])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        { items: 'not-an-array' }, // Should be array
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Array variable items must be an array');
    });

    it('should handle template not found', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([]) // Empty templates array
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'nonexistent-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Template \'nonexistent-template-id\' not found');
    });

    it('should handle LLM API errors', async () => {
      jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue(new Error('OpenAI API error'));

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to process template with LLM');
    });

    it('should handle invalid LLM response', async () => {
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [
          {
            message: {
              content: 'invalid-json-response'
            }
          }
        ]
      });


      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to parse LLM response');
    });

    it('should handle JSON wrapped in markdown code block (```json)', async () => {
      const wrappedJson = '```json\n' + JSON.stringify({
        final_html: '<html><body><h1>Test Title</h1><p>Test Content</p></body></html>',
        final_subject: 'Test Subject: Test Title'
      }) + '\n```';

      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: wrappedJson
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.s3_url).toBe('https://s3.amazonaws.com/bucket/test-template.html');
      expect(result.final_subject).toBe('Test Subject: Test Title');
    });

    it('should handle JSON wrapped in plain markdown code block (```)', async () => {
      const wrappedJson = '```\n' + JSON.stringify({
        final_html: '<html><body><h1>Test Title</h1><p>Test Content</p></body></html>',
        final_subject: 'Test Subject: Test Title'
      }) + '\n```';

      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: wrappedJson
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.s3_url).toBe('https://s3.amazonaws.com/bucket/test-template.html');
    });

    it('should fail when code block contains invalid JSON', async () => {
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: '```json\nnot valid json here\n```'
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to parse LLM response');
    });

    it('should handle missing final_html in LLM response', async () => {
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              final_subject: 'Test Subject: Test Title'
              // Missing final_html
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('LLM response missing final_html');
    });

    it('should handle S3 upload errors', async () => {
      const { uploadFileToS3 } = require('../utils/s3Utils');
      uploadFileToS3.mockResolvedValueOnce({
        success: false,
        error: 'S3 upload failed'
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to upload to S3');
    });

    it('should include proper metadata in S3 upload', async () => {
      const { uploadFileToS3 } = require('../utils/s3Utils');

      await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(uploadFileToS3).toHaveBeenCalledWith(
        expect.any(String), // finalHtml
        expect.stringMatching(/^html_.*\.html$/), // filename
        'user123', // userId
        'text/html' // contentType
      );
    });

    it('should handle undefined variable_values and array_variable_values', async () => {
      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        undefined,
        undefined,
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required variables');
    });

    it('should validate template structure', async () => {
      const invalidTemplate = {
        template_id: 'test-template-id',
        template_name: 'test-template',
        // Missing required fields
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([invalidTemplate])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid template structure');
    });

    it('should handle complex array variables', async () => {
      const templateWithComplexArrays = {
        ...mockTemplate,
        arrayVariables: ['items', 'categories'],
        html_content: '<html><body><ul>{{#items}}<li>{{name}} - {{price}}</li>{{/items}}</ul><div>{{#categories}}<span>{{cat}}</span>{{/categories}}</div></body></html>',
        subject: 'Test Subject: {{title}}'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithComplexArrays])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {
          items: [{ name: 'Item 1', price: '$10' }, { name: 'Item 2', price: '$20' }],
          categories: [{ cat: 'Electronics' }, { cat: 'Books' }]
        },
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(agentModeService.callLLM).toHaveBeenCalled();
    });

    it('should handle empty array variables and prompt for placeholder text', async () => {
      const templateWithEmptyArray = {
        ...mockTemplate,
        arrayVariables: ['features_n'],
        html_content: '<html><body><h1>{{title}}</h1><ul class="features-list">{{#features_n}}<li>{{features_1}}</li>{{/features_n}}</ul><p>{{content}}</p></body></html>',
        subject: 'Test Subject: {{title}}'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithEmptyArray])
      });

      // Mock LLM response with placeholder for empty array
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              final_html: '<html><body><h1>Test Title</h1><ul class="features-list"><li style="color: #888; font-style: italic;">No data available</li></ul><p>Test Content</p></body></html>',
              final_subject: 'Test Subject: Test Title'
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        { features_n: [] }, // Empty array
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);

      // Verify the prompt includes empty array handling instructions
      const callArgs = (agentModeService.callLLM as jest.Mock).mock.calls[0];
      expect(callArgs[1][0].content).toContain('EMPTY ARRAY VARIABLES');
      expect(callArgs[1][0].content).toContain('remove the array variables from the HTML structure');

      // Verify the array variable values are passed as empty
      expect(callArgs[1][0].content).toContain('"features_n": []');
    });

    it('should handle partial empty array variables', async () => {
      const templateWithMixedArrays = {
        ...mockTemplate,
        arrayVariables: ['features_n', 'links_n'],
        html_content: '<html><body><h1>{{title}}</h1><ul class="features">{{#features_n}}<li>{{features_1}}</li>{{/features_n}}</ul><ul class="links">{{#links_n}}<li>{{links_1}}</li>{{/links_n}}</ul></body></html>',
        subject: 'Test Subject: {{title}}'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithMixedArrays])
      });

      // Mock LLM response with one empty array handled
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              final_html: '<html><body><h1>Test Title</h1><ul class="features"><li>Feature 1</li><li>Feature 2</li></ul><ul class="links"><li style="color: #888;">None</li></ul></body></html>',
              final_subject: 'Test Subject: Test Title'
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {
          features_n: ['Feature 1', 'Feature 2'],
          links_n: [] // Empty array
        },
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);

      // Verify the prompt includes both populated and empty arrays
      const callArgs = (agentModeService.callLLM as jest.Mock).mock.calls[0];
      expect(callArgs[1][0].content).toContain('"features_n"');
      expect(callArgs[1][0].content).toContain('"links_n": []');
    });

    it('should require array variables even if empty', async () => {
      const templateWithArray = {
        ...mockTemplate,
        arrayVariables: ['features_n'],
        html_content: '<html><body><h1>{{title}}</h1><ul class="features">{{#features_n}}<li>{{features_1}}</li>{{/features_n}}</ul><p>{{content}}</p></body></html>',
        subject: 'Test Subject: {{title}}'
      };

      (settingsService.getSetting as jest.Mock).mockResolvedValue({
        settingValue: JSON.stringify([templateWithArray])
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        agentModeService.default_model,
        'test-template-id',
        { title: 'Test Title', content: 'Test Content' },
        {}, // Missing array variable entirely
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing required array variables');
      expect(result.message).toContain('features_n');
    });
  });
});
