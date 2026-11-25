// Unit tests for Account Memory database operations and route handlers
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => {
  return {
    config: {
      update: jest.fn(),
    },
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocumentClientMethods),
    },
    S3: jest.fn(() => ({
      upload: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
  };
});

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomainAndLeadEmail: jest.fn(),
    updateEmailEventContent: jest.fn(),
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
    getDeliveredEmailContent: jest.fn(),
  },
}));

import { accountMemoryDb, orgMemoryDb } from '../services/db';

describe('Account Memory Database Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(mockDocumentClientMethods).forEach(method => {
      (mockDocumentClientMethods as any)[method].mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
    });
  });

  describe('addMemory', () => {
    it('should create a new memory with all fields', async () => {
      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await accountMemoryDb.addMemory(
        'user1',
        'preference',
        'Prefers blue color scheme',
        'session123'
      );

      expect(mockDocumentClientMethods.put).toHaveBeenCalled();
      const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
      expect(putCall.Item.userId).toBe('user1');
      expect(putCall.Item.category).toBe('preference');
      expect(putCall.Item.content).toBe('Prefers blue color scheme');
      expect(putCall.Item.sourceSessionId).toBe('session123');
      expect(putCall.Item.memoryId).toBeDefined();
      expect(putCall.Item.createdAt).toBeDefined();
      expect(putCall.Item.updatedAt).toBeDefined();
      expect(result.memoryId).toBeDefined();
    });

    it('should create memory without sourceSessionId', async () => {
      mockDocumentClientMethods.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await accountMemoryDb.addMemory(
        'user1',
        'insight',
        'High engagement on LinkedIn'
      );

      const putCall = mockDocumentClientMethods.put.mock.calls[0][0];
      expect(putCall.Item.sourceSessionId).toBeUndefined();
      expect(result.category).toBe('insight');
    });

    it('should reject invalid category', async () => {
      await expect(
        accountMemoryDb.addMemory('user1', 'invalid_category' as any, 'test')
      ).rejects.toThrow('Invalid category');
    });

    it('should reject empty content', async () => {
      await expect(
        accountMemoryDb.addMemory('user1', 'preference', '')
      ).rejects.toThrow('Content is required');
    });

    it('should reject content over 2000 characters', async () => {
      const longContent = 'a'.repeat(2001);
      await expect(
        accountMemoryDb.addMemory('user1', 'preference', longContent)
      ).rejects.toThrow('Content must be 2000 characters or less');
    });
  });

  describe('getUserMemories', () => {
    it('should return all memories for a user', async () => {
      const mockItems = [
        { userId: 'user1', memoryId: 'mem1', category: 'preference', content: 'fact1', createdAt: '2026-01-01' },
        { userId: 'user1', memoryId: 'mem2', category: 'insight', content: 'fact2', createdAt: '2026-01-02' },
      ];
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: mockItems }),
      });

      const result = await accountMemoryDb.getUserMemories('user1');

      expect(mockDocumentClientMethods.query).toHaveBeenCalled();
      const queryCall = mockDocumentClientMethods.query.mock.calls[0][0];
      expect(queryCall.KeyConditionExpression).toContain('userId');
      expect(result).toHaveLength(2);
    });

    it('should filter by category using GSI', async () => {
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      await accountMemoryDb.getUserMemories('user1', 'preference');

      const queryCall = mockDocumentClientMethods.query.mock.calls[0][0];
      expect(queryCall.IndexName).toBe('UserIdCategoryIndex');
      expect(queryCall.KeyConditionExpression).toContain('category');
    });

    it('should respect limit parameter', async () => {
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      await accountMemoryDb.getUserMemories('user1', undefined, 10);

      const queryCall = mockDocumentClientMethods.query.mock.calls[0][0];
      expect(queryCall.Limit).toBe(10);
    });
  });

  describe('getRecentMemories', () => {
    it('should return memories sorted by most recent', async () => {
      const mockItems = [
        { memoryId: 'mem1', content: 'old', createdAt: '2026-01-01' },
        { memoryId: 'mem2', content: 'new', createdAt: '2026-01-02' },
      ];
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: mockItems }),
      });

      const result = await accountMemoryDb.getRecentMemories('user1', 20);

      expect(result).toHaveLength(2);
      const queryCall = mockDocumentClientMethods.query.mock.calls[0][0];
      expect(queryCall.ScanIndexForward).toBe(false);
      expect(queryCall.Limit).toBe(20);
    });

    it('should default to 20 limit', async () => {
      mockDocumentClientMethods.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      });

      await accountMemoryDb.getRecentMemories('user1');

      const queryCall = mockDocumentClientMethods.query.mock.calls[0][0];
      expect(queryCall.Limit).toBe(20);
    });
  });

  describe('updateMemory', () => {
    it('should update memory content and category', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Attributes: { userId: 'user1', memoryId: 'mem1', content: 'updated', category: 'insight' },
        }),
      });

      const result = await accountMemoryDb.updateMemory('user1', 'mem1', {
        content: 'updated',
        category: 'insight',
      });

      expect(mockDocumentClientMethods.update).toHaveBeenCalled();
      const updateCall = mockDocumentClientMethods.update.mock.calls[0][0];
      expect(updateCall.Key.userId).toBe('user1');
      expect(updateCall.Key.memoryId).toBe('mem1');
      expect(result).toBeDefined();
    });

    it('conditions the update on the memory existing (ENG-2404)', async () => {
      mockDocumentClientMethods.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Attributes: { memoryId: 'mem1' } }),
      });
      await accountMemoryDb.updateMemory('user1', 'mem1', { content: 'x' });
      await orgMemoryDb.updateMemory('org1', 'mem1', { content: 'x' });
      for (const [call] of mockDocumentClientMethods.update.mock.calls) {
        expect(call.ConditionExpression).toBe('attribute_exists(memoryId)');
      }
      expect(mockDocumentClientMethods.update).toHaveBeenCalledTimes(2);
    });

    it('maps ConditionalCheckFailedException to MEMORY_NOT_FOUND for account and org (ENG-2404)', async () => {
      const ccf = Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
      mockDocumentClientMethods.update.mockReturnValue({ promise: jest.fn().mockRejectedValue(ccf) });
      await expect(accountMemoryDb.updateMemory('user1', 'gone', { content: 'x' }))
        .rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
      await expect(orgMemoryDb.updateMemory('org1', 'gone', { content: 'x' }))
        .rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    });

    it('should reject invalid category on update', async () => {
      await expect(
        accountMemoryDb.updateMemory('user1', 'mem1', { category: 'bogus' as any })
      ).rejects.toThrow('Invalid category');
    });

    it('should reject empty content on update', async () => {
      await expect(
        accountMemoryDb.updateMemory('user1', 'mem1', { content: '' })
      ).rejects.toThrow('Content cannot be empty');
    });

    it('should reject content over 2000 characters on update', async () => {
      const longContent = 'a'.repeat(2001);
      await expect(
        accountMemoryDb.updateMemory('user1', 'mem1', { content: longContent })
      ).rejects.toThrow('Content must be 2000 characters or less');
    });
  });

  describe('deleteMemory', () => {
    it('should delete a memory by userId and memoryId', async () => {
      mockDocumentClientMethods.delete.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await accountMemoryDb.deleteMemory('user1', 'mem1');

      expect(mockDocumentClientMethods.delete).toHaveBeenCalled();
      const deleteCall = mockDocumentClientMethods.delete.mock.calls[0][0];
      expect(deleteCall.Key.userId).toBe('user1');
      expect(deleteCall.Key.memoryId).toBe('mem1');
    });
  });
});

