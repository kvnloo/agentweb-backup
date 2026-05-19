import request from 'supertest';
import express from 'express';
import tasksRouter from '../routes/tasks';
import { taskDb } from '../services/db';
import { authenticateToken } from '../middleware/auth';

// Mock the database service
jest.mock('../services/db');
const mockedTaskDb = taskDb as jest.Mocked<typeof taskDb>;

// Mock the auth middleware
jest.mock('../middleware/auth');
const mockedAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

describe('Knowledge Base All Endpoint - GET /api/tasks/knowledge-base/all', () => {
  let app: express.Application;

  beforeEach(() => {
    // Create a fresh Express app for each test
    app = express();
    app.use(express.json());
    
    // Mock authenticateToken to pass through
    mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
      // Set up a mock user
      (req as any).user = {
        userId: 'test-user-123',
        email: 'test@example.com',
        isAdmin: false
      };
      next();
      return undefined;
    });
    
    app.use('/api/tasks', tasksRouter);
    
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('Successful requests', () => {
    it('should return empty array when user has no tasks with knowledge base', async () => {
      mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/knowledge-base/all')
        .expect(200);

      expect(response.body).toEqual([]);
      expect(mockedTaskDb.getTasksWithKnowledgeBase).toHaveBeenCalledWith('test-user-123');
    });

    it('should filter out tasks with empty knowledge base', async () => {
      const mockTasks = [
        {
          taskId: 'task-3',
          name: 'Task 3',
          knowledgeBaseSize: 1024,
          knowledgeBaseType: 'public',
          knowledgeBaseUpdatedAt: '2024-01-02T00:00:00Z'
        }
      ];
      mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue(mockTasks as any);

      const response = await request(app)
        .get('/api/tasks/knowledge-base/all')
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0]).toMatchObject({
        taskId: 'task-3',
        name: 'Task 3',
        knowledgeBaseSize: 1024,
        knowledgeBaseType: 'public',
        knowledgeBaseFiles: [],
        knowledgeBaseUpdatedAt: '2024-01-02T00:00:00Z'
      });
    });

    it('should handle string knowledgeBaseSize values', async () => {
      const mockTasks = [
        {
          taskId: 'task-1',
          name: 'Task 1',
          knowledgeBaseSize: 2048,
          knowledgeBaseType: 'private',
          knowledgeBaseUpdatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue(mockTasks as any);

      const response = await request(app)
        .get('/api/tasks/knowledge-base/all')
        .expect(200);

      expect(response.body[0].knowledgeBaseSize).toBe(2048);
    });

    it('should sort tasks by last updated (most recent first)', async () => {
      const mockTasks = [
        {
          taskId: 'task-2',
          name: 'Task 2',
          knowledgeBaseSize: 200,
          knowledgeBaseType: 'public',
          knowledgeBaseUpdatedAt: '2024-01-03T00:00:00Z'
        },
        {
          taskId: 'task-3',
          name: 'Task 3',
          knowledgeBaseSize: 300,
          knowledgeBaseType: 'private',
          knowledgeBaseUpdatedAt: '2024-01-02T00:00:00Z'
        },
        {
          taskId: 'task-1',
          name: 'Task 1',
          knowledgeBaseSize: 100,
          knowledgeBaseType: 'private',
          knowledgeBaseUpdatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue(mockTasks as any);

      const response = await request(app)
        .get('/api/tasks/knowledge-base/all')
        .expect(200);

      expect(response.body).toHaveLength(3);
      expect(response.body[0].taskId).toBe('task-2'); // Most recent
      expect(response.body[1].taskId).toBe('task-3');
      expect(response.body[2].taskId).toBe('task-1'); // Oldest
    });

    it('should default knowledgeBaseType to private when not set', async () => {
      const mockTasks = [
        {
          taskId: 'task-1',
          name: 'Task 1',
          knowledgeBaseSize: 100,
          knowledgeBaseType: 'private',
          knowledgeBaseUpdatedAt: '2024-01-01T00:00:00Z'
        }
      ];
      mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue(mockTasks as any);

      const response = await request(app)
        .get('/api/tasks/knowledge-base/all')
        .expect(200);

      expect(response.body[0].knowledgeBaseType).toBe('private');
    });

    it('should return only necessary fields', async () => {
      const mockTasks = [
        {
          taskId: 'task-1',
          name: 'Task 1',
          prompt: 'Some prompt',
          status: 'active',
          knowledgeBaseSize: 100,
          knowledgeBaseType: 'public',
          knowledgeBaseUpdatedAt: '2024-01-01T00:00:00Z',
          createdAt: '2024-01-01T00:00:00Z',
          userId: 'test-user-123'
        }
      ];
      mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue(mockTasks as any);

      const response = await request(app)
        .get('/api/tasks/knowledge-base/all')
        .expect(200);

      expect(response.body[0]).toEqual({
        taskId: 'task-1',
        userId: 'test-user-123',
        name: 'Task 1',
        knowledgeBaseSize: 100,
        knowledgeBaseType: 'public',
        knowledgeBaseFiles: [],
        knowledgeBaseUpdatedAt: '2024-01-01T00:00:00Z'
      });
      expect(response.body[0]).not.toHaveProperty('prompt');
      expect(response.body[0]).not.toHaveProperty('status');
      expect(response.body[0]).not.toHaveProperty('createdAt');
    });
  });

  describe('Error handling', () => {
    it('should return 401 when user is not authenticated', async () => {
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = null;
        next();
        return undefined;
      });

      const response = await request(app)
        .get('/api/tasks/knowledge-base/all')
        .expect(401);

      expect(response.body).toEqual({ message: 'Unauthorized' });
    });

    it('should return 500 when database throws error', async () => {
      mockedTaskDb.getTasksWithKnowledgeBase.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/tasks/knowledge-base/all')
        .expect(500);

      expect(response.body).toEqual({ message: 'Internal server error' });
    });
  });
});

