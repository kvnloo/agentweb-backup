import { AgentModeService } from '../services/agentModeService';

jest.mock('../services/db', () => ({
  taskDb: {
    getTaskById: jest.fn(),
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

describe('AgentModeService - attachKnowledgeBaseFiles', () => {
  let agentModeService: AgentModeService;
  const mockTaskDb = require('../services/db').taskDb;
  const { Storage } = require('@google-cloud/storage');

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  it('should attach a single file successfully', async () => {
    mockTaskDb.getTaskById.mockResolvedValue({
      taskId: 'task-123',
      userId: 'user-123',
      knowledgeBaseType: 'private',
      knowledgeBaseFiles: [],
    });
    mockTaskDb.updateTask.mockResolvedValue({});

    const mockStorageInstance = new Storage();
    const mockBucket = mockStorageInstance.bucket();
    const mockFile = mockBucket.file();
    mockFile.save.mockResolvedValue(undefined);
    mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      [{ name: 'research.txt', content: 'Research data' }],
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('research.txt');
    expect(result.message).toContain('1 file(s)');

    expect(mockTaskDb.updateTask).toHaveBeenCalledWith(
      'task-123',
      expect.objectContaining({
        knowledgeBaseFiles: expect.arrayContaining([
          expect.objectContaining({
            filename: 'research.txt',
          })
        ]),
      })
    );
  });

  it('should attach multiple files successfully', async () => {
    mockTaskDb.getTaskById.mockResolvedValue({
      taskId: 'task-123',
      userId: 'user-123',
      knowledgeBaseType: 'private',
      knowledgeBaseFiles: [],
    });
    mockTaskDb.updateTask.mockResolvedValue({});

    const mockStorageInstance = new Storage();
    const mockBucket = mockStorageInstance.bucket();
    const mockFile = mockBucket.file();
    mockFile.save.mockResolvedValue(undefined);
    mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

    const files = [
      { name: 'file1.txt', content: 'Content 1' },
      { name: 'file2.txt', content: 'Content 2' },
      { name: 'file3.txt', content: 'Content 3' },
    ];

    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      files,
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(3);
    expect(result.message).toContain('3 file(s)');
  });

  it('should return error when task not found', async () => {
    mockTaskDb.getTaskById.mockResolvedValue(null);

    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      [{ name: 'file.txt', content: 'content' }],
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

    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      [{ name: 'file.txt', content: 'content' }],
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('Not authorized to modify this task');
    expect(mockTaskDb.updateTask).not.toHaveBeenCalled();
  });

  it('should return error when files array is empty', async () => {
    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      [],
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid input: empty files array');
  });

  it('should return error when a file has empty content', async () => {
    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      [{ name: 'empty.txt', content: '' }],
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid input: empty file content');
    expect(result.error).toContain('"content"');
  });

  it('should append to existing knowledgeBaseFiles array', async () => {
    const existingFiles = [
      {
        filename: 'existing.txt',
        size: 50,
        url: 'https://example.com/existing-url',
        key: 'tasks/task-123/knowledge-base-files/old_existing.txt',
        uploadedAt: '2026-01-01T00:00:00.000Z',
      }
    ];

    mockTaskDb.getTaskById.mockResolvedValue({
      taskId: 'task-123',
      userId: 'user-123',
      knowledgeBaseType: 'private',
      knowledgeBaseFiles: existingFiles,
    });
    mockTaskDb.updateTask.mockResolvedValue({});

    const mockStorageInstance = new Storage();
    const mockBucket = mockStorageInstance.bucket();
    const mockFile = mockBucket.file();
    mockFile.save.mockResolvedValue(undefined);
    mockFile.getSignedUrl.mockResolvedValue(['https://example.com/new-url']);

    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      [{ name: 'new-file.txt', content: 'New content' }],
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(true);

    // Should include both existing and new files
    const updateCall = mockTaskDb.updateTask.mock.calls[0];
    const updatedFiles = updateCall[1].knowledgeBaseFiles;
    expect(updatedFiles).toHaveLength(2);
    expect(updatedFiles[0].filename).toBe('existing.txt');
    expect(updatedFiles[1].filename).toBe('new-file.txt');
  });
  it.each(['fileName', 'file_name', 'filename'])(
    'should accept "%s" as the file name key (ENG-2350)',
    async (key) => {
      mockTaskDb.getTaskById.mockResolvedValue({
        taskId: 'task-123',
        userId: 'user-123',
        knowledgeBaseType: 'private',
        knowledgeBaseFiles: [],
      });
      mockTaskDb.updateTask.mockResolvedValue({});

      const mockFile = new Storage().bucket().file();
      mockFile.save.mockResolvedValue(undefined);
      mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

      const result = await agentModeService.attachKnowledgeBaseFiles(
        'task-123',
        [{ [key]: 'design.md', content: '# Design' }],
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(mockTaskDb.updateTask.mock.calls[0][1].knowledgeBaseFiles[0].filename).toBe('design.md');
    }
  );

  it('should return an actionable error when a file has no name (ENG-2350)', async () => {
    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      [{ content: 'some content' }],
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    // `error` is the field the model sees (toolResultError prefers it over `message`).
    expect(result.error).toContain('missing "name"');
    expect(result.error).toContain('"content"');
    expect(mockTaskDb.updateTask).not.toHaveBeenCalled();
  });

  it('should reject the whole batch, uploading nothing, when a later file has no name (ENG-2350)', async () => {
    const mockFile = new Storage().bucket().file();

    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      [{ name: 'ok.md', content: 'fine' }, { content: 'nameless' }],
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('file #2');
    expect(mockFile.save).not.toHaveBeenCalled();
    expect(mockTaskDb.updateTask).not.toHaveBeenCalled();
  });

  it('should fall back to fileName when name is an empty string (ENG-2350)', async () => {
    mockTaskDb.getTaskById.mockResolvedValue({ taskId: 'task-123', userId: 'user-123', knowledgeBaseFiles: [] });
    mockTaskDb.updateTask.mockResolvedValue({});
    const mockFile = new Storage().bucket().file();
    mockFile.save.mockResolvedValue(undefined);
    mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      [{ name: '', fileName: 'design.md', content: '# Design' }],
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(true);
    expect(result.files[0].name).toBe('design.md');
  });

  it('should report a missing name for a text-keyed file instead of crashing (ENG-2350)', async () => {
    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      [{ fileName: 'design.md', text: 'wrong key' }],
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('empty file content for "design.md"');
    expect(result.error).toContain('"content"');
  });

  it.each([
    ['a non-string content', [{ name: 'a.md', content: { nested: true } }]],
    ['a null entry', [null]],
    ['a string entry', ['design.md']],
  ])('should return a validation error, not a TypeError, for %s (ENG-2350)', async (_label, files) => {
    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      files,
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Invalid input: /);
    expect(mockTaskDb.updateTask).not.toHaveBeenCalled();
  });

  it('should accept files serialized as a JSON string (ENG-2350)', async () => {
    mockTaskDb.getTaskById.mockResolvedValue({ taskId: 'task-123', userId: 'user-123', knowledgeBaseFiles: [] });
    mockTaskDb.updateTask.mockResolvedValue({});
    const mockFile = new Storage().bucket().file();
    mockFile.save.mockResolvedValue(undefined);
    mockFile.getSignedUrl.mockResolvedValue(['https://example.com/signed-url']);

    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      JSON.stringify([{ file_name: 'design.md', content: '# Design' }]),
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(true);
    expect(result.files[0].name).toBe('design.md');
  });

  it('should return a clear error for files that is neither an array nor valid JSON (ENG-2350)', async () => {
    const result = await agentModeService.attachKnowledgeBaseFiles(
      'task-123',
      'not json',
      'user-123',
      'session-123'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('files must be an array');
  });
});
