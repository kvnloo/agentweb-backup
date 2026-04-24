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

describe('AgentModeService - Public HTML Templates', () => {
  let agentModeService: AgentModeService;

  const userTemplate = {
    template_id: 'user-template-id',
    template_name: 'user-template',
    html_content: '<html><body><h1>{{title}}</h1></body></html>',
    subject: 'User Template: {{title}}',
    variables: ['title'],
    arrayVariables: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  };

  const publicTemplate = {
    template_id: 'public-template-id',
    template_name: 'public-template',
    html_content: '<html><body><h1>{{heading}}</h1></body></html>',
    subject: 'Public Template: {{heading}}',
    variables: ['heading'],
    arrayVariables: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  };

  const overlappingTemplate = {
    template_id: 'shared-id-public',
    template_name: 'shared-name',
    html_content: '<html><body><p>Public version</p></body></html>',
    subject: 'Public Shared',
    variables: [],
    arrayVariables: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  };

  const userOverlappingTemplate = {
    template_id: 'shared-id-user',
    template_name: 'shared-name',
    html_content: '<html><body><p>User version</p></body></html>',
    subject: 'User Shared',
    variables: [],
    arrayVariables: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const { createHash } = require('crypto');
    createHash.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue('test-hash-123')
    });
    agentModeService = new AgentModeService();
  });

  describe('listHtmlTemplates', () => {
    it('should return empty when neither user nor public templates exist', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      const result = await (agentModeService as any).listHtmlTemplates('user123');

      expect(result.success).toBe(true);
      expect(result.email_templates).toEqual([]);
    });

    it('should NOT deduplicate templates with the same name from both stores', async () => {
      (settingsService.getSetting as jest.Mock).mockImplementation((key: string) => {
        if (key === 'email_templates_user123' || key === 'templates_user123') {
          return { settingValue: JSON.stringify([userOverlappingTemplate]) };
        }
        if (key === 'email_templates_public' || key === 'templates_public') {
          return { settingValue: JSON.stringify([overlappingTemplate]) };
        }
        return null;
      });

      const result = await (agentModeService as any).listHtmlTemplates('user123');

      expect(result.success).toBe(true);
      const sharedTemplates = result.email_templates.filter(
        (t: any) => t.template_name === 'shared-name'
      );
      expect(sharedTemplates).toHaveLength(2);
      expect(sharedTemplates.some((t: any) => t.isPublic)).toBeTruthy();
      expect(sharedTemplates.some((t: any) => !t.isPublic)).toBeTruthy();
    });

    it('should return only public templates with isPublic=true when user has none', async () => {
      (settingsService.getSetting as jest.Mock).mockImplementation((key: string) => {
        if (key === 'templates_user123') {
          return null;
        }
        if (key === 'templates_public') {
          return { settingValue: JSON.stringify([publicTemplate]) };
        }
        return null;
      });

      const result = await (agentModeService as any).listHtmlTemplates('user123');

      expect(result.success).toBe(true);
      expect(result.email_templates).toHaveLength(1);
      expect(result.email_templates[0].template_name).toBe('public-template');
      expect(result.email_templates[0].isPublic).toBe(true);
    });

    it('should merge both stores with correct isPublic flags', async () => {
      (settingsService.getSetting as jest.Mock).mockImplementation((key: string) => {
        if (key === 'templates_user123') {
          return { settingValue: JSON.stringify([userTemplate]) };
        }
        if (key === 'templates_public') {
          return { settingValue: JSON.stringify([publicTemplate]) };
        }
        return null;
      });

      const result = await (agentModeService as any).listHtmlTemplates('user123');

      expect(result.success).toBe(true);
      expect(result.email_templates).toHaveLength(2);

      const userT = result.email_templates.find((t: any) => t.template_name === 'user-template');
      const publicT = result.email_templates.find((t: any) => t.template_name === 'public-template');

      expect(userT).toBeDefined();
      expect(userT.isPublic).toBeFalsy();
      expect(publicT).toBeDefined();
      expect(publicT.isPublic).toBe(true);
    });
  });

  describe('createHtmlFromTemplate', () => {
    it('should return error when template not found in either store', async () => {
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);

      const result = await (agentModeService as any).createHtmlFromTemplate(
        'gpt-4',
        'nonexistent-template-id',
        {},
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
    });

    it('should find template in public store when not in user store', async () => {
      (settingsService.getSetting as jest.Mock).mockImplementation((key: string) => {
        if (key === 'templates_user123') {
          return null;
        }
        if (key === 'templates_public') {
          return { settingValue: JSON.stringify([publicTemplate]) };
        }
        return null;
      });

      // Mock callLLM for substitution
      jest.spyOn(agentModeService as any, 'callLLM').mockResolvedValue({
        choices: [{
          message: {
            content: JSON.stringify({
              final_html: '<html><body><h1>Hello World</h1></body></html>',
              final_subject: 'Public Template: Hello World'
            })
          }
        }]
      });

      const result = await (agentModeService as any).createHtmlFromTemplate(
        'gpt-4',
        'public-template-id',
        { heading: 'Hello World' },
        {},
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.template_name).toBe('public-template');
    });
  });
});
