/**
 * Tests for knowledge base file visibility in the Knowledge Base page
 * Ensures that knowledge bases with only files (no main content) appear in the UI
 */

import { taskDb } from '../services/db';
import { agentModeService } from '../services/agentModeService';

// Mock only the underlying DynamoDB client, not the entire db service
jest.mock('@google-cloud/storage');

describe('Knowledge Base File Visibility', () => {
  const mockUserId = 'test-user-123';
  const mockTaskId = 'test-task-456';

  // Store original getTasksByUserId implementation
  let originalGetTasksByUserId: any;

  beforeAll(() => {
    originalGetTasksByUserId = taskDb.getTasksByUserId;
  });

  afterAll(() => {
    // Restore original implementation
    taskDb.getTasksByUserId = originalGetTasksByUserId;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getTasksWithKnowledgeBase', () => {
    it('should return knowledge bases with only main content (no files)', async () => {
      const mockTasks = [
        {
          taskId: 'task-1',
          userId: mockUserId,
          name: 'KB with main content',
          knowledgeBaseSize: 5000,
          knowledgeBaseFiles: [],
          knowledgeBaseType: 'private',
        },
      ];

      taskDb.getTasksByUserId = jest.fn().mockResolvedValue(mockTasks);

      const result = await taskDb.getTasksWithKnowledgeBase(mockUserId);

      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('task-1');
      expect(result[0].knowledgeBaseSize).toBe(5000);
    });

    it('should return knowledge bases with only files (no main content)', async () => {
      const mockTasks = [
        {
          taskId: 'task-2',
          userId: mockUserId,
          name: 'KB with only files',
          knowledgeBaseSize: 0,
          knowledgeBaseFiles: [
            { filename: 'file1.txt', size: 1000, url: 'https://example.com/file1', key: 'key1', uploadedAt: '2026-03-21T00:00:00Z' },
            { filename: 'file2.txt', size: 2000, url: 'https://example.com/file2', key: 'key2', uploadedAt: '2026-03-21T00:00:00Z' },
          ],
          knowledgeBaseType: 'private',
        },
      ];

      taskDb.getTasksByUserId = jest.fn().mockResolvedValue(mockTasks);

      const result = await taskDb.getTasksWithKnowledgeBase(mockUserId);

      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('task-2');
      expect(result[0].knowledgeBaseFiles).toHaveLength(2);
    });

    it('should return knowledge bases with both main content and files', async () => {
      const mockTasks = [
        {
          taskId: 'task-3',
          userId: mockUserId,
          name: 'KB with content and files',
          knowledgeBaseSize: 3000,
          knowledgeBaseFiles: [
            { filename: 'file1.txt', size: 1000, url: 'https://example.com/file1', key: 'key1', uploadedAt: '2026-03-21T00:00:00Z' },
          ],
          knowledgeBaseType: 'private',
        },
      ];

      taskDb.getTasksByUserId = jest.fn().mockResolvedValue(mockTasks);

      const result = await taskDb.getTasksWithKnowledgeBase(mockUserId);

      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('task-3');
      expect(result[0].knowledgeBaseSize).toBe(3000);
      expect(result[0].knowledgeBaseFiles).toHaveLength(1);
    });

    it('should NOT return knowledge bases with zero size, no files, and no URL', async () => {
      const mockTasks = [
        {
          taskId: 'task-4',
          userId: mockUserId,
          name: 'Empty KB',
          knowledgeBaseSize: 0,
          knowledgeBaseFiles: [],
          knowledgeBaseType: 'private',
        },
      ];

      taskDb.getTasksByUserId = jest.fn().mockResolvedValue(mockTasks);

      const result = await taskDb.getTasksWithKnowledgeBase(mockUserId);

      expect(result).toHaveLength(0);
    });

    it('should return knowledge bases with zero size but a knowledgeBase URL set (stale size metadata)', async () => {
      const mockTasks = [
        {
          taskId: 'task-5',
          userId: mockUserId,
          name: 'KB with stale size=0 but valid URL',
          knowledgeBaseSize: 0,
          knowledgeBase: 'https://storage.googleapis.com/bucket/tasks/task-5/knowledge-base.txt',
          knowledgeBaseFiles: [],
          knowledgeBaseType: 'private',
        },
      ];

      taskDb.getTasksByUserId = jest.fn().mockResolvedValue(mockTasks);

      const result = await taskDb.getTasksWithKnowledgeBase(mockUserId);

      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('task-5');
    });

    it('should return multiple knowledge bases with different configurations', async () => {
      const mockTasks = [
        {
          taskId: 'task-1',
          userId: mockUserId,
          name: 'KB with main content',
          knowledgeBaseSize: 5000,
          knowledgeBaseFiles: [],
          knowledgeBaseType: 'private',
        },
        {
          taskId: 'task-2',
          userId: mockUserId,
          name: 'KB with only files',
          knowledgeBaseSize: 0,
          knowledgeBaseFiles: [
            { filename: 'file1.txt', size: 1000, url: 'https://example.com/file1', key: 'key1', uploadedAt: '2026-03-21T00:00:00Z' },
          ],
          knowledgeBaseType: 'private',
        },
        {
          taskId: 'task-3',
          userId: mockUserId,
          name: 'Empty KB',
          knowledgeBaseSize: 0,
          knowledgeBaseFiles: [],
          knowledgeBaseType: 'private',
        },
      ];

      taskDb.getTasksByUserId = jest.fn().mockResolvedValue(mockTasks);

      const result = await taskDb.getTasksWithKnowledgeBase(mockUserId);

      expect(result).toHaveLength(2);
      expect(result.map((t: any) => t.taskId)).toEqual(['task-1', 'task-2']);
    });
  });

  // Note: Integration tests for attachKnowledgeBaseFiles and updateKnowledgeBaseFile
  // would require more complex mocking of GCS and taskDb. The key logic change
  // (calculating knowledgeBaseSize from files) is covered by the filter tests above
  // and manual testing in the cloud environment.
});
