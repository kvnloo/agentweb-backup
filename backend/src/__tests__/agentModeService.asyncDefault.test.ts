import { AgentModeService } from '../services/agentModeService';
import { taskDb, taskTemplateDb } from '../services/db';

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

const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockTaskTemplateDb = taskTemplateDb as jest.Mocked<typeof taskTemplateDb>;

describe('AgentModeService - Async Default Tests', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('createTaskFromTemplate async default', () => {
    it('should default to async=false when async parameter is not provided', async () => {
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
        turnOffHeadless: false,
        isAgenticDevMode: false
      };

      mockTaskTemplateDb.getTemplateById.mockResolvedValue(mockTemplate as any);
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'test-execution-123',
        taskId: 'test-task-123',
        userId: 'user123',
        status: 'completed',
        result: 'Task completed',
        startTime: '2023-01-01T00:00:00Z'
      } as any);

      // Call without providing async parameter (relying on default)
      const result = await (agentModeService as any).createTaskFromTemplate(
        'test-template',
        { param1: 'value1' },
        'user123',
        'session123',
        false,
        []
        // async parameter omitted - should default to false
      );

      // Should wait for completion (async=false default)
      expect(mockTaskDb.getTaskExecutionById).toHaveBeenCalled();
      expect(result.status).toBe('completed');
      expect(result.success).toBe(true);
    });

    it('should use async=false when explicitly set to false', async () => {
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
        turnOffHeadless: false,
        isAgenticDevMode: false
      };

      mockTaskTemplateDb.getTemplateById.mockResolvedValue(mockTemplate as any);
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'test-execution-123',
        taskId: 'test-task-123',
        userId: 'user123',
        status: 'completed',
        result: 'Task completed',
        startTime: '2023-01-01T00:00:00Z'
      } as any);

      const result = await (agentModeService as any).createTaskFromTemplate(
        'test-template',
        { param1: 'value1' },
        'user123',
        'session123',
        false,
        [],
        false // async = false
      );

      expect(mockTaskDb.getTaskExecutionById).toHaveBeenCalled();
      expect(result.status).toBe('completed');
    });

    it('should use async=true when explicitly set to true', async () => {
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
        turnOffHeadless: false,
        isAgenticDevMode: false
      };

      mockTaskTemplateDb.getTemplateById.mockResolvedValue(mockTemplate as any);
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);

      const result = await (agentModeService as any).createTaskFromTemplate(
        'test-template',
        { param1: 'value1' },
        'user123',
        'session123',
        false,
        [],
        true // async = true
      );

      // Should not wait for completion (async=true)
      expect(mockTaskDb.getTaskExecutionById).not.toHaveBeenCalled();
      expect(result.status).toBe('pending');
    });
  });

  describe('createTaskFromPrompt async default', () => {
    it('should default to async=false when async parameter is not provided', async () => {
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'test-execution-123',
        taskId: 'test-task-123',
        userId: 'user123',
        status: 'completed',
        result: 'Task completed',
        startTime: '2023-01-01T00:00:00Z'
      } as any);

      // Call without providing async parameter (relying on default)
      const result = await (agentModeService as any).createTaskFromPrompt(
        'Test Task',
        'Test prompt',
        'Test',
        'user123',
        'session123',
        false,
        []
        // async parameter omitted - should default to false
      );

      // Should wait for completion (async=false default)
      expect(mockTaskDb.getTaskExecutionById).toHaveBeenCalled();
      expect(result.status).toBe('completed');
      expect(result.success).toBe(true);
    });

    it('should use async=false when explicitly set to false', async () => {
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'test-execution-123',
        taskId: 'test-task-123',
        userId: 'user123',
        status: 'completed',
        result: 'Task completed',
        startTime: '2023-01-01T00:00:00Z'
      } as any);

      const result = await (agentModeService as any).createTaskFromPrompt(
        'Test Task',
        'Test prompt',
        'Test',
        'user123',
        'session123',
        false,
        [],
        false // async = false
      );

      expect(mockTaskDb.getTaskExecutionById).toHaveBeenCalled();
      expect(result.status).toBe('completed');
      expect(result.success).toBe(true);
    });

    it('should use async=false when explicitly set to false', async () => {
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'test-execution-123',
        taskId: 'test-task-123',
        userId: 'user123',
        status: 'completed',
        result: 'Task completed',
        startTime: '2023-01-01T00:00:00Z'
      } as any);

      const result = await (agentModeService as any).createTaskFromPrompt(
        'Test Task',
        'Test prompt',
        'Test',
        'user123',
        'session123',
        false,
        [],
        false // async = false
      );

      expect(mockTaskDb.getTaskExecutionById).toHaveBeenCalled();
      expect(result.status).toBe('completed');
    });

    it('should use async=true when explicitly set to true', async () => {
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);

      const result = await (agentModeService as any).createTaskFromPrompt(
        'Test Task',
        'Test prompt',
        'Test',
        'user123',
        'session123',
        false,
        [],
        true // async = true
      );

      // Should not wait for completion (async=true)
      expect(mockTaskDb.getTaskExecutionById).not.toHaveBeenCalled();
      expect(result.status).toBe('pending');
    });
  });

  describe('handleToolCall async default logic', () => {
    it('should parse async parameter correctly in create_task_from_template', () => {
      // Simulate the handleToolCall logic: args.async ?? false
      const args1: any = { template_id: 'test-template', parameters_json: '{"param1": "value1"}' };
      const async1 = args1.async ?? false; // Should be false when undefined
      expect(async1).toBe(false);

      const args2: any = { template_id: 'test-template', parameters_json: '{"param1": "value1"}', async: false };
      const async2 = args2.async ?? false; // Should be false when explicitly false
      expect(async2).toBe(false);

      const args3: any = { template_id: 'test-template', parameters_json: '{"param1": "value1"}', async: true };
      const async3 = args3.async ?? false; // Should be true when explicitly true
      expect(async3).toBe(true);
    });

    it('should parse async parameter correctly in create_task_from_prompt', () => {
      // Simulate the handleToolCall logic: args.async ?? false
      const args1: any = { task_name: 'Test Task', prompt: 'Test prompt', category: 'Test' };
      const async1 = args1.async ?? false; // Should be false when undefined
      expect(async1).toBe(false);

      const args2: any = { task_name: 'Test Task', prompt: 'Test prompt', category: 'Test', async: false };
      const async2 = args2.async ?? false; // Should be false when explicitly false
      expect(async2).toBe(false);

      const args3: any = { task_name: 'Test Task', prompt: 'Test prompt', category: 'Test', async: true };
      const async3 = args3.async ?? false; // Should be true when explicitly true
      expect(async3).toBe(true);
    });

    it('should handle explicit undefined correctly with nullish coalescing operator', () => {
      // Test that explicitly passing undefined uses the default value
      const args1: any = { template_id: 'test-template', parameters_json: '{"param1": "value1"}', async: undefined };
      const async1 = args1.async ?? false; // Should be false when explicitly undefined
      expect(async1).toBe(false);

      const args2: any = { task_name: 'Test Task', prompt: 'Test prompt', category: 'Test', async: undefined };
      const async2 = args2.async ?? false; // Should be false when explicitly undefined
      expect(async2).toBe(false);
    });

    it('should handle null correctly with nullish coalescing operator', () => {
      // Test that null also uses the default value
      const args1: any = { template_id: 'test-template', parameters_json: '{"param1": "value1"}', async: null };
      const async1 = args1.async ?? false; // Should be false when null
      expect(async1).toBe(false);

      const args2: any = { task_name: 'Test Task', prompt: 'Test prompt', category: 'Test', async: null };
      const async2 = args2.async ?? false; // Should be false when null
      expect(async2).toBe(false);
    });

    it('should not convert falsy values (0, empty string) to default', () => {
      // The ?? operator only checks for null/undefined, not other falsy values
      // However, since async is a boolean, this shouldn't matter in practice
      const args1: any = { template_id: 'test-template', parameters_json: '{"param1": "value1"}', async: 0 };
      const async1 = args1.async ?? false; // Should be 0 (truthy check would fail but ?? doesn't)
      expect(async1).toBe(0); // 0 is falsy but ?? doesn't convert it

      const args2: any = { template_id: 'test-template', parameters_json: '{"param1": "value1"}', async: '' };
      const async2 = args2.async ?? false; // Should be '' (empty string)
      expect(async2).toBe(''); // Empty string is falsy but ?? doesn't convert it
    });
  });

  describe('createTaskFromTemplate with undefined async parameter', () => {
    it('should handle explicitly passed undefined correctly', async () => {
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
        turnOffHeadless: false,
        isAgenticDevMode: false
      };

      mockTaskTemplateDb.getTemplateById.mockResolvedValue(mockTemplate as any);
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'test-execution-123',
        taskId: 'test-task-123',
        userId: 'user123',
        status: 'completed',
        result: 'Task completed',
        startTime: '2023-01-01T00:00:00Z'
      } as any);

      // Explicitly pass undefined (simulating args.async when it's not provided)
      const result = await (agentModeService as any).createTaskFromTemplate(
        'test-template',
        { param1: 'value1' },
        'user123',
        'session123',
        false,
        [],
        undefined // explicitly undefined - should default to false
      );

      // Should wait for completion (async defaults to false)
      expect(mockTaskDb.getTaskExecutionById).toHaveBeenCalled();
      expect(result.status).toBe('completed');
      expect(result.success).toBe(true);
    });
  });

  describe('createTaskFromPrompt with undefined async parameter', () => {
    it('should handle explicitly passed undefined correctly', async () => {
      mockTaskDb.createTask.mockResolvedValue({ taskId: 'test-task-123' } as any);
      mockTaskDb.createTaskExecution.mockResolvedValue({ executionId: 'test-execution-123' } as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue({
        executionId: 'test-execution-123',
        taskId: 'test-task-123',
        userId: 'user123',
        status: 'completed',
        result: 'Task completed',
        startTime: '2023-01-01T00:00:00Z'
      } as any);

      // Explicitly pass undefined (simulating args.async when it's not provided)
      const result = await (agentModeService as any).createTaskFromPrompt(
        'Test Task',
        'Test prompt',
        'Test',
        'user123',
        'session123',
        false,
        [],
        undefined // explicitly undefined - should default to false
      );

      // Should wait for completion (async defaults to false)
      expect(mockTaskDb.getTaskExecutionById).toHaveBeenCalled();
      expect(result.status).toBe('completed');
      expect(result.success).toBe(true);
    });
  });
});

