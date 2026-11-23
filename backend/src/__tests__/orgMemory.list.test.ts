// ENG-2840 (W2-1): GET /api/org/:orgId/memory reads the whole list (up to the list bound), oldest first, without embedding vectors.
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'member1', email: 'm@test.com' };
    next();
  },
}));

jest.mock('../services/db', () => ({
  orgDb: { getOrgById: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgMemoryDb: { getOrgMemories: jest.fn() },
}));

jest.mock('../services/orgAuthz', () => ({ callerCan: jest.fn() }));
jest.mock('../utils/embeddings', () => ({ embedText: jest.fn() }));

import express from 'express';
import supertest from 'supertest';
import orgMemoryRoutes from '../routes/orgMemory';
import { userDb, orgMemoryDb } from '../services/db';

const app = express();
app.use(express.json());
app.use('/api/org', (req: any, _res: any, next: any) => {
  req.user = { userId: 'member1', email: 'm@test.com' };
  next();
}, orgMemoryRoutes);
const request = supertest(app);

const LIST_READ = { maxRows: 1000, newestFirst: false, omitEmbeddings: true };

describe('GET /api/org/:orgId/memory (ENG-2840 W2-1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'member1', orgId: 'org1' });
    (orgMemoryDb.getOrgMemories as jest.Mock).mockResolvedValue([{ memoryId: 'm1', content: 'fact' }]);
  });

  it('asks for the list read: up to 1,000 rows, oldest first, no vectors', async () => {
    const res = await request.get('/api/org/org1/memory');
    expect(res.status).toBe(200);
    expect(res.body.memories).toEqual([{ memoryId: 'm1', content: 'fact' }]);
    expect(orgMemoryDb.getOrgMemories).toHaveBeenCalledWith('org1', undefined, undefined, LIST_READ);
  });

  it('forwards the category filter', async () => {
    await request.get('/api/org/org1/memory?category=workflow');
    expect(orgMemoryDb.getOrgMemories).toHaveBeenCalledWith('org1', 'workflow', undefined, LIST_READ);
  });

  it('still refuses a caller who is not a member of that org, and reads nothing', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'member1', orgId: 'another-org' });
    const res = await request.get('/api/org/org1/memory');
    expect(res.status).toBe(403);
    expect(orgMemoryDb.getOrgMemories).not.toHaveBeenCalled();
  });
});
