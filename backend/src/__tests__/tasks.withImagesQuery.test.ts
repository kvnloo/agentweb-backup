// ENG-2386: route-level tests for with-images favorites/approved/limit/cursor.

import express from 'express';
import request from 'supertest';
import { ChatbotDB } from '../services/chatbotService';
import { taskDb } from '../services/db';

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
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

jest.mock('../services/chatbotService');
jest.mock('../services/db', () => ({
  taskDb: {
    getAllTaskExecutionsByUserId: jest.fn(),
    getTasksByUserId: jest.fn(),
  },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'user123', isAdmin: false };
    next();
  },
}));

jest.mock('../services/approvalDb', () => ({
  approvalDb: { getApprovalsByUserId: jest.fn() },
  getAssetTypeFromFilename: jest.fn(),
}));
const { approvalDb } = require('../services/approvalDb');

const router = require('../routes/tasks').default;


describe('GET /executions/with-images query params (ENG-2386)', () => {
  let app: express.Application;
  const execs = ['t1', 't2', 't3'].map((id, i) => ({
    executionId: `e-${id}`, taskId: id, userId: 'user123', status: 'completed', startTime: `2024-01-0${i + 1}T00:00:00Z`,
    result_files: [
      { url: `https://x/${id}-fav.png`, filename: `${id}-fav.png`, is_favorited: true },
      { url: `https://x/${id}.png`, filename: `${id}.png` },
    ],
  }));

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use('/api/tasks', router);
    (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([]);
    (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue(execs);
    (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue(['t1', 't2', 't3'].map(id => ({ taskId: id, name: id, status: 'active' })));
    (approvalDb.getApprovalsByUserId as jest.Mock).mockResolvedValue([{ assetUrl: 'https://x/t2.png', status: 'approved' }]);
  });

  it('no params: unchanged full map, no paging headers, no approval lookup', async () => {
    const res = await request(app).get('/api/tasks/executions/with-images').expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['t1', 't2', 't3']);
    expect(res.body.t1.executions[0].result_files).toHaveLength(2);
    expect(res.headers['x-next-cursor']).toBeUndefined();
    expect(approvalDb.getApprovalsByUserId).not.toHaveBeenCalled();
  });

  it('favorites=true returns only favorited files', async () => {
    const res = await request(app).get('/api/tasks/executions/with-images?favorites=true').expect(200);
    for (const id of ['t1', 't2', 't3']) {
      expect(res.body[id].executions[0].result_files.map((f: any) => f.filename)).toEqual([`${id}-fav.png`]);
    }
  });

  it('approved=true uses the caller-scoped approvals', async () => {
    const res = await request(app).get('/api/tasks/executions/with-images?approved=true').expect(200);
    expect(Object.keys(res.body)).toEqual(['t2']);
    expect(approvalDb.getApprovalsByUserId).toHaveBeenCalledWith('user123');
  });

  it('limit + cursor page through tasks newest first', async () => {
    const p1 = await request(app).get('/api/tasks/executions/with-images?limit=2').expect(200);
    expect(Object.keys(p1.body)).toEqual(['t3', 't2']);
    expect(p1.headers['x-next-cursor']).toBe('2');
    expect(p1.headers['x-total-tasks']).toBe('3');
    const p2 = await request(app).get('/api/tasks/executions/with-images?limit=2&cursor=2').expect(200);
    expect(Object.keys(p2.body)).toEqual(['t1']);
    expect(p2.headers['x-next-cursor']).toBeUndefined();
  });

  it('rejects invalid limit with 400', async () => {
    await request(app).get('/api/tasks/executions/with-images?limit=0').expect(400);
  });

  it('scopes to the authenticated user', async () => {
    await request(app).get('/api/tasks/executions/with-images?limit=1').expect(200);
    expect(taskDb.getAllTaskExecutionsByUserId).toHaveBeenCalledWith('user123');
  });
});
