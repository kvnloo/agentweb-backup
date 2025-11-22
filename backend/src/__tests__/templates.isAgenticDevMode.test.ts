import { taskTemplateDb, taskDb, userDb } from '../services/db';
import { createTemplate, updateTemplate } from '../controllers/templates';

// Mock dependencies
jest.mock('../services/db');
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn().mockReturnValue({ promise: jest.fn() }),
      put: jest.fn().mockReturnValue({ promise: jest.fn() }),
      query: jest.fn().mockReturnValue({ promise: jest.fn() }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn() }),
      update: jest.fn().mockReturnValue({ promise: jest.fn() }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn() })
    }))
  },
  S3: jest.fn().mockImplementation(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn() }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn() }),
    putObject: jest.fn().mockReturnValue({ promise: jest.fn() }),
    deleteObject: jest.fn().mockReturnValue({ promise: jest.fn() })
  })),
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn() })
  })),
  config: {
    update: jest.fn()
  }
}));

const mockTaskTemplateDb = taskTemplateDb as jest.Mocked<typeof taskTemplateDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

describe('Templates - isAgenticDevMode Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (mockUserDb.getUserById as jest.Mock).mockResolvedValue({
      userId: 'user123',
      email: 'test@example.com',
      isAdmin: true
    });
  });

  describe('createTemplate with isAgenticDevMode', () => {
    it('should create template with isAgenticDevMode=true', async () => {
      const mockCreatedTemplate = {
        templateId: 'test-template-123',
        userId: 'user123',
        name: 'Test Template',
        description: 'Test description',
        prompt: 'Test prompt',
        parameters: [],
        nameParameter: null,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        published: false,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        isAgenticDevMode: true
      };

      mockTaskTemplateDb.createTemplate.mockResolvedValue(mockCreatedTemplate as any);

      const req = {
        user: { userId: 'user123', email: 'test@example.com' },
        body: {
          name: 'Test Template',
          description: 'Test description',
          prompt: 'Test prompt',
          isAgenticDevMode: true
        }
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      await createTemplate(req, res);

      expect(mockTaskTemplateDb.createTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          isAgenticDevMode: true
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('should create template with isAgenticDevMode=false', async () => {
      const mockCreatedTemplate = {
        templateId: 'test-template-123',
        userId: 'user123',
        name: 'Test Template',
        description: 'Test description',
        prompt: 'Test prompt',
        parameters: [],
        nameParameter: null,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        published: false,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        isAgenticDevMode: false
      };

      mockTaskTemplateDb.createTemplate.mockResolvedValue(mockCreatedTemplate as any);

      const req = {
        user: { userId: 'user123', email: 'test@example.com' },
        body: {
          name: 'Test Template',
          description: 'Test description',
          prompt: 'Test prompt',
          isAgenticDevMode: false
        }
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      await createTemplate(req, res);

      expect(mockTaskTemplateDb.createTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          isAgenticDevMode: false
        })
      );
    });

    it('should default isAgenticDevMode to false when not provided', async () => {
      const mockCreatedTemplate = {
        templateId: 'test-template-123',
        userId: 'user123',
        name: 'Test Template',
        description: 'Test description',
        prompt: 'Test prompt',
        parameters: [],
        nameParameter: null,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        published: false,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        isAgenticDevMode: false
      };

      mockTaskTemplateDb.createTemplate.mockResolvedValue(mockCreatedTemplate as any);

      const req = {
        user: { userId: 'user123', email: 'test@example.com' },
        body: {
          name: 'Test Template',
          description: 'Test description',
          prompt: 'Test prompt'
          // isAgenticDevMode not provided
        }
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      await createTemplate(req, res);

      expect(mockTaskTemplateDb.createTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          isAgenticDevMode: false
        })
      );
    });
  });

  describe('updateTemplate with isAgenticDevMode', () => {
    it('should update template with isAgenticDevMode=true', async () => {
      const existingTemplate = {
        templateId: 'test-template-123',
        userId: 'user123',
        name: 'Test Template',
        description: 'Test description',
        prompt: 'Test prompt',
        parameters: [],
        nameParameter: null,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        published: false,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        isAgenticDevMode: false
      };

      const updatedTemplate = {
        ...existingTemplate,
        isAgenticDevMode: true,
        updatedAt: '2023-01-02T00:00:00Z'
      };

      mockTaskTemplateDb.getTemplateById.mockResolvedValue(existingTemplate as any);
      mockTaskTemplateDb.updateTemplate.mockResolvedValue(updatedTemplate as any);

      const req = {
        user: { userId: 'user123', email: 'test@example.com' },
        params: { id: 'test-template-123' },
        body: {
          isAgenticDevMode: true
        }
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      await updateTemplate(req, res);

      expect(mockTaskTemplateDb.updateTemplate).toHaveBeenCalledWith(
        'test-template-123',
        expect.objectContaining({
          isAgenticDevMode: true
        })
      );
      expect(res.json).toHaveBeenCalledWith(updatedTemplate);
    });

    it('should update template with isAgenticDevMode=false', async () => {
      const existingTemplate = {
        templateId: 'test-template-123',
        userId: 'user123',
        name: 'Test Template',
        description: 'Test description',
        prompt: 'Test prompt',
        parameters: [],
        nameParameter: null,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        published: false,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        isAgenticDevMode: true
      };

      const updatedTemplate = {
        ...existingTemplate,
        isAgenticDevMode: false,
        updatedAt: '2023-01-02T00:00:00Z'
      };

      mockTaskTemplateDb.getTemplateById.mockResolvedValue(existingTemplate as any);
      mockTaskTemplateDb.updateTemplate.mockResolvedValue(updatedTemplate as any);

      const req = {
        user: { userId: 'user123', email: 'test@example.com' },
        params: { id: 'test-template-123' },
        body: {
          isAgenticDevMode: false
        }
      } as any;

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      } as any;

      await updateTemplate(req, res);

      expect(mockTaskTemplateDb.updateTemplate).toHaveBeenCalledWith(
        'test-template-123',
        expect.objectContaining({
          isAgenticDevMode: false
        })
      );
    });
  });
});

