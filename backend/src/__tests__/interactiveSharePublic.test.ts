import request from 'supertest';
import express from 'express';
import { getTaskExecutionPublic } from '../controllers/tasks';
import { chatbotDb } from '../services/chatbotService';
import { taskDb } from '../services/db';

// Mock the services
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
  }
}));

jest.mock('../services/db', () => ({
  taskDb: {
    getTaskExecutionById: jest.fn(),
  }
}));

// Create a test app
const createTestApp = () => {
  const app = express();
  app.use(express.json());
  
  // Add the route
  app.get('/api/tasks/:id/executions/:executionId/public', getTaskExecutionPublic);
  
  return app;
};

describe('Interactive Share Public Endpoint Tests', () => {
  let app: express.Application;
  const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
  const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;

  beforeEach(() => {
    app = createTestApp();
    jest.clearAllMocks();
  });

  describe('GET /api/tasks/:id/executions/:executionId/public', () => {
    const taskId = 'test-task-id';
    const executionId = 'test-execution-id';
    const sessionId = 'test-session-id';

    it('should return 400 when sessionId is missing', async () => {
      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public`);

      expect(response.status).toBe(400);
      expect(response.body.message).toBe('Session ID is required');
    });

    it('should return 404 when session is not found', async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(null);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(404);
      expect(response.body.message).toBe('Session not found');
    });

    it('should return 404 when session is not shared (no view-only or interactive share)', async () => {
      const mockSession = {
        sessionId,
        messages: [],
        shareMetadata: { isShared: false },
        interactiveShareMetadata: { isActive: false }
      };
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(404);
      expect(response.body.message).toBe('Session is not shared');
    });

    it('should return 404 when session has expired view-only share', async () => {
      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() - 1); // Yesterday
      
      const mockSession = {
        sessionId,
        messages: [],
        shareMetadata: { 
          isShared: true, 
          expiresAt: expiredDate.toISOString() 
        },
        interactiveShareMetadata: { isActive: false }
      };
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(410);
      expect(response.body.message).toBe('Share link has expired');
    });

    it('should return 404 when task execution is not found in session messages', async () => {
      const mockSession = {
        sessionId,
        messages: [
          {
            role: 'assistant',
            content: 'Test message',
            metadata: {
              toolCalls: [
                {
                  result: {
                    taskId: 'different-task-id',
                    executionId: 'different-execution-id'
                  }
                }
              ]
            }
          }
        ],
        shareMetadata: { isShared: true },
        interactiveShareMetadata: { isActive: false }
      };
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(404);
      expect(response.body.message).toBe('Task execution not found in this session');
    });

    it('should return 404 when execution is not found in database', async () => {
      const mockSession = {
        sessionId,
        messages: [
          {
            role: 'assistant',
            content: 'Test message',
            metadata: {
              toolCalls: [
                {
                  result: {
                    taskId,
                    executionId
                  }
                }
              ]
            }
          }
        ],
        shareMetadata: { isShared: true },
        interactiveShareMetadata: { isActive: false }
      };
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue(undefined);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(404);
      expect(response.body.message).toBe('Execution not found');
    });

    it('should return 404 when execution taskId does not match', async () => {
      const mockSession = {
        sessionId,
        messages: [
          {
            role: 'assistant',
            content: 'Test message',
            metadata: {
              toolCalls: [
                {
                  result: {
                    taskId,
                    executionId
                  }
                }
              ]
            }
          }
        ],
        shareMetadata: { isShared: true },
        interactiveShareMetadata: { isActive: false }
      };
      const mockExecution = {
        executionId,
        taskId: 'different-task-id',
        status: 'completed',
        message: 'Task completed',
        result_files: [],
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString()
      };
      
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue(mockExecution as any);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(404);
      expect(response.body.message).toBe('Execution not found for this task');
    });

    it('should return task execution data for view-only share', async () => {
      const mockSession = {
        sessionId,
        messages: [
          {
            role: 'assistant',
            content: 'Test message',
            metadata: {
              toolCalls: [
                {
                  result: {
                    taskId,
                    executionId
                  }
                }
              ]
            }
          }
        ],
        shareMetadata: { isShared: true },
        interactiveShareMetadata: { isActive: false }
      };
      const mockExecution = {
        executionId,
        taskId,
        status: 'completed',
        message: 'Task completed',
        result_files: [
          {
            view_type: 'html',
            filename: 'report.html',
            url: 'https://example.com/report.html',
            file_type: 'html',
            token: 'test-token'
          }
        ],
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString()
      };
      
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue(mockExecution as any);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        executionId,
        taskId,
        status: 'completed',
        message: 'Task completed',
        result_files: mockExecution.result_files,
        startTime: mockExecution.startTime,
        endTime: mockExecution.endTime
      });
    });

    it('should return task execution data for interactive share', async () => {
      const mockSession = {
        sessionId,
        messages: [
          {
            role: 'assistant',
            content: 'Test message',
            metadata: {
              toolCalls: [
                {
                  result: {
                    taskId,
                    executionId
                  }
                }
              ]
            }
          }
        ],
        shareMetadata: { isShared: false },
        interactiveShareMetadata: { isActive: true, token: 'conv-token', expiresAt: '2099-01-01T00:00:00Z' }
      };
      const mockExecution = {
        executionId,
        taskId,
        status: 'completed',
        message: 'Task completed',
        result_files: [
          {
            view_type: 'html',
            filename: 'report.html',
            url: 'https://example.com/report.html',
            file_type: 'html',
            token: 'test-token'
          }
        ],
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString()
      };
      
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue(mockExecution as any);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}&conversable=conv-token`);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        executionId,
        taskId,
        status: 'completed',
        message: 'Task completed',
        result_files: mockExecution.result_files,
        startTime: mockExecution.startTime,
        endTime: mockExecution.endTime
      });
    });

    // ENG-2644: an interactive share is opened with its conversable token, never by the session id alone.
    describe('interactive share without a view-only share (ENG-2644)', () => {
      const interactiveSession = (share: Record<string, unknown>) => ({
        sessionId,
        messages: [{ role: 'assistant', content: 'm', metadata: { toolCalls: [{ result: { taskId, executionId } }] } }],
        shareMetadata: { isShared: false },
        interactiveShareMetadata: { isActive: true, token: 'conv-token', ...share },
      });
      const get = (query: string) => request(app).get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}${query}`);

      it('answers 401 without a conversable token and reads no execution', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(interactiveSession({ expiresAt: '2099-01-01T00:00:00Z' }) as any);
        const response = await get('');
        expect(response.status).toBe(401);
        expect(mockTaskDb.getTaskExecutionById).not.toHaveBeenCalled();
      });

      it('answers 401 for a wrong token and reads no execution', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(interactiveSession({ expiresAt: '2099-01-01T00:00:00Z' }) as any);
        const response = await get('&conversable=not-the-token');
        expect(response.status).toBe(401);
        expect(mockTaskDb.getTaskExecutionById).not.toHaveBeenCalled();
      });

      it('answers 410 for an expired share with NO share-metadata write, and 410 again on retry', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(interactiveSession({ expiresAt: '2020-01-01T00:00:00Z' }) as any);
        expect((await get('&conversable=conv-token')).status).toBe(410);
        expect((await get('&conversable=conv-token')).status).toBe(410);
        expect(mockChatbotDb.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
        expect(mockTaskDb.getTaskExecutionById).not.toHaveBeenCalled();
      });

      it('answers 410 for a switched-off share with the right token and 401 with a wrong one (never 404)', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(interactiveSession({ isActive: false }) as any);
        expect((await get('&conversable=conv-token')).status).toBe(410);
        expect((await get('&conversable=other')).status).toBe(401);
      });

      it('still serves a live view-only share with interactive metadata present and no token (ShareConversation page)', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...interactiveSession({}),
          shareMetadata: { isShared: true },
        } as any);
        mockTaskDb.getTaskExecutionById.mockResolvedValue({ executionId, taskId, status: 'running' } as any);
        expect((await get('')).status).toBe(200);
      });

      it('answers 410 for an expired view-only share when there is no interactive share', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue({
          sessionId,
          messages: [],
          shareMetadata: { isShared: true, expiresAt: '2020-01-01T00:00:00Z' },
        } as any);
        const response = await get('');
        expect(response.status).toBe(410);
        expect(mockTaskDb.getTaskExecutionById).not.toHaveBeenCalled();
      });

      it('requires the token once the view-only share has expired but the interactive share is live', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue({
          ...interactiveSession({ expiresAt: '2099-01-01T00:00:00Z' }),
          shareMetadata: { isShared: true, expiresAt: '2020-01-01T00:00:00Z' },
        } as any);
        mockTaskDb.getTaskExecutionById.mockResolvedValue({ executionId, taskId, status: 'running' } as any);
        expect((await get('')).status).toBe(401);
        expect((await get('&conversable=conv-token')).status).toBe(200);
      });

      it('serves a share with no expiresAt (never expires) to the token holder', async () => {
        mockChatbotDb.getChatSession.mockResolvedValue(interactiveSession({}) as any);
        mockTaskDb.getTaskExecutionById.mockResolvedValue({ executionId, taskId, status: 'running' } as any);
        const response = await get('&conversable=conv-token');
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('running');
      });
    });

    it('should handle multiple tool calls in messages', async () => {
      const mockSession = {
        sessionId,
        messages: [
          {
            role: 'assistant',
            content: 'Test message',
            metadata: {
              toolCalls: [
                {
                  result: {
                    taskId: 'other-task-id',
                    executionId: 'other-execution-id'
                  }
                },
                {
                  result: {
                    taskId,
                    executionId
                  }
                }
              ]
            }
          }
        ],
        shareMetadata: { isShared: true },
        interactiveShareMetadata: { isActive: false }
      };
      const mockExecution = {
        executionId,
        taskId,
        status: 'completed',
        message: 'Task completed',
        result_files: [],
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString()
      };
      
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue(mockExecution as any);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body.executionId).toBe(executionId);
    });

    it('should handle multiple messages with tool calls', async () => {
      const mockSession = {
        sessionId,
        messages: [
          {
            role: 'assistant',
            content: 'First message',
            metadata: {
              toolCalls: [
                {
                  result: {
                    taskId: 'other-task-id',
                    executionId: 'other-execution-id'
                  }
                }
              ]
            }
          },
          {
            role: 'assistant',
            content: 'Second message',
            metadata: {
              toolCalls: [
                {
                  result: {
                    taskId,
                    executionId
                  }
                }
              ]
            }
          }
        ],
        shareMetadata: { isShared: true },
        interactiveShareMetadata: { isActive: false }
      };
      const mockExecution = {
        executionId,
        taskId,
        status: 'completed',
        message: 'Task completed',
        result_files: [],
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString()
      };
      
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue(mockExecution as any);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body.executionId).toBe(executionId);
    });

    it('should handle empty result_files array', async () => {
      const mockSession = {
        sessionId,
        messages: [
          {
            role: 'assistant',
            content: 'Test message',
            metadata: {
              toolCalls: [
                {
                  result: {
                    taskId,
                    executionId
                  }
                }
              ]
            }
          }
        ],
        shareMetadata: { isShared: true },
        interactiveShareMetadata: { isActive: false }
      };
      const mockExecution = {
        executionId,
        taskId,
        status: 'completed',
        message: 'Task completed',
        result_files: [],
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString()
      };
      
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue(mockExecution as any);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body.result_files).toEqual([]);
    });

    it('should handle missing result_files field', async () => {
      const mockSession = {
        sessionId,
        messages: [
          {
            role: 'assistant',
            content: 'Test message',
            metadata: {
              toolCalls: [
                {
                  result: {
                    taskId,
                    executionId
                  }
                }
              ]
            }
          }
        ],
        shareMetadata: { isShared: true },
        interactiveShareMetadata: { isActive: false }
      };
      const mockExecution = {
        executionId,
        taskId,
        status: 'completed',
        message: 'Task completed',
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString()
      };
      
      mockChatbotDb.getChatSession.mockResolvedValue(mockSession as any);
      mockTaskDb.getTaskExecutionById.mockResolvedValue(mockExecution as any);

      const response = await request(app)
        .get(`/api/tasks/${taskId}/executions/${executionId}/public?sessionId=${sessionId}`);

      expect(response.status).toBe(200);
      expect(response.body.result_files).toEqual([]);
    });
  });
});
