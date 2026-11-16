// ENG-2404: PUT /api/org/:orgId/memory/:memoryId must 404 (not upsert) for unknown/deleted memories.
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'owner1', email: 'o@test.com' };
    next();
  },
}));

jest.mock('../services/db', () => ({
  orgDb: { getOrgById: jest.fn() },
  userDb: { getUserById: jest.fn() },
  orgMemoryDb: { updateMemory: jest.fn() },
}));

jest.mock('../services/orgAuthz', () => ({ callerCan: jest.fn() }));
jest.mock('../utils/embeddings', () => ({ embedText: jest.fn() }));

import express from 'express';
import supertest from 'supertest';
import orgMemoryRoutes from '../routes/orgMemory';
import { orgDb, orgMemoryDb } from '../services/db';
import { callerCan } from '../services/orgAuthz';

const app = express();
app.use(express.json());
app.use('/api/org', (req: any, _res: any, next: any) => {
  req.user = { userId: 'owner1', email: 'o@test.com' };
  next();
}, orgMemoryRoutes);
const request = supertest(app);

describe('PUT /api/org/:orgId/memory/:memoryId (ENG-2404)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (orgDb.getOrgById as jest.Mock).mockResolvedValue({ orgId: 'org1', ownerId: 'owner1' });
    (callerCan as jest.Mock).mockResolvedValue(true);
  });

  it('returns 404 for an unknown/deleted memory', async () => {
    (orgMemoryDb.updateMemory as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Memory not found: gone'), { code: 'MEMORY_NOT_FOUND' }),
    );
    const res = await request.put('/api/org/org1/memory/gone').send({ content: 'edit' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Memory not found');
  });

  it('still returns 200 for an existing memory', async () => {
    (orgMemoryDb.updateMemory as jest.Mock).mockResolvedValue({ orgId: 'org1', memoryId: 'm1', content: 'edit' });
    const res = await request.put('/api/org/org1/memory/m1').send({ content: 'edit' });
    expect(res.status).toBe(200);
    expect(orgMemoryDb.updateMemory).toHaveBeenCalledWith('org1', 'm1', { content: 'edit' });
  });
});
