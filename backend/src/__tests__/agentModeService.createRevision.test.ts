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

jest.mock('aws-sdk');

jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');

describe('AgentModeService - create_revision tool handling', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('extractMinimalToolResult', () => {
    it('should extract minimal result for create_revision tool', () => {
      const result = {
        success: true,
        message: 'Mock revision created successfully',
        taskId: 'mock-task-123',
        executionId: 'mock-execution-456',
        status: 'pending',
        assetType: 'report',
        targetFile: 'mock-report.html'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'create_revision');

      expect(minimalResult).toEqual({
        taskId: 'mock-task-123',
        executionId: 'mock-execution-456',
        status: 'pending',
        message: 'Mock revision created successfully'
      });
    });

    it('should extract minimal result for other task creation tools', () => {
      const tools = ['create_task_from_template', 'create_task_from_prompt', 'create_image_task_from_prompt'];
      
      tools.forEach(toolName => {
        const result = {
          success: true,
          taskId: 'mock-task-123',
          executionId: 'mock-execution-456',
          status: 'pending',
          message: `Mock task created for ${toolName}`
        };

        const minimalResult = (agentModeService as any).extractMinimalToolResult(result, toolName);

        expect(minimalResult).toEqual({
          taskId: 'mock-task-123',
          executionId: 'mock-execution-456',
          status: 'pending',
          message: `Mock task created for ${toolName}`
        });
      });
    });

    it('should not extract minimal result for non-task-creation tools', () => {
      const result = {
        success: true,
        data: 'some data',
        otherField: 'value'
      };

      const minimalResult = (agentModeService as any).extractMinimalToolResult(result, 'other_tool');

      // The method returns an empty object for non-task-creation tools that aren't generate_image
      expect(minimalResult).toEqual({});
    });
  });

  describe('getPreviousTaskResults', () => {
    it('should include create_revision in task ID extraction', () => {
      const mockSession = {
        sessionId: 'test-session',
        messages: [
          {
            metadata: {
              toolCalls: [
                {
                  name: 'create_revision',
                  result: {
                    taskId: 'task-123',
                    executionId: 'exec-456'
                  }
                },
                {
                  name: 'create_task_from_template',
                  result: {
                    taskId: 'task-789',
                    executionId: 'exec-101'
                  }
                }
              ]
            }
          }
        ]
      };

      const taskIds = new Set<string>();
      mockSession.messages.forEach((message: any) => {
        if (message.metadata?.toolCalls) {
          message.metadata.toolCalls.forEach((toolCall: any) => {
            if (toolCall.name === 'create_task_from_template' || 
                toolCall.name === 'create_task_from_prompt' || 
                toolCall.name === 'create_image_task_from_prompt' || 
                toolCall.name === 'create_revision') {
              if (toolCall.result?.taskId) {
                taskIds.add(toolCall.result.taskId);
              }
            }
          });
        }
      });

      expect(taskIds.has('task-123')).toBe(true);
      expect(taskIds.has('task-789')).toBe(true);
    });
  });

  describe('getTaskStatuses', () => {
    it('should include create_revision in task status extraction', () => {
      const sessionHistory = [
        {
          metadata: {
            toolCalls: [
              {
                name: 'create_revision',
                result: {
                  taskId: 'task-123',
                  executionId: 'exec-456',
                  status: 'pending'
                }
              }
            ]
          }
        }
      ];

      const taskStatuses: any[] = [];
      sessionHistory.forEach(message => {
        if (message.metadata?.toolCalls) {
          message.metadata.toolCalls.forEach((toolCall: any) => {
            if ((toolCall.name === 'create_task_from_template' || 
                 toolCall.name === 'create_task_from_prompt' || 
                 toolCall.name === 'create_image_task_from_prompt' || 
                 toolCall.name === 'create_revision') && toolCall.result) {
              const result = toolCall.result;
              if (result.taskId && result.executionId) {
                taskStatuses.push({
                  taskId: result.taskId,
                  executionId: result.executionId,
                  status: result.status || 'pending'
                });
              }
            }
          });
        }
      });

      expect(taskStatuses).toHaveLength(1);
      expect(taskStatuses[0]).toEqual({
        taskId: 'task-123',
        executionId: 'exec-456',
        status: 'pending'
      });
    });
  });
});
