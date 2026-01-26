// Test filterMessagesForClient function
// Note: Since filterMessagesForClient is not exported, we test it indirectly through the API

import request from 'supertest';
import express from 'express';

// Mock dependencies BEFORE importing the router
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'user-123', email: 'test@example.com', isAdmin: false };
    next();
  },
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.user?.isAdmin) {
      next();
    } else {
      res.status(403).json({ error: 'Admin access required' });
    }
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
  },
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getDefaultModel: jest.fn().mockResolvedValue('gpt-4o'),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
}));

// Mock conversable middleware
jest.mock('../middleware/conversable', () => ({
  authenticateConversable: (req: any, res: any, next: any) => {
    req.conversableSession = { sessionId: 'test-session' };
    next();
  },
}));

// Mock config
jest.mock('../config', () => ({
  MAX_FILE_SIZE: 104857600, // 100MB
}));

// Mock multer
jest.mock('multer', () => {
  const multer = () => ({
    single: () => (req: any, res: any, next: any) => next(),
    array: () => (req: any, res: any, next: any) => next(),
  });
  multer.memoryStorage = () => ({});
  return multer;
});

const { chatbotDb } = require('../services/chatbotService');
const { userDb } = require('../services/db');

// Import router AFTER all mocks
import agentModeRouter from '../routes/agentMode';

describe('filterMessagesForClient - Tool Calls Preservation', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/agent-mode', agentModeRouter);
    jest.clearAllMocks();
  });

  describe('GET /api/agent-mode/ishare/:shareId', () => {
    it('should preserve assistant messages with metadata.toolCalls', async () => {
      const mockSession = {
        sessionId: 'session-123',
        userId: 'user-123',
        title: 'Test Session',
        messages: [
          {
            role: 'user',
            content: 'Create a task',
          },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { name: 'create_task_from_prompt', arguments: '{"prompt":"test"}' },
            ],
          },
          {
            role: 'tool',
            content: 'Task created',
            tool_call_id: 'call-123',
          },
          {
            role: 'assistant',
            content: 'I created a task for you.',
            metadata: {
              toolCalls: [
                {
                  name: 'create_task_from_prompt',
                  result: { taskId: 'task-123', success: true },
                },
              ],
            },
          },
        ],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
        },
        createdAt: '2026-01-25T00:00:00Z',
        updatedAt: '2026-01-25T00:00:00Z',
      };

      chatbotDb.getChatSession.mockResolvedValue(mockSession);
      userDb.getUserById.mockResolvedValue({ userId: 'user-123', supportNote: 'Test Company' });

      const response = await request(app)
        .get('/api/agent-mode/ishare/session-123?conversable=valid-token')
        .send();

      expect(response.status).toBe(200);
      expect(response.body.session).toBeDefined();
      expect(response.body.session.messages).toHaveLength(2); // User message + final assistant message

      // Verify tool message is filtered out
      const toolMessageExists = response.body.session.messages.some(
        (msg: any) => msg.role === 'tool'
      );
      expect(toolMessageExists).toBe(false);

      // Verify intermediate assistant message with tool_calls (no metadata.toolCalls) is filtered out
      const intermediateAssistant = response.body.session.messages.find(
        (msg: any) => msg.role === 'assistant' && msg.content === ''
      );
      expect(intermediateAssistant).toBeUndefined();

      // Verify final assistant message with metadata.toolCalls is preserved
      const finalAssistant = response.body.session.messages.find(
        (msg: any) => msg.role === 'assistant' && msg.content === 'I created a task for you.'
      );
      expect(finalAssistant).toBeDefined();
      expect(finalAssistant.metadata.toolCalls).toBeDefined();
      expect(finalAssistant.metadata.toolCalls).toHaveLength(1);
      expect(finalAssistant.metadata.toolCalls[0].name).toBe('create_task_from_prompt');
    });

    it('should filter out intermediate assistant messages without metadata.toolCalls', async () => {
      const mockSession = {
        sessionId: 'session-456',
        userId: 'user-456',
        title: 'Test Session',
        messages: [
          {
            role: 'user',
            content: 'Test',
          },
          {
            role: 'assistant',
            content: 'Thinking...',
            tool_calls: [{ name: 'some_tool', arguments: '{}' }],
          },
          {
            role: 'assistant',
            content: 'Final answer',
          },
        ],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
        },
        createdAt: '2026-01-25T00:00:00Z',
        updatedAt: '2026-01-25T00:00:00Z',
      };

      chatbotDb.getChatSession.mockResolvedValue(mockSession);
      userDb.getUserById.mockResolvedValue({ userId: 'user-456' });

      const response = await request(app)
        .get('/api/agent-mode/ishare/session-456?conversable=valid-token')
        .send();

      expect(response.status).toBe(200);
      expect(response.body.session.messages).toHaveLength(2); // User message + final assistant message

      // Verify intermediate assistant with tool_calls is filtered out
      const thinkingMessage = response.body.session.messages.find(
        (msg: any) => msg.content === 'Thinking...'
      );
      expect(thinkingMessage).toBeUndefined();

      // Verify final assistant message is preserved
      const finalMessage = response.body.session.messages.find(
        (msg: any) => msg.content === 'Final answer'
      );
      expect(finalMessage).toBeDefined();
    });

    it('should preserve assistant messages with both tool_calls and metadata.toolCalls', async () => {
      const mockSession = {
        sessionId: 'session-789',
        userId: 'user-789',
        title: 'Test Session',
        messages: [
          {
            role: 'user',
            content: 'Test',
          },
          {
            role: 'assistant',
            content: 'Result',
            tool_calls: [{ name: 'tool1', arguments: '{}' }],
            metadata: {
              toolCalls: [{ name: 'tool1', result: { success: true } }],
            },
          },
        ],
        interactiveShareMetadata: {
          isActive: true,
          token: 'valid-token',
        },
        createdAt: '2026-01-25T00:00:00Z',
        updatedAt: '2026-01-25T00:00:00Z',
      };

      chatbotDb.getChatSession.mockResolvedValue(mockSession);
      userDb.getUserById.mockResolvedValue({ userId: 'user-789' });

      const response = await request(app)
        .get('/api/agent-mode/ishare/session-789?conversable=valid-token')
        .send();

      expect(response.status).toBe(200);
      expect(response.body.session.messages).toHaveLength(2);

      // Verify assistant message is preserved because it has metadata.toolCalls
      const assistantMessage = response.body.session.messages.find(
        (msg: any) => msg.role === 'assistant'
      );
      expect(assistantMessage).toBeDefined();
      expect(assistantMessage.metadata.toolCalls).toBeDefined();
      expect(assistantMessage.content).toBe('Result');
    });
  });
});
