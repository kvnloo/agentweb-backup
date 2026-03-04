import { AgentModeService } from '../services/agentModeService';

jest.mock('../services/db', () => ({
  taskDb: {
    createTask: jest.fn(),
    updateTask: jest.fn(),
  },
}));

jest.mock('@google-cloud/storage', () => {
  const mockFile = {
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

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-123'),
}));

describe('AgentModeService - createKnowledgeBase', () => {
  let agentModeService: AgentModeService;
  const mockTaskDb = require('../services/db').taskDb;
  const { Storage } = require('@google-cloud/storage');

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  it('should create a knowledge base successfully', async () => {
    mockTaskDb.createTask.mockResolvedValue({});
    mockTaskDb.updateTask.mockResolvedValue({});

    const mockStorageInstance = new Storage();
    const mockBucket = mockStorageInstance.bucket();
    const mockFile = mockBucket.file();
    mockFile.save.mockResolvedValue(undefined);
    mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

    const result = await agentModeService.createKnowledgeBase(
      'Test Research',
      'Initial research content',
      'private',
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(true);
    expect(result.taskId).toBe('mock-uuid-123');
    expect(result.name).toBe('Test Research');
    expect(result.message).toContain('Test Research');

    expect(mockTaskDb.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'mock-uuid-123',
        userId: 'user-123',
        name: 'Test Research',
        useKnowledgeBase: true,
        updateKnowledgeBase: true,
        knowledgeBaseType: 'private',
      })
    );
  });

  it('should return error when name is empty', async () => {
    const result = await agentModeService.createKnowledgeBase(
      '',
      'Some content',
      'private',
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid input: empty name');
    expect(mockTaskDb.createTask).not.toHaveBeenCalled();
  });

  it('should return error when content is empty', async () => {
    const result = await agentModeService.createKnowledgeBase(
      'Test KB',
      '',
      'private',
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid input: empty content');
    expect(mockTaskDb.createTask).not.toHaveBeenCalled();
  });

  it('should return error when content exceeds size limit', async () => {
    const largeContent = 'x'.repeat(11 * 1024 * 1024); // 11MB

    const result = await agentModeService.createKnowledgeBase(
      'Large KB',
      largeContent,
      'private',
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Content exceeds size limit');
    expect(mockTaskDb.createTask).not.toHaveBeenCalled();
  });

  it('should use public bucket for public knowledge base type', async () => {
    mockTaskDb.createTask.mockResolvedValue({});
    mockTaskDb.updateTask.mockResolvedValue({});

    const mockStorageInstance = new Storage();
    const mockBucket = mockStorageInstance.bucket();
    const mockFile = mockBucket.file();
    mockFile.save.mockResolvedValue(undefined);
    mockFile.getSignedUrl.mockResolvedValue(['https://example.com/public-url']);

    const result = await agentModeService.createKnowledgeBase(
      'Public Research',
      'Public content',
      'public',
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(true);

    expect(mockTaskDb.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseType: 'public',
      })
    );
  });

  it('should handle GCS upload failure gracefully', async () => {
    mockTaskDb.createTask.mockResolvedValue({});

    const mockStorageInstance = new Storage();
    const mockBucket = mockStorageInstance.bucket();
    const mockFile = mockBucket.file();
    mockFile.save.mockRejectedValue(new Error('GCS upload failed'));

    const result = await agentModeService.createKnowledgeBase(
      'Test KB',
      'Some content',
      'private',
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Failed to create knowledge base');
    expect(result.error).toBe('GCS upload failed');
  });
});
