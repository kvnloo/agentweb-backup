import request from 'supertest';
import express from 'express';
import tasksRouter from '../routes/tasks';
import { taskDb } from '../services/db';
import { authenticateToken, getEffectiveOwnerId } from '../middleware/auth';
import { Storage } from '@google-cloud/storage';

// Mock the database service
jest.mock('../services/db');
const mockedTaskDb = taskDb as jest.Mocked<typeof taskDb>;

// Mock the auth middleware
jest.mock('../middleware/auth');
const mockedAuthenticateToken = authenticateToken as jest.MockedFunction<typeof authenticateToken>;
const mockedGetEffectiveOwnerId = getEffectiveOwnerId as jest.MockedFunction<typeof getEffectiveOwnerId>;

// Mock Google Cloud Storage
jest.mock('@google-cloud/storage');
const MockedStorage = Storage as jest.MockedClass<typeof Storage>;

// Mock secrets manager
jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn().mockResolvedValue('mock-private-key')
}));


describe('Knowledge Base Delete Endpoint - DELETE /api/tasks/:taskId/knowledge-base', () => {
  let app: express.Application;
  let mockBucket: any;
  let mockFile: any;
  let mockStorageInstance: any;

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

    // Mock getEffectiveOwnerId to return the user's ID
    mockedGetEffectiveOwnerId.mockImplementation((req: any) => req.user?.userId);
    
    // Setup GCS mocks
    mockFile = {
      exists: jest.fn().mockResolvedValue([true]),
      delete: jest.fn().mockResolvedValue(undefined)
    };
    
    mockBucket = {
      file: jest.fn().mockReturnValue(mockFile)
    };
    
    mockStorageInstance = {
      bucket: jest.fn().mockReturnValue(mockBucket)
    };
    
    // Mock Storage constructor to return our mock instance
    MockedStorage.mockImplementation(() => mockStorageInstance as any);
    
    // Set up environment variables for storage initialization
    process.env.GCS_PROJECT_ID = 'test-project';
    process.env.GCS_CLIENT_EMAIL = 'test@example.com';
    process.env.GCS_BUCKET_NAME = 'test-bucket';
    process.env.GCS_BUCKET_NAME_PRIVATE = 'test-bucket-private';
    process.env.VERTEX_AI_LOCATION = 'us-central1';
    process.env.VERTEX_AI_LOCATION_PRIVATE = 'us-central1';
    
    // Reset the storage module-level variable
    const tasksModule = require('../routes/tasks');
    if (tasksModule.storage) {
      tasksModule.storage = null;
    }
    
    app.use('/api/tasks', tasksRouter);
    
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('Successful deletion', () => {
    it('should delete knowledge base file and update task', async () => {
      const mockTask = {
        taskId: 'task-123',
        userId: 'test-user-123',
        name: 'Test Task',
        knowledgeBaseType: 'private',
        knowledgeBaseSize: 1024,
        knowledgeBase: 'gs://bucket/tasks/task-123/knowledge-base.txt'
      };

      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
      mockedTaskDb.updateTask.mockResolvedValue(mockTask as any);

      const response = await request(app)
        .delete('/api/tasks/task-123/knowledge-base')
        .expect(200);

      expect(response.body).toEqual({ message: 'Knowledge base deleted successfully' });
      expect(mockedTaskDb.getTaskById).toHaveBeenCalledWith('task-123');
      expect(mockFile.exists).toHaveBeenCalled();
      expect(mockFile.delete).toHaveBeenCalled();
      expect(mockedTaskDb.updateTask).toHaveBeenCalledWith('task-123', {
        knowledgeBaseSize: 0,
        knowledgeBase: undefined,
        knowledgeBaseType: undefined,
        knowledgeBaseUpdatedAt: undefined
      });
    });

    it('should delete from public bucket when knowledgeBaseType is public', async () => {
      const mockTask = {
        taskId: 'task-123',
        userId: 'test-user-123',
        name: 'Test Task',
        knowledgeBaseType: 'public',
        knowledgeBaseSize: 1024
      };

      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
      mockedTaskDb.updateTask.mockResolvedValue(mockTask as any);

      const response = await request(app)
        .delete('/api/tasks/task-123/knowledge-base')
        .expect(200);

      expect(response.body).toEqual({ message: 'Knowledge base deleted successfully' });
      // Verify task was updated to remove knowledge base info
      expect(mockedTaskDb.updateTask).toHaveBeenCalledWith('task-123', {
        knowledgeBaseSize: 0,
        knowledgeBase: undefined,
        knowledgeBaseType: undefined,
        knowledgeBaseUpdatedAt: undefined
      });
    });

    it('should handle case when file does not exist', async () => {
      const mockTask = {
        taskId: 'task-123',
        userId: 'test-user-123',
        name: 'Test Task',
        knowledgeBaseType: 'private',
        knowledgeBaseSize: 1024
      };

      mockFile.exists.mockResolvedValue([false]);
      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
      mockedTaskDb.updateTask.mockResolvedValue(mockTask as any);

      const response = await request(app)
        .delete('/api/tasks/task-123/knowledge-base')
        .expect(200);

      expect(response.body).toEqual({ message: 'Knowledge base deleted successfully' });
      expect(mockFile.delete).not.toHaveBeenCalled();
      expect(mockedTaskDb.updateTask).toHaveBeenCalled();
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
        .delete('/api/tasks/task-123/knowledge-base')
        .expect(401);

      expect(response.body).toEqual({ message: 'Unauthorized' });
    });

    it('should return 404 when task is not found', async () => {
      mockedTaskDb.getTaskById.mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/tasks/task-123/knowledge-base')
        .expect(404);

      expect(response.body).toEqual({ message: 'Task not found' });
    });

    it('should return 403 when user does not own the task', async () => {
      const mockTask = {
        taskId: 'task-123',
        userId: 'other-user-456',
        name: 'Test Task',
        knowledgeBaseType: 'private'
      };

      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);

      const response = await request(app)
        .delete('/api/tasks/task-123/knowledge-base')
        .expect(403);

      expect(response.body).toEqual({ message: 'Not authorized to modify this task' });
    });

    it('should return 400 when knowledge base does not exist', async () => {
      const mockTask = {
        taskId: 'task-123',
        userId: 'test-user-123',
        name: 'Test Task',
        knowledgeBaseType: null
      };

      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);

      const response = await request(app)
        .delete('/api/tasks/task-123/knowledge-base')
        .expect(400);

      expect(response.body).toEqual({ message: 'Knowledge base does not exist for this task' });
    });

    it('should allow admin to delete any task', async () => {
      mockedAuthenticateToken.mockImplementation(async (req, res, next) => {
        (req as any).user = {
          userId: 'admin-user',
          email: 'admin@example.com',
          isAdmin: true
        };
        next();
        return undefined;
      });

      const mockTask = {
        taskId: 'task-123',
        userId: 'other-user-456',
        name: 'Test Task',
        knowledgeBaseType: 'private',
        knowledgeBaseSize: 1024
      };

      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
      mockedTaskDb.updateTask.mockResolvedValue(mockTask as any);

      const response = await request(app)
        .delete('/api/tasks/task-123/knowledge-base')
        .expect(200);

      expect(response.body).toEqual({ message: 'Knowledge base deleted successfully' });
    });

    it('should return 500 when database update fails', async () => {
      const mockTask = {
        taskId: 'task-123',
        userId: 'test-user-123',
        name: 'Test Task',
        knowledgeBaseType: 'private',
        knowledgeBaseSize: 1024
      };

      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
      mockedTaskDb.updateTask.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .delete('/api/tasks/task-123/knowledge-base')
        .expect(500);

      expect(response.body).toEqual({ message: 'Internal server error' });
    });
  });
});

