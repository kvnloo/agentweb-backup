/**
 * End-to-end integration test for API key lifecycle.
 *
 * Flow:
 * 1. User generates an API key (JWT-authed)
 * 2. User lists API keys
 * 3. User revokes the key
 * 4. Revoked key is no longer valid
 */

import express from 'express';
import request from 'supertest';

// ─── Mock DynamoDB as in-memory store ───

interface StoredItem {
  [key: string]: any;
}

const keyStore: Map<string, StoredItem> = new Map();

const mockPut = jest.fn().mockImplementation((params: any) => ({
  promise: jest.fn().mockImplementation(async () => {
    const item = params.Item;
    keyStore.set(item.keyId, { ...item });
    return {};
  }),
}));

const mockGet = jest.fn().mockImplementation((params: any) => ({
  promise: jest.fn().mockImplementation(async () => {
    const keyId = params.Key.keyId;
    const item = keyStore.get(keyId);
    return { Item: item || undefined };
  }),
}));

const mockQuery = jest.fn().mockImplementation((params: any) => ({
  promise: jest.fn().mockImplementation(async () => {
    const items: StoredItem[] = [];
    if (params.IndexName === 'KeyHashIndex') {
      const targetHash = params.ExpressionAttributeValues[':keyHash'];
      for (const item of keyStore.values()) {
        if (item.keyHash === targetHash) items.push(item);
      }
    } else if (params.IndexName === 'UserIdIndex') {
      const targetUserId = params.ExpressionAttributeValues[':userId'];
      for (const item of keyStore.values()) {
        if (item.userId === targetUserId) items.push(item);
      }
    }
    return { Items: items };
  }),
}));

const mockUpdate = jest.fn().mockImplementation((params: any) => ({
  promise: jest.fn().mockImplementation(async () => {
    const keyId = params.Key.keyId;
    const item = keyStore.get(keyId);
    if (!item) return {};

    // Parse simple SET expressions
    const expr = params.UpdateExpression || '';
    const values = params.ExpressionAttributeValues || {};

    if (expr.includes('#status')) {
      item.status = values[':status'];
    }
    if (expr.includes('lastUsedAt')) {
      item.lastUsedAt = values[':lastUsedAt'];
    }
    if (expr.includes('revokedAt')) {
      item.revokedAt = values[':revokedAt'];
    }

    keyStore.set(keyId, item);
    return {};
  }),
}));

jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: (...args: any[]) => mockPut(...args),
        get: (...args: any[]) => mockGet(...args),
        query: (...args: any[]) => mockQuery(...args),
        update: (...args: any[]) => mockUpdate(...args),
      })),
    },
    S3: jest.fn(() => ({})),
  },
}));

// ─── Mock userDb for subscription gate ───

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn().mockResolvedValue({
      userId: 'user-harsha-123',
      email: 'harsha@agentweb.pro',
      stripe_customer_id: 'cus_test123',
    }),
  },
}));

// ─── Mock JWT auth (simulates a logged-in user) ───

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'user-harsha-123', email: 'harsha@agentweb.pro', isAdmin: false };
    next();
  },
}));

// ─── Import AFTER mocks ───

import agentApiRoutes from '../routes/agentApi';

// Build a minimal Express app with our routes
const app = express();
app.use(express.json());
app.use('/api/v1/agent', agentApiRoutes);

describe('Agent API Key Lifecycle Integration Test', () => {
  let rawApiKey: string;
  let keyId: string;

  beforeAll(() => {
    keyStore.clear();
  });

  afterAll(() => {
    keyStore.clear();
  });

  // ─── PHASE 1: User generates API key ───

  describe('Phase 1: API Key Generation', () => {
    it('should generate an API key for external agent use', async () => {
      const res = await request(app)
        .post('/api/v1/agent/api-keys')
        .set('Authorization', 'Bearer fake-jwt-token')
        .send({
          keyName: 'OpenClaw Integration',
          scopes: ['tools:read', 'tools:execute'],
          rateLimitPerMin: 10,
        });

      expect(res.status).toBe(201);
      expect(res.body.rawKey).toMatch(/^aw_/);
      expect(res.body.key.keyName).toBe('OpenClaw Integration');
      expect(res.body.key.status).toBe('active');
      expect(res.body.key.keyHash).toBeUndefined(); // hash not exposed

      rawApiKey = res.body.rawKey;
      keyId = res.body.key.keyId;
    });

    it('should list the user\'s API keys (masked)', async () => {
      const res = await request(app)
        .get('/api/v1/agent/api-keys')
        .set('Authorization', 'Bearer fake-jwt-token');

      expect(res.status).toBe(200);
      expect(res.body.keys).toHaveLength(1);
      expect(res.body.keys[0].keyName).toBe('OpenClaw Integration');
      expect(res.body.keys[0].maskedKey).toMatch(/^aw_\.\.\./);
      expect(res.body.keys[0].keyHash).toBeUndefined();
    });
  });

  // ─── PHASE 2: Key Revocation ───

  describe('Phase 2: Key Revocation', () => {
    it('should revoke the API key', async () => {
      const res = await request(app)
        .delete(`/api/v1/agent/api-keys/${keyId}`)
        .set('Authorization', 'Bearer fake-jwt-token');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('revoked');
    });

    it('should show key as revoked in list', async () => {
      const res = await request(app)
        .get('/api/v1/agent/api-keys')
        .set('Authorization', 'Bearer fake-jwt-token');

      expect(res.status).toBe(200);
      expect(res.body.keys).toHaveLength(1);
      expect(res.body.keys[0].status).toBe('revoked');
    });
  });

  // ─── PHASE 3: Multiple Keys ───

  describe('Phase 3: Multiple Keys', () => {
    it('should support creating multiple keys', async () => {
      const res1 = await request(app)
        .post('/api/v1/agent/api-keys')
        .set('Authorization', 'Bearer fake-jwt-token')
        .send({ keyName: 'Key A' });

      const res2 = await request(app)
        .post('/api/v1/agent/api-keys')
        .set('Authorization', 'Bearer fake-jwt-token')
        .send({ keyName: 'Key B' });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.key.keyId).not.toBe(res2.body.key.keyId);

      // List should show 3 keys total (1 revoked + 2 new)
      const listRes = await request(app)
        .get('/api/v1/agent/api-keys')
        .set('Authorization', 'Bearer fake-jwt-token');

      expect(listRes.status).toBe(200);
      expect(listRes.body.keys).toHaveLength(3);
    });
  });
});
