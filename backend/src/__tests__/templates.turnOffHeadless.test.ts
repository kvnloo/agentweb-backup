import { AgentModeService } from '../services/agentModeService';
import { taskTemplateDb, taskDb } from '../services/db';

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
const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;

describe('Templates - turnOffHeadless Copy Tests', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('createTaskFromTemplate with turnOffHeadless', () => {
    it('should copy turnOffHeadless=true from template', async () => {
      const mockTemplate = {
        templateId: 'test-template',
        userId: 'user123',
        name: 'Test Template',
        description: 'Test description',
        prompt: 'Test prompt with [param1]',
        parameters: ['param1'],
        nameParameter: null,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        published: true,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        category: 'Test',
        selectedLLMs: [],
        useSharedBrowser: false,
        turnOffHeadless: true, // Template has turnOffHeadless=true
        isAgenticDevMode: false
      };

      mockTaskTemplateDb.getTemplateById.mockResolvedValue(mockTemplate as any);
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);

      await (agentModeService as any).createTaskFromTemplate(
        'test-template',
        { param1: 'value1' },
        'user123',
        'session123',
        false,
        [],
        true
      );

      expect(mockTaskDb.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          turnOffHeadless: true // Should be copied from template
        })
      );
    });

    it('should copy turnOffHeadless=false from template', async () => {
      const mockTemplate = {
        templateId: 'test-template',
        userId: 'user123',
        name: 'Test Template',
        description: 'Test description',
        prompt: 'Test prompt with [param1]',
        parameters: ['param1'],
        nameParameter: null,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        published: true,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        category: 'Test',
        selectedLLMs: [],
        useSharedBrowser: false,
        turnOffHeadless: false, // Template has turnOffHeadless=false
        isAgenticDevMode: false
      };

      mockTaskTemplateDb.getTemplateById.mockResolvedValue(mockTemplate as any);
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);

      await (agentModeService as any).createTaskFromTemplate(
        'test-template',
        { param1: 'value1' },
        'user123',
        'session123',
        false,
        [],
        true
      );

      expect(mockTaskDb.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          turnOffHeadless: false // Should be copied from template (false, not defaulted to true)
        })
      );
    });

    it('should default turnOffHeadless to true when template has undefined', async () => {
      const mockTemplate = {
        templateId: 'test-template',
        userId: 'user123',
        name: 'Test Template',
        description: 'Test description',
        prompt: 'Test prompt with [param1]',
        parameters: ['param1'],
        nameParameter: null,
        isInteractive: false,
        isDeepResearch: false,
        isComplexTask: false,
        published: true,
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        category: 'Test',
        selectedLLMs: [],
        useSharedBrowser: false,
        // turnOffHeadless is undefined
        isAgenticDevMode: false
      };

      mockTaskTemplateDb.getTemplateById.mockResolvedValue(mockTemplate as any);
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);

      await (agentModeService as any).createTaskFromTemplate(
        'test-template',
        { param1: 'value1' },
        'user123',
        'session123',
        false,
        [],
        true
      );

      expect(mockTaskDb.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          turnOffHeadless: true // Should default to true when undefined
        })
      );
    });
  });
});

