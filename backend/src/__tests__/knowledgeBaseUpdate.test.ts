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

describe('Knowledge Base Update Endpoint - PUT /api/tasks/:taskId/knowledge-base', () => {
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
      save: jest.fn().mockResolvedValue(undefined),
      getSignedUrl: jest.fn().mockResolvedValue(['https://example.com/kb.txt'])
    };
    
    mockBucket = {
      file: jest.fn().mockReturnValue(mockFile)
    };
    
    mockStorageInstance = {
      bucket: jest.fn().mockReturnValue(mockBucket)
    };
    
    MockedStorage.mockImplementation(() => mockStorageInstance as any);
    
    // Mock the initializeStorage function by setting up environment
    process.env.GCS_PROJECT_ID = 'test-project';
    process.env.GCS_CLIENT_EMAIL = 'test@example.com';
    process.env.GCS_BUCKET_NAME = 'test-bucket';
    process.env.GCS_BUCKET_NAME_PRIVATE = 'test-bucket-private';
    process.env.VERTEX_AI_LOCATION = 'us-central1';
    process.env.VERTEX_AI_LOCATION_PRIVATE = 'us-central1';
    
    app.use('/api/tasks', tasksRouter);
    
    // Clear all mocks before each test
    jest.clearAllMocks();
  });

  describe('Successful updates', () => {
    it('should update knowledge base content', async () => {
      const mockTask = {
        taskId: 'task-123',
        userId: 'test-user-123',
        name: 'Test Task',
        knowledgeBaseType: 'private',
        knowledgeBase: 'https://example.com/old-kb.txt'
      };

      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
      mockedTaskDb.updateTask.mockResolvedValue(mockTask as any);

      const response = await request(app)
        .put('/api/tasks/task-123/knowledge-base')
        .send({ content: 'New knowledge base content' })
        .expect(200);

      expect(response.body).toHaveProperty('content', 'New knowledge base content');
      expect(response.body).toHaveProperty('knowledgeBaseUpdatedAt');
      expect(mockFile.save).toHaveBeenCalledWith(
        'New knowledge base content',
        expect.objectContaining({
          contentType: 'text/plain',
          metadata: expect.objectContaining({
            taskId: 'task-123',
            userId: 'test-user-123'
          })
        })
      );
      expect(mockedTaskDb.updateTask).toHaveBeenCalledWith('task-123', expect.objectContaining({
        knowledgeBaseSize: expect.any(Number),
        knowledgeBase: expect.any(String),
        knowledgeBaseUpdatedAt: expect.any(String)
      }));
    });

    it('should set knowledgeBaseType to private if not defined', async () => {
      const mockTask = {
        taskId: 'task-123',
        userId: 'test-user-123',
        name: 'Test Task',
        knowledgeBaseType: null
      };

      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
      mockedTaskDb.updateTask.mockResolvedValue(mockTask as any);

      await request(app)
        .put('/api/tasks/task-123/knowledge-base')
        .send({ content: 'New content' })
        .expect(200);

      expect(mockedTaskDb.updateTask).toHaveBeenCalledWith('task-123', { knowledgeBaseType: 'private' });
      expect(mockedTaskDb.updateTask).toHaveBeenCalledTimes(2); // Once for setting type, once for updating KB
    });

    it('should handle empty content', async () => {
      const mockTask = {
        taskId: 'task-123',
        userId: 'test-user-123',
        name: 'Test Task',
        knowledgeBaseType: 'private'
      };

      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
      mockedTaskDb.updateTask.mockResolvedValue(mockTask as any);

      const response = await request(app)
        .put('/api/tasks/task-123/knowledge-base')
        .send({ content: '' })
        .expect(200);

      expect(response.body.content).toBe('');
      // Verify task was updated with empty content size
      expect(mockedTaskDb.updateTask).toHaveBeenCalledWith('task-123', expect.objectContaining({
        knowledgeBaseSize: 0,
        knowledgeBase: expect.any(String),
        knowledgeBaseUpdatedAt: expect.any(String)
      }));
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
        .put('/api/tasks/task-123/knowledge-base')
        .send({ content: 'Test content' })
        .expect(401);

      expect(response.body).toEqual({ message: 'Unauthorized' });
    });

    it('should return 404 when task is not found', async () => {
      mockedTaskDb.getTaskById.mockResolvedValue(undefined);

      const response = await request(app)
        .put('/api/tasks/task-123/knowledge-base')
        .send({ content: 'Test content' })
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
        .put('/api/tasks/task-123/knowledge-base')
        .send({ content: 'Test content' })
        .expect(403);

      expect(response.body).toEqual({ message: 'Not authorized to modify this task' });
    });

    it('should return 500 when database update fails', async () => {
      const mockTask = {
        taskId: 'task-123',
        userId: 'test-user-123',
        name: 'Test Task',
        knowledgeBaseType: 'private'
      };

      mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
      mockedTaskDb.updateTask.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .put('/api/tasks/task-123/knowledge-base')
        .send({ content: 'Test content' })
        .expect(500);

      expect(response.body).toEqual({ message: 'Internal server error' });
    });
  });
});

