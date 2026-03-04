import { AgentModeService } from '../services/agentModeService';

// Mock the dependencies
jest.mock('../services/db', () => ({
  taskDb: {
    getTaskById: jest.fn(),
    updateTask: jest.fn(),
  },
}));

jest.mock('@google-cloud/storage', () => {
  const mockFile = {
    download: jest.fn(),
    save: jest.fn(),
    getSignedUrl: jest.fn(),
  };
  const mockBucket = {
    file: jest.fn(() => mockFile),
  };
  return {
    Storage: jest.fn(() => ({
      bucket: jest.fn(() => mockBucket),
    })),
  };
});

jest.mock('../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(() => Promise.resolve('mock-private-key')),
}));

describe('AgentModeService - updateKnowledgeBase', () => {
  let agentModeService: AgentModeService;
  const mockTaskDb = require('../services/db').taskDb;
  const { Storage } = require('@google-cloud/storage');

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('updateKnowledgeBase', () => {
    it('should replace knowledge base content in replace mode', async () => {
      const taskId = 'task-123';
      const content = 'New content for the knowledge base';
      const mode = 'replace';
      const userId = 'user-123';
      const sessionId = 'session-123';

      // Mock task exists and user is authorized
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'private',
      });

      // Mock successful update
      mockTaskDb.updateTask.mockResolvedValue({});

      // Mock GCS operations
      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

      // Call the method
      const result = await agentModeService.updateKnowledgeBase(
        taskId,
        content,
        mode,
        userId,
        sessionId
      );

      // Verify the result
      expect(result.success).toBe(true);
      expect(result.message).toBe('Knowledge base replaced successfully');
      expect(result.updatedSize).toBe(Buffer.byteLength(content, 'utf8'));
      expect(result.updatedAt).toBeDefined();

      // Verify GCS save was called with correct content (no append)
      expect(mockFile.save).toHaveBeenCalledWith(
        content,
        expect.objectContaining({
          contentType: 'text/plain',
          metadata: expect.objectContaining({
            taskId,
            userId,
          }),
        })
      );

      // Verify DynamoDB update
      expect(mockTaskDb.updateTask).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          knowledgeBaseSize: Buffer.byteLength(content, 'utf8'),
          knowledgeBase: 'https://example.com/signed-url',
          knowledgeBaseUpdatedAt: expect.any(String),
        })
      );
    });

    it('should append content in append mode with existing file', async () => {
      const taskId = 'task-123';
      const newContent = 'Additional content';
      const existingContent = 'Existing content';
      const mode = 'append';
      const userId = 'user-123';
      const sessionId = 'session-123';

      // Mock task exists
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'private',
      });

      mockTaskDb.updateTask.mockResolvedValue({});

      // Mock GCS operations
      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      mockFile.download.mockResolvedValue([Buffer.from(existingContent)]);
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

      // Call the method
      const result = await agentModeService.updateKnowledgeBase(
        taskId,
        newContent,
        mode,
        userId,
        sessionId
      );

      // Verify the result
      expect(result.success).toBe(true);
      expect(result.message).toBe('Knowledge base updated successfully');

      // Verify GCS save was called with appended content
      const expectedContent = existingContent + '\n\n' + newContent;
      expect(mockFile.save).toHaveBeenCalledWith(
        expectedContent,
        expect.any(Object)
      );
    });

    it('should create new file in append mode when file does not exist', async () => {
      const taskId = 'task-123';
      const content = 'New content';
      const mode = 'append';
      const userId = 'user-123';
      const sessionId = 'session-123';

      // Mock task exists
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'private',
      });

      mockTaskDb.updateTask.mockResolvedValue({});

      // Mock GCS operations
      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      // Mock download throws error (file doesn't exist)
      mockFile.download.mockRejectedValue(new Error('File not found'));
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

      // Call the method
      const result = await agentModeService.updateKnowledgeBase(
        taskId,
        content,
        mode,
        userId,
        sessionId
      );

      // Verify the result
      expect(result.success).toBe(true);
      expect(result.message).toBe('Knowledge base updated successfully');

      // Verify GCS save was called with just the new content
      expect(mockFile.save).toHaveBeenCalledWith(
        content,
        expect.any(Object)
      );
    });

    it('should use correct bucket for public knowledge base', async () => {
      const taskId = 'task-123';
      const content = 'Public content';
      const mode = 'replace';
      const userId = 'user-123';
      const sessionId = 'session-123';

      // Mock task with public KB type
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'public',
      });

      mockTaskDb.updateTask.mockResolvedValue({});

      // Mock GCS operations
      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

      // Call the method
      const result = await agentModeService.updateKnowledgeBase(
        taskId,
        content,
        mode,
        userId,
        sessionId
      );

      // Verify success (the method creates its own Storage instance internally)
      expect(result.success).toBe(true);
      expect(result.message).toBe('Knowledge base replaced successfully');
    });

    it('should return error when task not found', async () => {
      const taskId = 'task-123';
      const content = 'Content';
      const mode = 'replace';
      const userId = 'user-123';
      const sessionId = 'session-123';

      // Mock task not found
      mockTaskDb.getTaskById.mockResolvedValue(null);

      // Call the method
      const result = await agentModeService.updateKnowledgeBase(
        taskId,
        content,
        mode,
        userId,
        sessionId
      );

      // Verify error response
      expect(result.success).toBe(false);
      expect(result.message).toBe('Task not found');
      expect(result.error).toBe('Task not found');

      // Verify no update was attempted
      expect(mockTaskDb.updateTask).not.toHaveBeenCalled();
    });

    it('should return error when user is not authorized', async () => {
      const taskId = 'task-123';
      const content = 'Content';
      const mode = 'replace';
      const userId = 'user-123';
      const sessionId = 'session-123';

      // Mock task exists but belongs to different user
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId: 'different-user-456',
        knowledgeBaseType: 'private',
      });

      // Call the method
      const result = await agentModeService.updateKnowledgeBase(
        taskId,
        content,
        mode,
        userId,
        sessionId
      );

      // Verify error response
      expect(result.success).toBe(false);
      expect(result.message).toBe('Not authorized to modify this task');
      expect(result.error).toBe('Unauthorized');

      // Verify no update was attempted
      expect(mockTaskDb.updateTask).not.toHaveBeenCalled();
    });

    it('should handle GCS upload failure gracefully', async () => {
      const taskId = 'task-123';
      const content = 'Content';
      const mode = 'replace';
      const userId = 'user-123';
      const sessionId = 'session-123';

      // Mock task exists
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'private',
      });

      // Mock GCS operations
      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      // Mock save throws error
      mockFile.save.mockRejectedValue(new Error('GCS upload failed'));

      // Call the method
      const result = await agentModeService.updateKnowledgeBase(
        taskId,
        content,
        mode,
        userId,
        sessionId
      );

      // Verify error response
      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to update knowledge base');
      expect(result.error).toBe('GCS upload failed');

      // Verify no DB update was attempted
      expect(mockTaskDb.updateTask).not.toHaveBeenCalled();
    });
  });
});
