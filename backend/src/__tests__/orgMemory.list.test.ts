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
  orgMemoryDb: { getOrgMemories: jest.fn(), addMemory: jest.fn() },
}));

jest.mock('../services/orgAuthz', () => ({ callerCan: jest.fn() }));
jest.mock('../utils/embeddings', () => ({ embedText: jest.fn() }));

import express from 'express';
import supertest from 'supertest';
import orgMemoryRoutes from '../routes/orgMemory';
import { userDb, orgMemoryDb } from '../services/db';
import { embedText } from '../utils/embeddings';

const app = express();
app.use(express.json());
app.use('/api/org', (req: any, _res: any, next: any) => {
  req.user = { userId: 'member1', email: 'm@test.com' };
  next();
}, orgMemoryRoutes);
const request = supertest(app);

const LIST_READ = { maxRows: 1000, newestFirst: true, omitEmbeddings: true };

describe('GET /api/org/:orgId/memory (ENG-2840 W2-1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'member1', orgId: 'org1' });
    (orgMemoryDb.getOrgMemories as jest.Mock).mockResolvedValue([{ memoryId: 'm1', content: 'fact' }]);
  });

  it('asks for the list read: the newest rows up to 1,000, no vectors', async () => {
    const res = await request.get('/api/org/org1/memory');
    expect(res.status).toBe(200);
    expect(res.body.memories).toEqual([{ memoryId: 'm1', content: 'fact' }]);
    expect(orgMemoryDb.getOrgMemories).toHaveBeenCalledWith('org1', undefined, undefined, LIST_READ);
  });

  it('returns the list OLDEST FIRST, the order the screen always had (the read is newest first so the bound drops the oldest)', async () => {
    (orgMemoryDb.getOrgMemories as jest.Mock).mockResolvedValue([{ memoryId: 'm3' }, { memoryId: 'm2' }, { memoryId: 'm1' }]);
    const res = await request.get('/api/org/org1/memory');
    expect(res.body.memories.map((m: any) => m.memoryId)).toEqual(['m1', 'm2', 'm3']);
  });

  it('returns a category read as read (the category index cannot be ordered by time)', async () => {
    (orgMemoryDb.getOrgMemories as jest.Mock).mockResolvedValue([{ memoryId: 'a' }, { memoryId: 'b' }]);
    const res = await request.get('/api/org/org1/memory?category=workflow');
    expect(res.body.memories.map((m: any) => m.memoryId)).toEqual(['a', 'b']);
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

describe('POST /api/org/:orgId/memory refuses what addMemory would refuse BEFORE the embedding is requested (Opslane P2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'member1', orgId: 'org1' });
    (orgMemoryDb.addMemory as jest.Mock).mockResolvedValue({ memoryId: 'm1' });
  });

  it.each([
    ['an invalid category', { content: 'a fact', category: 'other' }, 'Invalid category: other. Must be one of: preference, history, insight, workflow'],
    ['a whitespace-only content', { content: '   ', category: 'insight' }, 'Content is required'],
  ])('%s: 400, no embedding, nothing saved', async (_name, body, message) => {
    const res = await request.post('/api/org/org1/memory').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(message);
    expect(embedText).not.toHaveBeenCalled();
    expect(orgMemoryDb.addMemory).not.toHaveBeenCalled();
  });

  it('a content over the limit: 400, no embedding, nothing saved', async () => {
    const res = await request.post('/api/org/org1/memory').send({ content: 'x'.repeat(2001), category: 'insight' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^Content must be 2000 characters or less/);
    expect(embedText).not.toHaveBeenCalled();
    expect(orgMemoryDb.addMemory).not.toHaveBeenCalled();
  });

  it('a valid save still embeds once, then saves', async () => {
    (embedText as jest.Mock).mockResolvedValue([0.5]);
    const res = await request.post('/api/org/org1/memory').send({ content: 'a fact', category: 'workflow' });
    expect(res.status).toBe(201);
    expect(embedText).toHaveBeenCalledTimes(1);
    expect(orgMemoryDb.addMemory).toHaveBeenCalledWith('org1', 'workflow', 'a fact', 'member1', [0.5]);
  });

  it('a caller who is not a member is still refused before anything', async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'member1', orgId: 'another-org' });
    const res = await request.post('/api/org/org1/memory').send({ content: 'a fact', category: 'workflow' });
    expect(res.status).toBe(403);
    expect(embedText).not.toHaveBeenCalled();
  });
});
