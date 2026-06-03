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

import { accountMemoryDb } from '../services/db';

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
    expect(mockDb.getUserMemories).toHaveBeenCalledWith('user1', undefined);
  });

  it('GET /api/memory?category=preference should filter by category', async () => {
    const { accountMemoryDb: mockDb } = require('../services/db');
    mockDb.getUserMemories.mockResolvedValue([]);

    await request.get('/api/memory?category=preference');

    expect(mockDb.getUserMemories).toHaveBeenCalledWith('user1', 'preference');
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