// Route handler tests
describe('Memory API Routes', () => {
  let app: any;
  let request: any;

  beforeAll(async () => {
    // Mock authenticateToken middleware
    jest.mock('../middleware/auth', () => ({
      authenticateToken: (req: any, _res: any, next: any) => {
        req.user = { userId: 'user1', email: 'test@test.com' };
        next();
      },
      requireAdmin: (_req: any, _res: any, next: any) => next(),
    }));

    // Mock accountMemoryDb and userDb
    jest.mock('../services/db', () => {
      const original = jest.requireActual('../services/db');
      return {
        ...original,
        accountMemoryDb: {
          addMemory: jest.fn(),
          getUserMemories: jest.fn(),
          getRecentMemories: jest.fn(),
          updateMemory: jest.fn(),
          deleteMemory: jest.fn(),
        },
        userDb: {
          getUserById: jest.fn().mockResolvedValue({ userId: 'user1', memoryEnabled: true }),
          updateUser: jest.fn().mockResolvedValue({ userId: 'user1', memoryEnabled: false }),
        },
      };
    });

    // Mock the embeddings util so the write path embeds deterministically without a network call
    jest.mock('../utils/embeddings', () => ({
      embedText: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    }));

    const supertest = require('supertest');
    const express = require('express');
    const { default: memoryRoutes } = await import('../routes/memory');

    app = express();
    app.use(express.json());
    // Attach mock auth middleware
    app.use('/api/memory', (req: any, _res: any, next: any) => {
      req.user = { userId: 'user1', email: 'test@test.com' };
      next();
    }, memoryRoutes);
    request = supertest(app);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/memory should return user memories', async () => {
    const { accountMemoryDb: mockDb } = require('../services/db');
    mockDb.getUserMemories.mockResolvedValue([
      { memoryId: 'mem1', content: 'test', category: 'preference', createdAt: '2026-01-01' },
    ]);

    const res = await request.get('/api/memory');

    expect(res.status).toBe(200);
    expect(res.body.memories).toHaveLength(1);
    // ENG-2840 (W2-1): the list screen reads the newest rows up to the list bound, without the embedding vectors.
    expect(mockDb.getUserMemories).toHaveBeenCalledWith('user1', undefined, undefined, { maxRows: 1000, newestFirst: true, omitEmbeddings: true });
  });

  it('GET /api/memory returns the list OLDEST FIRST, the order the screen always had (the read is newest first so the bound drops the oldest)', async () => {
    const { accountMemoryDb: mockDb } = require('../services/db');
    mockDb.getUserMemories.mockResolvedValue([{ memoryId: 'm3' }, { memoryId: 'm2' }, { memoryId: 'm1' }]);
    const res = await request.get('/api/memory');
    expect(res.body.memories.map((m: any) => m.memoryId)).toEqual(['m1', 'm2', 'm3']);
  });

  it('GET /api/memory?category= returns the rows as read: a category index cannot be ordered by time', async () => {
    const { accountMemoryDb: mockDb } = require('../services/db');
    mockDb.getUserMemories.mockResolvedValue([{ memoryId: 'a' }, { memoryId: 'b' }]);
    const res = await request.get('/api/memory?category=preference');
    expect(res.body.memories.map((m: any) => m.memoryId)).toEqual(['a', 'b']);
  });

  it('GET /api/memory?category=preference should filter by category', async () => {
    const { accountMemoryDb: mockDb } = require('../services/db');
    mockDb.getUserMemories.mockResolvedValue([]);

    await request.get('/api/memory?category=preference');

    expect(mockDb.getUserMemories).toHaveBeenCalledWith('user1', 'preference', undefined, { maxRows: 1000, newestFirst: true, omitEmbeddings: true });
  });

  it('POST /api/memory should create a memory', async () => {
    const { accountMemoryDb: mockDb } = require('../services/db');
    mockDb.addMemory.mockResolvedValue({
      memoryId: 'mem1',
      userId: 'user1',
      content: 'test fact',
      category: 'preference',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    });

    const res = await request.post('/api/memory').send({
      content: 'test fact',
      category: 'preference',
    });

    expect(res.status).toBe(201);
    expect(res.body.memory.memoryId).toBe('mem1');
    // Now also persists an embedding (5th arg) computed at write time for relevance retrieval
    expect(mockDb.addMemory).toHaveBeenCalledWith('user1', 'preference', 'test fact', undefined, [0.1, 0.2, 0.3]);
  });

  describe('POST /api/memory refuses what addMemory would refuse BEFORE the embedding is requested (Opslane P2: it was billed anyway)', () => {
    // Fetched inside each test: this file installs its embeddings mock in beforeAll, after the describe bodies run.
    const embeddings = () => require('../utils/embeddings').embedText;
    const bodies: Array<[string, any, string]> = [
      ['an invalid category', { content: 'a fact', category: 'other' }, 'Invalid category: other. Must be one of: preference, history, insight, workflow'],
      ['a whitespace-only content', { content: '   ', category: 'insight' }, 'Content is required'],
    ];
    it.each(bodies)('%s: 400, no embedding, nothing saved', async (_name, body, message) => {
      const { accountMemoryDb: mockDb } = require('../services/db');
      const embedText = embeddings();
      embedText.mockClear();
      mockDb.addMemory.mockClear();
      const res = await request.post('/api/memory').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(message);
      expect(embedText).not.toHaveBeenCalled();
      expect(mockDb.addMemory).not.toHaveBeenCalled();
    });

    it('a content over the limit: 400, no embedding, nothing saved', async () => {
      const { accountMemoryDb: mockDb } = require('../services/db');
      const embedText = embeddings();
      embedText.mockClear();
      mockDb.addMemory.mockClear();
      const res = await request.post('/api/memory').send({ content: 'x'.repeat(2001), category: 'insight' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/^Content must be 2000 characters or less/);
      expect(embedText).not.toHaveBeenCalled();
      expect(mockDb.addMemory).not.toHaveBeenCalled();
    });

    it('a valid save still embeds once, then saves', async () => {
      const { accountMemoryDb: mockDb } = require('../services/db');
      const embedText = embeddings();
      embedText.mockClear();
      mockDb.addMemory.mockResolvedValue({ memoryId: 'm1' });
      const res = await request.post('/api/memory').send({ content: 'a fact', category: 'workflow' });
      expect(res.status).toBe(201);
      expect(embedText).toHaveBeenCalledTimes(1);
      expect(mockDb.addMemory).toHaveBeenCalledWith('user1', 'workflow', 'a fact', undefined, [0.1, 0.2, 0.3]);
    });
  });

  it('POST /api/memory should reject missing content', async () => {
    const res = await request.post('/api/memory').send({
      category: 'preference',
    });

    expect(res.status).toBe(400);
  });

  it('POST /api/memory should reject missing category', async () => {
    const res = await request.post('/api/memory').send({
      content: 'test fact',
    });

    expect(res.status).toBe(400);
  });

  it('PUT /api/memory/:memoryId should update a memory', async () => {
    const { accountMemoryDb: mockDb } = require('../services/db');
    mockDb.updateMemory.mockResolvedValue({
      memoryId: 'mem1',
      userId: 'user1',
      content: 'updated fact',
      category: 'insight',
    });

    const res = await request.put('/api/memory/mem1').send({
      content: 'updated fact',
      category: 'insight',
    });

    expect(res.status).toBe(200);
    expect(mockDb.updateMemory).toHaveBeenCalledWith('user1', 'mem1', {
      content: 'updated fact',
      category: 'insight',
    });
  });

  it('PUT /api/memory/:memoryId returns 404 for an unknown/deleted memory (ENG-2404)', async () => {
    const { accountMemoryDb: mockDb } = require('../services/db');
    mockDb.updateMemory.mockRejectedValue(Object.assign(new Error('Memory not found: gone'), { code: 'MEMORY_NOT_FOUND' }));

    const res = await request.put('/api/memory/gone').send({ content: 'edit' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Memory not found');
  });

  it('DELETE /api/memory/:memoryId should delete a memory', async () => {
    const { accountMemoryDb: mockDb } = require('../services/db');
    mockDb.deleteMemory.mockResolvedValue(undefined);

    const res = await request.delete('/api/memory/mem1');

    expect(res.status).toBe(200);
    expect(mockDb.deleteMemory).toHaveBeenCalledWith('user1', 'mem1');
  });

  it('GET /api/memory/settings should return memoryEnabled status', async () => {
    const { userDb: mockUserDb } = require('../services/db');
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user1', memoryEnabled: true });

    const res = await request.get('/api/memory/settings');

    expect(res.status).toBe(200);
    expect(res.body.memoryEnabled).toBe(true);
  });

  it('GET /api/memory/settings should default to true when field is missing', async () => {
    const { userDb: mockUserDb } = require('../services/db');
    mockUserDb.getUserById.mockResolvedValue({ userId: 'user1' });

    const res = await request.get('/api/memory/settings');

    expect(res.status).toBe(200);
    expect(res.body.memoryEnabled).toBe(true);
  });

  it('PUT /api/memory/settings should toggle memory off', async () => {
    const { userDb: mockUserDb } = require('../services/db');
    mockUserDb.updateUser.mockResolvedValue({ userId: 'user1', memoryEnabled: false });

    const res = await request.put('/api/memory/settings').send({ memoryEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.memoryEnabled).toBe(false);
    expect(mockUserDb.updateUser).toHaveBeenCalledWith('user1', { memoryEnabled: false });
  });

  it('PUT /api/memory/settings should reject non-boolean', async () => {
    const res = await request.put('/api/memory/settings').send({ memoryEnabled: 'yes' });

    expect(res.status).toBe(400);
  });
});

describe('ENG-1968 structured learning stays out of generic memory', () => {
  it.each(['getUserMemories', 'getRecentMemories'])('fills the requested ordinary-memory limit across filtered pages: %s', async method => {
    mockDocumentClientMethods.query.mockReset();
    mockDocumentClientMethods.query
      .mockReturnValueOnce({ promise: async () => ({ Items: [{ memoryId: 'ads-learning#1', content: 'proposal' }], LastEvaluatedKey: { userId: 'user1', memoryId: 'ads-learning#1' } }) })
      .mockReturnValueOnce({ promise: async () => ({ Items: [{ memoryId: 'ordinary', content: 'user preference' }] }) });
    const result = method === 'getRecentMemories' ? await accountMemoryDb.getRecentMemories('user1', 1)
      : await accountMemoryDb.getUserMemories('user1', undefined, 1);
    expect(result.map((x: any) => x.memoryId)).toEqual(['ordinary']);
  });
  it('fails closed on a wrong-type memory row', async () => {
    mockDocumentClientMethods.query.mockReturnValue({ promise: async () => ({ Items: [true] }) });
    await expect(accountMemoryDb.getUserMemories('user1')).rejects.toThrow(/memory/i);
  });
});

it.each(['update', 'delete'])('preserves structured learning audit history from generic memory %s', async action => {
  const work = action === 'update' ? accountMemoryDb.updateMemory('u', 'ads-learning#r', { content: 'rewrite' })
    : accountMemoryDb.deleteMemory('u', 'ads-learning#r');
  await expect(work).rejects.toThrow(/review/i);
});
it('does not let a large contiguous learning block hide ordinary recent memories', async () => {
  mockDocumentClientMethods.query.mockImplementation((params: any) => ({ promise: async () =>
    params.KeyConditionExpression.includes('memoryId <')
      ? { Items: [{ memoryId: '01ORDINARY', content: 'preference' }] }
      : { Items: [{ memoryId: 'ads-learning#abc', content: 'proposal' }], LastEvaluatedKey: { userId: 'u', memoryId: 'ads-learning#abc' } }
  }));
  expect((await accountMemoryDb.getRecentMemories('u', 1)).map((x: any) => x.memoryId)).toEqual(['01ORDINARY']);
});
