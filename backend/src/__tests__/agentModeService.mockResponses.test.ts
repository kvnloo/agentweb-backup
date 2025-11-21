import { AgentModeService } from '../services/agentModeService';

// Mock the dependencies
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      get: jest.fn(),
      put: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      scan: jest.fn(),
      query: jest.fn(),
    })),
  },
  SecretsManager: jest.fn(),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('AgentModeService - Mock Responses', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('Mock tool responses', () => {
    it('should return correct mock response for create_revision', async () => {
      const mockResponse = (agentModeService as any).getMockToolResult('create_revision', {
        task_id: 'test-task-123',
        execution_id: 'test-exec-456',
        target_result_name: 'test-result'
      });

      expect(mockResponse).toEqual({
        success: true,
        message: 'Mock revision created successfully',
        taskId: expect.stringMatching(/^mock-task-\d+$/),
        executionId: expect.stringMatching(/^mock-execution-\d+$/),
        status: 'pending',
        assetType: 'report',
        targetFile: 'mock-report.html'
      });

      // Verify the fields required for TaskExecutionStatus component
      expect(mockResponse.taskId).toBeDefined();
      expect(mockResponse.executionId).toBeDefined();
      expect(mockResponse.status).toBe('pending');
    });

    it('should return correct mock response for create_task_from_template', async () => {
      const mockResponse = (agentModeService as any).getMockToolResult('create_task_from_template', {
        template_id: 'test-template'
      });

      expect(mockResponse).toEqual({
        success: true,
        taskId: expect.stringMatching(/^mock-task-\d+$/),
        executionId: expect.stringMatching(/^mock-execution-\d+$/),
        message: 'Mock task created from template test-template',
        status: 'pending'
      });

      // Verify the fields required for TaskExecutionStatus component
      expect(mockResponse.taskId).toBeDefined();
      expect(mockResponse.executionId).toBeDefined();
      expect(mockResponse.status).toBe('pending');
    });

    it('should return correct mock response for create_task_from_prompt', async () => {
      const mockResponse = (agentModeService as any).getMockToolResult('create_task_from_prompt', {
        task_name: 'Test Task'
      });

      expect(mockResponse).toEqual({
        success: true,
        taskId: expect.stringMatching(/^mock-task-\d+$/),
        executionId: expect.stringMatching(/^mock-execution-\d+$/),
        message: 'Mock task created: Test Task',
        status: 'pending'
      });

      // Verify the fields required for TaskExecutionStatus component
      expect(mockResponse.taskId).toBeDefined();
      expect(mockResponse.executionId).toBeDefined();
      expect(mockResponse.status).toBe('pending');
    });

    it('should return correct mock response for create_image_task_from_prompt', async () => {
      const mockResponse = (agentModeService as any).getMockToolResult('create_image_task_from_prompt', {
        task_name: 'Test Image Task'
      });

      expect(mockResponse).toEqual({
        success: true,
        taskId: expect.stringMatching(/^mock-image-task-\d+$/),
        executionId: expect.stringMatching(/^mock-execution-\d+$/),
        message: 'Mock image task created: Test Image Task',
        status: 'pending'
      });

      // Verify the fields required for TaskExecutionStatus component
      expect(mockResponse.taskId).toBeDefined();
      expect(mockResponse.executionId).toBeDefined();
      expect(mockResponse.status).toBe('pending');
    });

    it('should return correct mock response for non-task-creation tools', async () => {
      const mockResponse = (agentModeService as any).getMockToolResult('generate_image', {
        prompt: 'test prompt'
      });

      expect(mockResponse).toEqual({
        success: true,
        imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        message: 'Mock image "undefined" generated successfully!',
        filename: undefined
      });

      // Non-task-creation tools should not have taskId/executionId
      expect(mockResponse.taskId).toBeUndefined();
      expect(mockResponse.executionId).toBeUndefined();
    });

    it('should return correct mock response for read_market_strategy with buyerPersonas field', async () => {
      const mockResponse = (agentModeService as any).getMockToolResult('read_market_strategy', {});

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.exists).toBe(true);
      expect(mockResponse.icp).toBeDefined();
      expect(Array.isArray(mockResponse.icp)).toBe(true);
      expect(mockResponse.icp.length).toBeGreaterThan(0);
      
      // Verify buyerPersonas field exists as an array
      expect(mockResponse.icp[0]).toHaveProperty('buyerPersonas');
      expect(Array.isArray(mockResponse.icp[0].buyerPersonas)).toBe(true);
      expect(mockResponse.icp[0].buyerPersonas.length).toBeGreaterThan(0);
    });

    it('should return correct mock response for create_social_media_posts', async () => {
      const mockResponse = (agentModeService as any).getMockToolResult('create_social_media_posts', {
        posts: [
          { type: 'linkedin', content: 'Test post 1' },
          { type: 'x/twitter', content: 'Test post 2' }
        ]
      });

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.message).toBe('Successfully created 2 social media post(s)');
      expect(mockResponse.htmlUrl).toContain('mock-social-media-posts-');
      expect(mockResponse.htmlUrl).toContain('.html');
      expect(mockResponse.postsCount).toBe(2);
    });
  });

  describe('Tool response validation', () => {
    it('should ensure all task creation tools return required fields', async () => {
      const taskCreationTools = [
        'create_revision',
        'create_task_from_template', 
        'create_task_from_prompt',
        'create_image_task_from_prompt'
      ];

      for (const toolName of taskCreationTools) {
        const mockResponse = (agentModeService as any).getMockToolResult(toolName, {});
        
        expect(mockResponse).toHaveProperty('taskId');
        expect(mockResponse).toHaveProperty('executionId');
        expect(mockResponse).toHaveProperty('status');
        expect(mockResponse.status).toBe('pending');
        expect(typeof mockResponse.taskId).toBe('string');
        expect(typeof mockResponse.executionId).toBe('string');
      }
    });
  });
});
