// ENG-427: getTasksWithKnowledgeBase must keep the knowledgeBase signed URL

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

describe('ENG-427 getTasksWithKnowledgeBase signed URL', () => {
  it('returns the stored knowledgeBase signed URL, and null when absent', async () => {
    queryPromiseMock.mockResolvedValue({
      Items: [
        { taskId: 't1', userId: 'u1', name: 'Private KB', knowledgeBaseSize: 10,
          knowledgeBase: 'https://storage.example/kb.txt?sig=abc', updatedAt: '2026-10-01T00:00:00Z' },
        { taskId: 't2', userId: 'u1', name: 'Files only',
          knowledgeBaseFiles: [{ filename: 'a.pdf', size: 3, url: 'https://storage.example/a.pdf' }],
          updatedAt: '2026-09-01T00:00:00Z' },
      ],
    });
    const res: any[] = await taskDb.getTasksWithKnowledgeBase('u1');
    expect(res.find((t) => t.taskId === 't1').knowledgeBase).toBe('https://storage.example/kb.txt?sig=abc');
    const t2 = res.find((t) => t.taskId === 't2');
    expect(t2.knowledgeBase).toBeNull();
    expect(t2.knowledgeBaseFiles[0].url).toBe('https://storage.example/a.pdf');
  });
});
