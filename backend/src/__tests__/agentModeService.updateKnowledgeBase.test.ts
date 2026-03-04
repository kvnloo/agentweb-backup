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

describe('AgentModeService - updateKnowledgeBaseFile', () => {
  let agentModeService: AgentModeService;
  const mockTaskDb = require('../services/db').taskDb;
  const { Storage } = require('@google-cloud/storage');

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  describe('updateKnowledgeBaseFile - main KB file', () => {
    it('should replace knowledge base content in replace mode', async () => {
      const taskId = 'task-123';
      const content = 'New content for the knowledge base';
      const fileName = 'knowledge-base.txt';
      const mode = 'replace';
      const userId = 'user-123';
      const sessionId = 'session-123';

      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'private',
      });

      mockTaskDb.updateTask.mockResolvedValue({});

      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

      const result = await agentModeService.updateKnowledgeBaseFile(
        taskId,
        fileName,
        content,
        mode,
        userId,
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('File "knowledge-base.txt" replaced successfully');
      expect(result.updatedSize).toBe(Buffer.byteLength(content, 'utf8'));
      expect(result.updatedAt).toBeDefined();

      expect(mockFile.save).toHaveBeenCalledWith(
        content,
        expect.objectContaining({
          contentType: 'text/plain',
          metadata: expect.objectContaining({
            taskId,
            userId,
            fileName,
          }),
        })
      );

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
      const fileName = 'knowledge-base.txt';
      const mode = 'append';
      const userId = 'user-123';
      const sessionId = 'session-123';

      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'private',
      });

      mockTaskDb.updateTask.mockResolvedValue({});

      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      mockFile.download.mockResolvedValue([Buffer.from(existingContent)]);
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

      const result = await agentModeService.updateKnowledgeBaseFile(
        taskId,
        fileName,
        newContent,
        mode,
        userId,
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('File "knowledge-base.txt" updated successfully');

      const expectedContent = existingContent + '\n\n' + newContent;
      expect(mockFile.save).toHaveBeenCalledWith(
        expectedContent,
        expect.any(Object)
      );
    });

    it('should create new file in append mode when file does not exist', async () => {
      const taskId = 'task-123';
      const content = 'New content';
      const fileName = 'knowledge-base.txt';
      const mode = 'append';
      const userId = 'user-123';
      const sessionId = 'session-123';

      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'private',
      });

      mockTaskDb.updateTask.mockResolvedValue({});

      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      mockFile.download.mockRejectedValue(new Error('File not found'));
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

      const result = await agentModeService.updateKnowledgeBaseFile(
        taskId,
        fileName,
        content,
        mode,
        userId,
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('File "knowledge-base.txt" updated successfully');

      expect(mockFile.save).toHaveBeenCalledWith(
        content,
        expect.any(Object)
      );
    });

    it('should use correct bucket for public knowledge base', async () => {
      const taskId = 'task-123';
      const content = 'Public content';
      const fileName = 'knowledge-base.txt';
      const mode = 'replace';
      const userId = 'user-123';
      const sessionId = 'session-123';

      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'public',
      });

      mockTaskDb.updateTask.mockResolvedValue({});

      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

      const result = await agentModeService.updateKnowledgeBaseFile(
        taskId,
        fileName,
        content,
        mode,
        userId,
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('File "knowledge-base.txt" replaced successfully');
    });
  });

  describe('updateKnowledgeBaseFile - attached files', () => {
    it('should update an existing attached file by filename', async () => {
      const taskId = 'task-123';
      const content = 'Updated research data';
      const fileName = 'research-notes.txt';
      const mode = 'replace';
      const userId = 'user-123';
      const sessionId = 'session-123';

      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'private',
        knowledgeBaseFiles: [
          {
            filename: 'research-notes.txt',
            size: 100,
            url: 'https://example.com/old-url',
            key: 'tasks/task-123/knowledge-base-files/123_research-notes.txt',
            uploadedAt: '2026-01-01T00:00:00.000Z',
          }
        ],
      });

      mockTaskDb.updateTask.mockResolvedValue({});

      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/new-signed-url']);

      const result = await agentModeService.updateKnowledgeBaseFile(
        taskId,
        fileName,
        content,
        mode,
        userId,
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.fileName).toBe('research-notes.txt');

      // Should update knowledgeBaseFiles array, not main KB fields
      expect(mockTaskDb.updateTask).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          knowledgeBaseFiles: expect.arrayContaining([
            expect.objectContaining({
              filename: 'research-notes.txt',
              url: 'https://example.com/new-signed-url',
            })
          ]),
          knowledgeBaseUpdatedAt: expect.any(String),
        })
      );
    });

    it('should create a new attached file when filename not found', async () => {
      const taskId = 'task-123';
      const content = 'Brand new file content';
      const fileName = 'new-document.txt';
      const mode = 'replace';
      const userId = 'user-123';
      const sessionId = 'session-123';

      mockTaskDb.getTaskById.mockResolvedValue({
        taskId,
        userId,
        knowledgeBaseType: 'private',
        knowledgeBaseFiles: [],
      });

      mockTaskDb.updateTask.mockResolvedValue({});

      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/new-url']);

      const result = await agentModeService.updateKnowledgeBaseFile(
        taskId,
        fileName,
        content,
        mode,
        userId,
        sessionId
      );

      expect(result.success).toBe(true);
      expect(result.fileName).toBe('new-document.txt');

      // Should add to knowledgeBaseFiles array
      expect(mockTaskDb.updateTask).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({
          knowledgeBaseFiles: expect.arrayContaining([
            expect.objectContaining({
              filename: 'new-document.txt',
            })
          ]),
        })
      );
    });
  });

  describe('updateKnowledgeBaseFile - error cases', () => {
    it('should return error when task not found', async () => {
      mockTaskDb.getTaskById.mockResolvedValue(null);

      const result = await agentModeService.updateKnowledgeBaseFile(
        'task-123',
        'knowledge-base.txt',
        'Content',
        'replace',
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Task not found');
      expect(mockTaskDb.updateTask).not.toHaveBeenCalled();
    });

    it('should return error when user is not authorized', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId: 'task-123',
        userId: 'different-user-456',
        knowledgeBaseType: 'private',
      });

      const result = await agentModeService.updateKnowledgeBaseFile(
        'task-123',
        'knowledge-base.txt',
        'Content',
        'replace',
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Not authorized to modify this task');
      expect(mockTaskDb.updateTask).not.toHaveBeenCalled();
    });

    it('should return error when content is empty', async () => {
      const result = await agentModeService.updateKnowledgeBaseFile(
        'task-123',
        'knowledge-base.txt',
        '',
        'replace',
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid input: empty content');
    });

    it('should return error when fileName is empty', async () => {
      const result = await agentModeService.updateKnowledgeBaseFile(
        'task-123',
        '',
        'Some content',
        'replace',
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid input: missing fileName');
    });

    it('should handle GCS upload failure gracefully', async () => {
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId: 'task-123',
        userId: 'user-123',
        knowledgeBaseType: 'private',
      });

      const mockStorageInstance = new Storage();
      const mockBucket = mockStorageInstance.bucket();
      const mockFile = mockBucket.file();
      mockFile.save.mockRejectedValue(new Error('GCS upload failed'));

      const result = await agentModeService.updateKnowledgeBaseFile(
        'task-123',
        'knowledge-base.txt',
        'Content',
        'replace',
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to update knowledge base file');
      expect(result.error).toBe('GCS upload failed');
      expect(mockTaskDb.updateTask).not.toHaveBeenCalled();
    });
  });
});
