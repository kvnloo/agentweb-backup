import { AgentModeService } from '../services/agentModeService';
import { taskDb } from '../services/db';
import { Storage } from '@google-cloud/storage';
import { getGCSPPrivateKey } from '../utils/secretsManager';

// Mock dependencies
jest.mock('../services/db');
jest.mock('@google-cloud/storage');
jest.mock('../utils/secretsManager');

const mockedTaskDb = taskDb as jest.Mocked<typeof taskDb>;
const mockedStorage = Storage as jest.MockedClass<typeof Storage>;
const mockedGetGCSPPrivateKey = getGCSPPrivateKey as jest.MockedFunction<typeof getGCSPPrivateKey>;

describe('AgentModeService - Knowledge Base Files', () => {
  let agentModeService: AgentModeService;
  let mockBucket: any;
  let mockFile: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    await agentModeService.initialize();

    // Setup Storage mocks
    mockFile = {
      exists: jest.fn(),
      download: jest.fn(),
      getMetadata: jest.fn().mockResolvedValue([{ contentType: 'text/plain' }])
    };

    mockBucket = {
      file: jest.fn().mockReturnValue(mockFile),
    };

    const mockStorageInstance = {
      bucket: jest.fn().mockReturnValue(mockBucket),
    };

    mockedStorage.mockImplementation(() => mockStorageInstance as any);
    mockedGetGCSPPrivateKey.mockResolvedValue('mock-private-key');

    process.env.GCS_PROJECT_ID = 'test-project';
    process.env.GCS_CLIENT_EMAIL = 'test@example.com';
    process.env.GCS_BUCKET_NAME = 'test-bucket';
    process.env.GCS_BUCKET_NAME_PRIVATE = 'test-bucket-private';
  });

  describe('list_knowledge_base_files', () => {
    describe('Tool Definition', () => {
      it('should include list_knowledge_base_files in available tools', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find((t: any) => t.function?.name === 'list_knowledge_base_files');
        expect(tool).toBeDefined();
        expect(tool?.function?.name).toBe('list_knowledge_base_files');
      });

      it('should have correct tool description', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find((t: any) => t.function?.name === 'list_knowledge_base_files');
        expect(tool?.function?.description).toContain('List available knowledge base files');
      });

      it('should have no required parameters', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find((t: any) => t.function?.name === 'list_knowledge_base_files');
        expect(tool?.function?.parameters?.required).toEqual([]);
      });
    });

    describe('listKnowledgeBaseFiles method', () => {
      it('should return empty list when user has no knowledge bases', async () => {
        mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
        mockedTaskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);

        const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');

        expect(result.success).toBe(true);
        expect(result.message).toBe('No knowledge bases found');
        expect(result.knowledge_bases).toEqual([]);
        expect(result.totalFiles).toBe(0);
        expect(result.totalKnowledgeBases).toBe(0);
        expect(mockedTaskDb.getTasksWithKnowledgeBase).toHaveBeenCalledWith('user-123');
      });

      it('should return list of knowledge bases with files', async () => {
        const mockUserTasks = [
          {
            taskId: 'task-1',
            name: 'Task 1',
            knowledgeBaseSize: 1024,
            knowledgeBaseType: 'private',
            knowledgeBaseUpdatedAt: '2024-01-01T00:00:00Z',
            knowledgeBase: 'https://example.com/knowledge-base.txt',
            knowledgeBaseFiles: [{ filename: 'file1.pdf', size: 256, url: 'https://example.com/file1.pdf' }]
          }
        ];

        const mockPublicTasks = [
          {
            taskId: 'task-2',
            name: 'Task 2',
            knowledgeBaseSize: 2048,
            knowledgeBaseType: 'public',
            knowledgeBaseUpdatedAt: '2024-01-02T00:00:00Z',
            knowledgeBase: 'https://example.com/task-2/knowledge-base.txt',
            knowledgeBaseFiles: []
          }
        ];

        mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue(mockUserTasks as any);
        mockedTaskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue(mockPublicTasks as any);

        const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');

        expect(result.success).toBe(true);
        expect(result.knowledge_bases).toHaveLength(2);
        expect(result.knowledge_bases[0]).toMatchObject({
          identifier: 'task-1',
          name: 'Task 1',
          type: 'private',
          updatedAt: '2024-01-01T00:00:00Z'
        });
        expect(result.knowledge_bases[0].files).toEqual([
          { fileName: 'knowledge-base.txt', fileSize: 1024, url: 'https://example.com/knowledge-base.txt' },
          { fileName: 'file1.pdf', fileSize: 256, url: 'https://example.com/file1.pdf' }
        ]);
        expect(result.knowledge_bases[1].files).toEqual([
          { fileName: 'knowledge-base.txt', fileSize: 2048, url: 'https://example.com/task-2/knowledge-base.txt' }
        ]);
        expect(result.totalFiles).toBe(3);
        expect(result.totalKnowledgeBases).toBe(2);
      });

      it('should handle errors gracefully', async () => {
        mockedTaskDb.getTasksWithKnowledgeBase.mockRejectedValue(new Error('Database error'));
        mockedTaskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);

        const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to list knowledge base files');
        expect(result.error).toBe('Database error');
      });

      it('should skip platform KBs when kb_type=google-drive is specified', async () => {
        mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue([
          { taskId: 'task-1', name: 'Task 1', knowledgeBaseType: 'private', knowledgeBaseSize: 100, knowledgeBaseFiles: [] }
        ] as any);
        mockedTaskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);

        const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123', { kb_type: 'google-drive' });

        expect(result.success).toBe(true);
        // Platform KBs should be excluded (only gdrive, but none configured here)
        expect(result.knowledge_bases).toHaveLength(0);
        expect(result.appliedFilters).toContain('kb_type=google-drive');
      });

      it('should include appliedFilters in response when options provided', async () => {
        mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
        mockedTaskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);

        const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123', {
          modified_after: '2026-04-15',
          modified_before: '2026-04-22',
          limit: 10,
          offset: 0,
        });

        expect(result.success).toBe(true);
        expect(result.appliedFilters).toContain('modified_after=2026-04-15');
        expect(result.appliedFilters).toContain('modified_before=2026-04-22');
        expect(result.appliedFilters).toContain('limit=10');
        expect(result.appliedFilters).toContain('offset=0');
      });

      it('should include no appliedFilters in response when no options provided', async () => {
        mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);
        mockedTaskDb.getAllPublicKnowledgeBaseTasks.mockResolvedValue([]);

        const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');

        expect(result.success).toBe(true);
        expect(result.appliedFilters).toBeUndefined();
      });

      it('tool definition should have date filter and pagination parameters', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find((t: any) => t.function?.name === 'list_knowledge_base_files');
        expect(tool).toBeDefined();
        const props = tool?.function?.parameters?.properties;
        expect(props?.modified_after).toBeDefined();
        expect(props?.modified_before).toBeDefined();
        expect(props?.limit).toBeDefined();
        expect(props?.offset).toBeDefined();
        expect(props?.kb_type).toBeDefined();
        // No required parameters
        expect(tool?.function?.parameters?.required).toEqual([]);
      });
    });
  });

  describe('read_knowledge_base_files', () => {
    describe('Tool Definition', () => {
      it('should include read_knowledge_base_files in available tools', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find(
          (t: any) => t.function?.name === 'read_knowledge_base_files'
        );

        expect(tool).toBeDefined();
        expect(tool?.function?.name).toBe('read_knowledge_base_files');
      });

      it('should have correct tool description', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find(
          (t: any) => t.function?.name === 'read_knowledge_base_files'
        );

        expect(tool?.function?.description).toContain('Read one or more knowledge base files');
      });

      it('should require files array parameter', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find(
          (t: any) => t.function?.name === 'read_knowledge_base_files'
        );

        expect(tool?.function?.parameters?.required).toContain('files');
        expect(tool?.function?.parameters?.properties?.files?.type).toBe('array');
      });
    });

    describe('readKnowledgeBaseFiles method', () => {
      it('should return error when files array missing', async () => {
        const result = await (agentModeService as any).readKnowledgeBaseFiles([], 'user-123');
        expect(result.success).toBe(false);
        expect(result.message).toBe('files array is required');
      });

      it('should return error when task not found', async () => {
        mockedTaskDb.getTaskById.mockResolvedValue(undefined);
        const result = await (agentModeService as any).readKnowledgeBaseFiles(
          [{ kb_identifier: 'invalid-id', file_name: 'knowledge-base.txt' }],
          'user-123'
        );
        expect(result.success).toBe(true);
        expect(result.files[0].success).toBe(false);
        expect(result.files[0].message).toContain('not found');
        expect(mockedTaskDb.getTaskById).toHaveBeenCalledWith('invalid-id');
      });

      it('should return error when user is not authorized for private knowledge base', async () => {
        const mockTask = { taskId: 'task-1', userId: 'other-user', name: 'Task 1', knowledgeBaseSize: 1024, knowledgeBaseType: 'private' };
        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);

        const result = await (agentModeService as any).readKnowledgeBaseFiles(
          [{ kb_identifier: 'task-1', file_name: 'knowledge-base.txt' }],
          'user-123'
        );
        expect(result.files[0].success).toBe(false);
        expect(result.files[0].message).toBe('Not authorized to access this knowledge base file');
      });

      it('should allow reading public knowledge base from other users', async () => {
        const mockTask = {
          taskId: 'task-1',
          userId: 'other-user',
          name: 'Task 1',
          knowledgeBaseSize: 1024,
          knowledgeBaseType: 'public',
          knowledgeBaseUpdatedAt: '2024-01-01T00:00:00Z'
        };
        const mockContent = Buffer.from('Public knowledge base content');
        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
        mockFile.exists.mockResolvedValue([true]);
        mockFile.download.mockResolvedValue([mockContent]);
        mockFile.getMetadata = jest.fn().mockResolvedValue([{ contentType: 'text/plain' }]);

        const result = await (agentModeService as any).readKnowledgeBaseFiles(
          [{ kb_identifier: 'task-1', file_name: 'knowledge-base.txt' }],
          'user-123'
        );

        expect(result.success).toBe(true);
        expect(result.files[0].success).toBe(true);
        expect(result.files[0].content).toBe('Public knowledge base content');
      });

      it('should return error when knowledge base is empty', async () => {
        const mockTask = { taskId: 'task-1', userId: 'user-123', name: 'Task 1', knowledgeBaseSize: 0 };
        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);

        const result = await (agentModeService as any).readKnowledgeBaseFiles(
          [{ kb_identifier: 'task-1', file_name: 'knowledge-base.txt' }],
          'user-123'
        );
        expect(result.files[0].success).toBe(false);
        expect(result.files[0].message).toContain('empty or does not exist');
      });

      it('should return error when file does not exist in storage', async () => {
        const mockTask = {
          taskId: 'task-1',
          userId: 'user-123',
          name: 'Task 1',
          knowledgeBaseSize: 1024,
          knowledgeBaseType: 'private'
        };
        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
        mockFile.exists.mockResolvedValue([false]);

        const result = await (agentModeService as any).readKnowledgeBaseFiles(
          [{ kb_identifier: 'task-1', file_name: 'knowledge-base.txt' }],
          'user-123'
        );
        expect(result.files[0].success).toBe(false);
        expect(result.files[0].message).toContain('not found in storage');
      });

      it('should successfully read knowledge base file', async () => {
        const mockTask = {
          taskId: 'task-1',
          userId: 'user-123',
          name: 'Task 1',
          knowledgeBaseSize: 1024,
          knowledgeBaseType: 'private',
          knowledgeBaseUpdatedAt: '2024-01-01T00:00:00Z'
        };
        const mockContent = Buffer.from('Test knowledge base content');
        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
        mockFile.exists.mockResolvedValue([true]);
        mockFile.download.mockResolvedValue([mockContent]);
        mockFile.getMetadata = jest.fn().mockResolvedValue([{ contentType: 'text/plain' }]);

        const result = await (agentModeService as any).readKnowledgeBaseFiles(
          [{ kb_identifier: 'task-1', file_name: 'knowledge-base.txt' }],
          'user-123'
        );

        expect(result.success).toBe(true);
        expect(result.files[0].success).toBe(true);
        expect(result.files[0].kb_identifier).toBe('task-1');
        expect(result.files[0].file_name).toBe('knowledge-base.txt');
        expect(result.files[0].content).toBe('Test knowledge base content');
        expect(mockBucket.file).toHaveBeenCalledWith('tasks/task-1/knowledge-base.txt');
      });

      it('should use public bucket when knowledgeBaseType is public', async () => {
        const mockTask = { taskId: 'task-1', userId: 'user-123', name: 'Task 1', knowledgeBaseSize: 1024, knowledgeBaseType: 'public' };
        const mockContent = Buffer.from('Test content');
        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
        mockFile.exists.mockResolvedValue([true]);
        mockFile.download.mockResolvedValue([mockContent]);
        mockFile.getMetadata = jest.fn().mockResolvedValue([{ contentType: 'text/plain' }]);

        await (agentModeService as any).readKnowledgeBaseFiles(
          [{ kb_identifier: 'task-1', file_name: 'knowledge-base.txt' }],
          'user-123'
        );

        const storageInstance = mockedStorage.mock.results[0].value;
        expect(storageInstance.bucket).toHaveBeenCalledWith('test-bucket');
      });

      it('should truncate content when it exceeds 1MB limit', async () => {
        const mockTask = { taskId: 'task-1', userId: 'user-123', name: 'Task 1', knowledgeBaseSize: 1100000, knowledgeBaseType: 'private' };
        const largeContent = 'x'.repeat(1100000);
        const mockContent = Buffer.from(largeContent);
        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
        mockFile.exists.mockResolvedValue([true]);
        mockFile.download.mockResolvedValue([mockContent]);
        mockFile.getMetadata = jest.fn().mockResolvedValue([{ contentType: 'text/plain' }]);

        const result = await (agentModeService as any).readKnowledgeBaseFiles(
          [{ kb_identifier: 'task-1', file_name: 'knowledge-base.txt' }],
          'user-123'
        );

        expect(result.success).toBe(true);
        expect(result.files[0].content.length).toBe(1_000_000 + '\n\n[Content truncated due to size limit]'.length);
        expect(result.files[0].content).toContain('[Content truncated due to size limit]');
      });

      it('should handle errors gracefully', async () => {
        const mockTask = { taskId: 'task-1', userId: 'user-123', name: 'Task 1', knowledgeBaseSize: 1024, knowledgeBaseType: 'private' };
        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
        mockFile.exists.mockRejectedValue(new Error('Storage error'));
        mockFile.getMetadata = jest.fn().mockResolvedValue([{ contentType: 'text/plain' }]);

        const result = await (agentModeService as any).readKnowledgeBaseFiles(
          [{ kb_identifier: 'task-1', file_name: 'knowledge-base.txt' }],
          'user-123'
        );

        expect(result.success).toBe(true);
        expect(result.files[0].success).toBe(false);
        expect(result.files[0].message).toContain('Failed to read knowledge base file');
      });
    });
  });

  describe('Mock responses', () => {
    it('should return correct mock response for list_knowledge_base_files', () => {
      const mockResponse = (agentModeService as any).getMockToolResult('list_knowledge_base_files', {});

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.knowledge_bases).toBeDefined();
      expect(mockResponse.totalFiles).toBeDefined();
    });

    it('should return correct mock response for read_knowledge_base_files', () => {
      const mockResponse = (agentModeService as any).getMockToolResult('read_knowledge_base_files', {
        files: [{ kb_identifier: 'test-id', file_name: 'knowledge-base.txt' }]
      });

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.files).toHaveLength(1);
      expect(mockResponse.files[0]).toHaveProperty('kb_identifier');
      expect(mockResponse.files[0]).toHaveProperty('file_name');
      expect(mockResponse.files[0]).toHaveProperty('content');
    });
  });
});
