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

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();

    // Setup Storage mocks
    mockFile = {
      exists: jest.fn(),
      download: jest.fn(),
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
        const tool = tools.find(
          (t: any) => t.function?.name === 'list_knowledge_base_files'
        );

        expect(tool).toBeDefined();
        expect(tool?.function?.name).toBe('list_knowledge_base_files');
      });

      it('should have correct tool description', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find(
          (t: any) => t.function?.name === 'list_knowledge_base_files'
        );

        expect(tool?.function?.description).toContain('List all available knowledge base files');
        expect(tool?.function?.description).toContain('unique identifiers');
      });

      it('should have no required parameters', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find(
          (t: any) => t.function?.name === 'list_knowledge_base_files'
        );

        expect(tool?.function?.parameters?.required).toEqual([]);
      });
    });

    describe('listKnowledgeBaseFiles method', () => {
      it('should return empty list when user has no knowledge base files', async () => {
        mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue([]);

        const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');

        expect(result.success).toBe(true);
        expect(result.message).toBe('No knowledge base files found');
        expect(result.files).toEqual([]);
        expect(result.totalFiles).toBe(0);
        expect(mockedTaskDb.getTasksWithKnowledgeBase).toHaveBeenCalledWith('user-123');
      });

      it('should return list of knowledge base files', async () => {
        const mockTasks = [
          {
            taskId: 'task-1',
            name: 'Task 1',
            knowledgeBaseSize: 1024,
            knowledgeBaseType: 'private',
            knowledgeBaseUpdatedAt: '2024-01-01T00:00:00Z'
          },
          {
            taskId: 'task-2',
            name: 'Task 2',
            knowledgeBaseSize: 2048,
            knowledgeBaseType: 'public',
            knowledgeBaseUpdatedAt: '2024-01-02T00:00:00Z'
          }
        ];

        mockedTaskDb.getTasksWithKnowledgeBase.mockResolvedValue(mockTasks as any);

        const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');

        expect(result.success).toBe(true);
        expect(result.files).toHaveLength(2);
        expect(result.files[0]).toEqual({
          file_identifier: 'task-1',
          name: 'Task 1',
          size: 1024,
          type: 'private',
          updatedAt: '2024-01-01T00:00:00Z'
        });
        expect(result.files[1]).toEqual({
          file_identifier: 'task-2',
          name: 'Task 2',
          size: 2048,
          type: 'public',
          updatedAt: '2024-01-02T00:00:00Z'
        });
        expect(result.totalFiles).toBe(2);
      });

      it('should handle errors gracefully', async () => {
        mockedTaskDb.getTasksWithKnowledgeBase.mockRejectedValue(new Error('Database error'));

        const result = await (agentModeService as any).listKnowledgeBaseFiles('user-123');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to list knowledge base files');
        expect(result.error).toBe('Database error');
      });
    });
  });

  describe('read_knowledge_base_file', () => {
    describe('Tool Definition', () => {
      it('should include read_knowledge_base_file in available tools', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find(
          (t: any) => t.function?.name === 'read_knowledge_base_file'
        );

        expect(tool).toBeDefined();
        expect(tool?.function?.name).toBe('read_knowledge_base_file');
      });

      it('should have correct tool description', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find(
          (t: any) => t.function?.name === 'read_knowledge_base_file'
        );

        expect(tool?.function?.description).toContain('Read a knowledge base file');
        expect(tool?.function?.description).toContain('unique identifier');
      });

      it('should have file_identifier as required parameter', () => {
        const tools = agentModeService.getAvailableTools();
        const tool = tools.find(
          (t: any) => t.function?.name === 'read_knowledge_base_file'
        );

        expect(tool?.function?.parameters?.required).toContain('file_identifier');
        expect(tool?.function?.parameters?.properties?.file_identifier?.type).toBe('string');
        expect(tool?.function?.parameters?.properties?.file_identifier?.description).toContain('unique identifier');
      });
    });

    describe('readKnowledgeBaseFile method', () => {
      it('should return error when file_identifier is missing', async () => {
        const result = await (agentModeService as any).readKnowledgeBaseFile('', 'user-123');

        expect(result.success).toBe(false);
        expect(result.message).toBe('File identifier is required');
      });

      it('should return error when task not found', async () => {
        mockedTaskDb.getTaskById.mockResolvedValue(null);

        const result = await (agentModeService as any).readKnowledgeBaseFile('invalid-id', 'user-123');

        expect(result.success).toBe(false);
        expect(result.message).toContain('not found');
        expect(mockedTaskDb.getTaskById).toHaveBeenCalledWith('invalid-id');
      });

      it('should return error when user is not authorized', async () => {
        const mockTask = {
          taskId: 'task-1',
          userId: 'other-user',
          name: 'Task 1',
          knowledgeBaseSize: 1024
        };

        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);

        const result = await (agentModeService as any).readKnowledgeBaseFile('task-1', 'user-123');

        expect(result.success).toBe(false);
        expect(result.message).toBe('Not authorized to access this knowledge base file');
      });

      it('should return error when knowledge base is empty', async () => {
        const mockTask = {
          taskId: 'task-1',
          userId: 'user-123',
          name: 'Task 1',
          knowledgeBaseSize: 0
        };

        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);

        const result = await (agentModeService as any).readKnowledgeBaseFile('task-1', 'user-123');

        expect(result.success).toBe(false);
        expect(result.message).toContain('empty or does not exist');
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

        const result = await (agentModeService as any).readKnowledgeBaseFile('task-1', 'user-123');

        expect(result.success).toBe(false);
        expect(result.message).toContain('not found in storage');
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

        const result = await (agentModeService as any).readKnowledgeBaseFile('task-1', 'user-123');

        expect(result.success).toBe(true);
        expect(result.message).toContain('Successfully read');
        expect(result.file_identifier).toBe('task-1');
        expect(result.name).toBe('Task 1');
        expect(result.content).toBe('Test knowledge base content');
        expect(result.size).toBe(1024);
        expect(result.type).toBe('private');
        expect(mockBucket.file).toHaveBeenCalledWith('tasks/task-1/knowledge-base.txt');
      });

      it('should use public bucket when knowledgeBaseType is public', async () => {
        const mockTask = {
          taskId: 'task-1',
          userId: 'user-123',
          name: 'Task 1',
          knowledgeBaseSize: 1024,
          knowledgeBaseType: 'public'
        };

        const mockContent = Buffer.from('Test content');

        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
        mockFile.exists.mockResolvedValue([true]);
        mockFile.download.mockResolvedValue([mockContent]);

        await (agentModeService as any).readKnowledgeBaseFile('task-1', 'user-123');

        const storageInstance = mockedStorage.mock.results[0].value;
        expect(storageInstance.bucket).toHaveBeenCalledWith('test-bucket');
      });

      it('should truncate content when it exceeds 50KB limit', async () => {
        const mockTask = {
          taskId: 'task-1',
          userId: 'user-123',
          name: 'Task 1',
          knowledgeBaseSize: 60000,
          knowledgeBaseType: 'private'
        };

        // Create content larger than 50KB
        const largeContent = 'x'.repeat(60000);
        const mockContent = Buffer.from(largeContent);

        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
        mockFile.exists.mockResolvedValue([true]);
        mockFile.download.mockResolvedValue([mockContent]);

        const result = await (agentModeService as any).readKnowledgeBaseFile('task-1', 'user-123');

        expect(result.success).toBe(true);
        expect(result.content.length).toBe(50000 + '\n\n[Content truncated due to size limit]'.length);
        expect(result.content).toContain('[Content truncated due to size limit]');
      });

      it('should handle errors gracefully', async () => {
        const mockTask = {
          taskId: 'task-1',
          userId: 'user-123',
          name: 'Task 1',
          knowledgeBaseSize: 1024,
          knowledgeBaseType: 'private'
        };

        mockedTaskDb.getTaskById.mockResolvedValue(mockTask as any);
        mockFile.exists.mockRejectedValue(new Error('Storage error'));

        const result = await (agentModeService as any).readKnowledgeBaseFile('task-1', 'user-123');

        expect(result.success).toBe(false);
        expect(result.message).toContain('Failed to read knowledge base file');
        expect(result.error).toBe('Storage error');
      });
    });
  });

  describe('Mock responses', () => {
    it('should return correct mock response for list_knowledge_base_files', () => {
      const mockResponse = (agentModeService as any).getMockToolResult('list_knowledge_base_files', {});

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.files).toHaveLength(2);
      expect(mockResponse.files[0]).toHaveProperty('file_identifier');
      expect(mockResponse.files[0]).toHaveProperty('name');
      expect(mockResponse.files[0]).toHaveProperty('size');
      expect(mockResponse.files[0]).toHaveProperty('type');
      expect(mockResponse.files[0]).toHaveProperty('updatedAt');
      expect(mockResponse.totalFiles).toBe(2);
    });

    it('should return correct mock response for read_knowledge_base_file', () => {
      const mockResponse = (agentModeService as any).getMockToolResult('read_knowledge_base_file', {
        file_identifier: 'test-id'
      });

      expect(mockResponse.success).toBe(true);
      expect(mockResponse.file_identifier).toBe('test-id');
      expect(mockResponse.name).toBe('Mock Product Specifications');
      expect(mockResponse.content).toContain('mock knowledge base content');
      expect(mockResponse.size).toBe(1024);
      expect(mockResponse.type).toBe('private');
    });
  });
});

