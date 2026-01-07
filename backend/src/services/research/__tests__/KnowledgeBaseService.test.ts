
import { KnowledgeBaseService } from '../KnowledgeBaseService';
import { taskDb } from '../../db';
import { searchPlatformKnowledgeBase } from '../../chatbotService';

// Mock dependencies
jest.mock('../../db', () => ({
  taskDb: {
    getTasksWithKnowledgeBase: jest.fn(),
    getTaskById: jest.fn()
  }
}));

jest.mock('../../chatbotService', () => ({
  searchPlatformKnowledgeBase: jest.fn()
}));

jest.mock('../../../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn().mockResolvedValue('mock-private-key')
}));

jest.mock('@google-cloud/storage', () => {
  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue({
        file: jest.fn().mockReturnValue({
          exists: jest.fn().mockResolvedValue([true]),
          download: jest.fn().mockResolvedValue([Buffer.from('file content')]),
          getMetadata: jest.fn().mockResolvedValue([{ contentType: 'text/plain' }])
        })
      })
    }))
  };
});

describe('KnowledgeBaseService', () => {
  let service: KnowledgeBaseService;

  beforeEach(() => {
    service = new KnowledgeBaseService();
    jest.clearAllMocks();
  });

  describe('searchKnowledgeBase', () => {
    it('should search and return mapped results', async () => {
      (searchPlatformKnowledgeBase as jest.Mock).mockResolvedValue([
        { content: 'test content', metadata: { source: 'test.txt' } }
      ]);

      const result = await service.searchKnowledgeBase('query', 5, 'user1');

      expect(searchPlatformKnowledgeBase).toHaveBeenCalledWith('query', 5, 'user1');
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].content).toBe('test content');
    });
  });

  describe('listKnowledgeBaseFiles', () => {
    it('should list files from tasks', async () => {
      (taskDb.getTasksWithKnowledgeBase as jest.Mock).mockResolvedValue([
        {
          taskId: 'task1',
          name: 'Task 1',
          knowledgeBaseSize: 100,
          knowledgeBaseFiles: [{ filename: 'file1.txt', size: 50 }]
        }
      ]);

      const result = await service.listKnowledgeBaseFiles('user1');

      expect(taskDb.getTasksWithKnowledgeBase).toHaveBeenCalledWith('user1');
      expect(result.success).toBe(true);
      expect(result.knowledge_bases).toHaveLength(1);
      expect(result.knowledge_bases[0].files).toHaveLength(2); // default + file1
    });
  });
});
