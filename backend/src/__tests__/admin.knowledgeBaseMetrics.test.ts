import request from 'supertest';
import express from 'express';
import adminRoutes from '../routes/admin';
import { taskDb } from '../services/db';

jest.mock('../services/db', () => ({
  taskDb: {
    getAllTasks: jest.fn(),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../middleware/admin', () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

const mockTaskDb = taskDb as jest.Mocked<typeof taskDb>;

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

describe('Admin knowledge base metrics endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns knowledge base metrics including uploaded files stats', async () => {
    mockTaskDb.getAllTasks.mockResolvedValue([
      {
        taskId: 't-public',
        name: 'Public KB',
        userId: 'user-public',
        knowledgeBaseType: 'public',
        knowledgeBaseSize: 4096,
        knowledgeBaseFiles: [
          { filename: 'file1.txt', size: 1024, key: 'k1', url: 'u1', uploadedAt: '2024-01-01T00:00:00Z' },
          { filename: 'file2.pdf', size: 2048, key: 'k2', url: 'u2', uploadedAt: '2024-01-02T00:00:00Z' },
        ],
      },
      {
        taskId: 't-private',
        name: 'Private KB',
        userId: 'user-private',
        knowledgeBaseType: 'private',
        knowledgeBaseSize: 2048,
        knowledgeBaseFiles: [
          { filename: 'file3.docx', size: 512, key: 'k3', url: 'u3', uploadedAt: '2024-01-03T00:00:00Z' },
        ],
      },
      {
        taskId: 't-empty',
        name: 'No KB',
        userId: 'user-empty',
        knowledgeBaseType: 'public',
        knowledgeBaseSize: 0,
        knowledgeBaseFiles: [],
      },
    ] as any);

    const res = await request(app)
      .get('/api/admin/knowledge-base-metrics')
      .expect(200);

    expect(res.body.uploadedFiles).toEqual(
      expect.objectContaining({
        totalFiles: 3,
        totalSize: 3584,
        tasksWithUploadedFiles: 2,
      })
    );

    expect(res.body.public.uploadedFiles).toEqual(
      expect.objectContaining({
        totalFiles: 2,
        totalSize: 3072,
        tasksWithUploadedFiles: 1,
      })
    );

    expect(res.body.private.uploadedFiles).toEqual(
      expect.objectContaining({
        totalFiles: 1,
        totalSize: 512,
        tasksWithUploadedFiles: 1,
      })
    );

    // Tasks payload should include uploaded file fields
    const publicTask = res.body.tasks.find((t: any) => t.taskId === 't-public');
    expect(publicTask).toMatchObject({
      uploadedFilesCount: 2,
      uploadedFilesSize: 3072,
    });
  });
});
