// Tests for DynamoDB pagination in getTasksByUserId

const queryPromiseMock = jest.fn();

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: jest.fn(() => ({ promise: queryPromiseMock })),
      get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      delete: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      scan: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Items: [] }) })),
      batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

import { taskDb } from '../services/db';

describe('getTasksByUserId pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return all items from a single page', async () => {
    queryPromiseMock.mockResolvedValue({
      Items: [
        { taskId: 'task-1', userId: 'user-1', name: 'Task 1', status: 'active' },
        { taskId: 'task-2', userId: 'user-1', name: 'Task 2', status: 'active' },
      ],
    });

    const result = await taskDb.getTasksByUserId('user-1');

    expect(result).toHaveLength(2);
    expect(result![0].taskId).toBe('task-1');
    expect(result![1].taskId).toBe('task-2');
    // 1 call for tasks + 2 tasks × 3 detail queries (executions, schedules, subscribers)
    expect(queryPromiseMock).toHaveBeenCalled();
  });

  it('should paginate through multiple DynamoDB pages', async () => {
    // Page 1 - tasks query
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        { taskId: 'task-1', userId: 'user-1', name: 'Task 1', status: 'active' },
        { taskId: 'task-2', userId: 'user-1', name: 'Task 2', status: 'active' },
      ],
      LastEvaluatedKey: { taskId: 'task-2', userId: 'user-1' },
    });
    // Page 2 - tasks query
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        { taskId: 'task-3', userId: 'user-1', name: 'Task 3', status: 'active', knowledgeBaseSize: 1024 },
      ],
    });
    // All subsequent calls are detail queries (executions, schedules, subscribers) - return empty
    queryPromiseMock.mockResolvedValue({ Items: [] });

    const result = await taskDb.getTasksByUserId('user-1');

    expect(result).toHaveLength(3);
    expect(result![0].taskId).toBe('task-1');
    expect(result![1].taskId).toBe('task-2');
    expect(result![2].taskId).toBe('task-3');
  });

  it('should handle three pages of results', async () => {
    // Page 1
    queryPromiseMock.mockResolvedValueOnce({
      Items: [{ taskId: 'task-1', userId: 'user-1', name: 'T1', status: 'active' }],
      LastEvaluatedKey: { taskId: 'task-1', userId: 'user-1' },
    });
    // Page 2
    queryPromiseMock.mockResolvedValueOnce({
      Items: [{ taskId: 'task-2', userId: 'user-1', name: 'T2', status: 'active' }],
      LastEvaluatedKey: { taskId: 'task-2', userId: 'user-1' },
    });
    // Page 3
    queryPromiseMock.mockResolvedValueOnce({
      Items: [{ taskId: 'task-3', userId: 'user-1', name: 'T3', status: 'active' }],
    });
    // Detail queries
    queryPromiseMock.mockResolvedValue({ Items: [] });

    const result = await taskDb.getTasksByUserId('user-1');

    expect(result).toHaveLength(3);
    expect(result!.map(t => t.taskId)).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('should return empty array when no tasks exist', async () => {
    queryPromiseMock.mockResolvedValue({ Items: [] });

    const result = await taskDb.getTasksByUserId('user-no-tasks');

    expect(result).toHaveLength(0);
  });

  it('should include knowledge base tasks from later pages', async () => {
    // Simulates the Haven user scenario: KB tasks are on page 2
    queryPromiseMock.mockResolvedValueOnce({
      Items: Array.from({ length: 5 }, (_, i) => ({
        taskId: `task-${i}`, userId: 'user-1', name: `Task ${i}`, status: 'active',
      })),
      LastEvaluatedKey: { taskId: 'task-4', userId: 'user-1' },
    });
    queryPromiseMock.mockResolvedValueOnce({
      Items: [
        {
          taskId: 'kb-task', userId: 'user-1', name: 'Knowledge Base Task', status: 'active',
          knowledgeBaseSize: 1024, knowledgeBaseType: 'private',
          knowledgeBaseFiles: [{ filename: 'ad.jpg', size: 50000, url: 'https://s3/ad.jpg', key: 's3:ad.jpg', uploadedAt: '2026-01-01' }],
        },
      ],
    });
    // Detail queries
    queryPromiseMock.mockResolvedValue({ Items: [] });

    const result = await taskDb.getTasksByUserId('user-1');

    expect(result).toHaveLength(6);
    const kbTask = result!.find(t => t.taskId === 'kb-task');
    expect(kbTask).toBeDefined();
    expect(kbTask!.knowledgeBaseSize).toBe(1024);
    expect(kbTask!.knowledgeBaseFiles).toHaveLength(1);
  });
});
