import express from 'express';
import request from 'supertest';

// Mock auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

// Mock userDb (subscription gate - always return subscribed user for route tests)
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn().mockResolvedValue({
      userId: 'test-user-id',
      email: 'test@example.com',
      stripe_customer_id: 'cus_test123',
    }),
  },
}));

// Mock agentApiKeyService
const mockGenerateKey = jest.fn();
const mockGetKeysByUserId = jest.fn();
const mockRevokeKey = jest.fn();
jest.mock('../services/agentApiKeyService', () => ({
  agentApiKeyService: {
    generateKey: (...args: any[]) => mockGenerateKey(...args),
    getKeysByUserId: (...args: any[]) => mockGetKeysByUserId(...args),
    revokeKey: (...args: any[]) => mockRevokeKey(...args),
    validateKey: jest.fn(),
  },
}));

import agentApiRoutes, { checkRateLimitPerMin, MAX_API_KEY_RATE_LIMIT_PER_MIN } from '../routes/agentApi';

const app = express();
app.use(express.json());
app.use('/api/v1/agent', agentApiRoutes);

describe('Agent API Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/agent/api-keys (generate key)', () => {
    it('should generate a new API key', async () => {
      mockGenerateKey.mockResolvedValue({
        rawKey: 'aw_testapikey123',
        keyRecord: {
          keyId: 'key-uuid',
          maskedKey: 'aw_...123',
          keyName: 'My Key',
          scopes: ['tools:read', 'tools:execute'],
          rateLimitPerMin: 60,
          createdAt: '2025-01-01T00:00:00.000Z',
          status: 'active',
        },
      });

      const res = await request(app)
        .post('/api/v1/agent/api-keys')
        .send({ keyName: 'My Key' });

      expect(res.status).toBe(201);
      expect(res.body.rawKey).toBe('aw_testapikey123');
      expect(res.body.key.keyId).toBe('key-uuid');
      expect(mockGenerateKey).toHaveBeenCalledWith(
        'test-user-id',
        'My Key',
        undefined,
        undefined,
        undefined
      );
    });

    it('should return 400 when keyName is missing', async () => {
      const res = await request(app)
        .post('/api/v1/agent/api-keys')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('keyName');
    });

    it('should accept optional scopes and rateLimitPerMin', async () => {
      mockGenerateKey.mockResolvedValue({
        rawKey: 'aw_key',
        keyRecord: { keyId: 'k', keyName: 'K', status: 'active' },
      });

      const res = await request(app)
        .post('/api/v1/agent/api-keys')
        .send({
          keyName: 'Custom Key',
          scopes: ['tools:read'],
          rateLimitPerMin: 120,
          expiresAt: '2027-01-01T00:00:00.000Z',
        });

      expect(res.status).toBe(201);
      expect(mockGenerateKey).toHaveBeenCalledWith(
        'test-user-id',
        'Custom Key',
        ['tools:read'],
        120,
        '2027-01-01T00:00:00.000Z'
      );
    });
  });

  describe('POST /api/v1/agent/api-keys scope validation', () => {
    beforeEach(() => {
      mockGenerateKey.mockResolvedValue({ rawKey: 'aw_key', keyRecord: { keyId: 'k', keyName: 'K', status: 'active' } });
    });

    it.each([
      [['tools:read', 'admin:all']],
      [['EMAIL:READ']],
      [[]],
      ['tools:read'],
      [[42]],
    ])('rejects scopes %j with 400 and creates no key', async (scopes) => {
      const res = await request(app).post('/api/v1/agent/api-keys').send({ keyName: 'K', scopes });
      expect(res.status).toBe(400);
      expect(mockGenerateKey).not.toHaveBeenCalled();
    });

    it('grants email:read on a regular session (deduped)', async () => {
      const res = await request(app)
        .post('/api/v1/agent/api-keys')
        .send({ keyName: 'K', scopes: ['tools:read', 'email:read', 'email:read'] });
      expect(res.status).toBe(201);
      expect(mockGenerateKey).toHaveBeenCalledWith('test-user-id', 'K', ['tools:read', 'email:read'], undefined, undefined);
    });

    it('refuses email:read from a delegated (admin-as-customer) session with 403', async () => {
      const delegated = express();
      delegated.use(express.json());
      delegated.use((req: any, _res, next) => {
        req.delegateInfo = { adminUserId: 'admin-1', adminEmail: 'a@x.com', isDelegated: true };
        next();
      });
      delegated.use('/api/v1/agent', agentApiRoutes);

      const res = await request(delegated).post('/api/v1/agent/api-keys').send({ keyName: 'K', scopes: ['email:read'] });
      expect(res.status).toBe(403);
      expect(mockGenerateKey).not.toHaveBeenCalled();

      const ok = await request(delegated).post('/api/v1/agent/api-keys').send({ keyName: 'K', scopes: ['tools:read'] });
      expect(ok.status).toBe(201);
    });

    it('grants smartlead:read and smartlead:control on a regular session', async () => {
      const res = await request(app)
        .post('/api/v1/agent/api-keys')
        .send({ keyName: 'Hermes', scopes: ['tools:read', 'smartlead:read', 'smartlead:control'] });
      expect(res.status).toBe(201);
      expect(mockGenerateKey).toHaveBeenCalledWith('test-user-id', 'Hermes', ['tools:read', 'smartlead:read', 'smartlead:control'], undefined, undefined);
    });

    it.each([['smartlead:read'], ['smartlead:control']])('refuses %s from a delegated (admin-as-customer) session with 403', async (scope) => {
      const delegated = express();
      delegated.use(express.json());
      delegated.use((req: any, _res, next) => {
        req.delegateInfo = { adminUserId: 'admin-1', adminEmail: 'a@x.com', isDelegated: true };
        next();
      });
      delegated.use('/api/v1/agent', agentApiRoutes);
      const res = await request(delegated).post('/api/v1/agent/api-keys').send({ keyName: 'K', scopes: ['tools:read', scope] });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain(scope);
      expect(mockGenerateKey).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/agent/api-keys memory:org scope (ENG-2840 W2-2)', () => {
    beforeEach(() => {
      mockGenerateKey.mockResolvedValue({ rawKey: 'aw_key', keyRecord: { keyId: 'k', keyName: 'K', status: 'active' } });
    });

    it('grants memory:org on a regular session, next to the default scopes, deduped', async () => {
      const res = await request(app)
        .post('/api/v1/agent/api-keys')
        .send({ keyName: 'Hermes', scopes: ['tools:read', 'tools:execute', 'memory:org', 'memory:org'] });
      expect(res.status).toBe(201);
      expect(mockGenerateKey).toHaveBeenCalledWith('test-user-id', 'Hermes', ['tools:read', 'tools:execute', 'memory:org'], undefined, undefined);
    });

    it('refuses memory:org from a delegated (admin-as-customer) session with 403 and creates no key', async () => {
      const delegated = express();
      delegated.use(express.json());
      delegated.use((req: any, _res, next) => {
        req.delegateInfo = { adminUserId: 'admin-1', adminEmail: 'a@x.com', isDelegated: true };
        next();
      });
      delegated.use('/api/v1/agent', agentApiRoutes);
      const res = await request(delegated).post('/api/v1/agent/api-keys').send({ keyName: 'K', scopes: ['tools:read', 'memory:org'] });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('memory:org');
      expect(mockGenerateKey).not.toHaveBeenCalled();
      // A delegated session may still mint a key without it.
      const ok = await request(delegated).post('/api/v1/agent/api-keys').send({ keyName: 'K', scopes: ['tools:read'] });
      expect(ok.status).toBe(201);
    });

    it('is not a default scope: a key minted without scopes does not get it', async () => {
      await request(app).post('/api/v1/agent/api-keys').send({ keyName: 'K' });
      expect(mockGenerateKey.mock.calls[0][2]).toBeUndefined();
    });
  });

  describe('POST /api/v1/agent/api-keys rateLimitPerMin validation (ENG-2840 W2-2)', () => {
    beforeEach(() => {
      mockGenerateKey.mockResolvedValue({ rawKey: 'aw_key', keyRecord: { keyId: 'k', keyName: 'K', status: 'active' } });
    });

    it('the highest rate a key may be minted with is 600', () => expect(MAX_API_KEY_RATE_LIMIT_PER_MIN).toBe(600));

    it.each([1, 10, 60, 120, 600])('accepts %d and passes it on unchanged', async (rate) => {
      const res = await request(app).post('/api/v1/agent/api-keys').send({ keyName: 'K', rateLimitPerMin: rate });
      expect(res.status).toBe(201);
      expect(mockGenerateKey.mock.calls[0][3]).toBe(rate);
    });

    it.each([[0], [-1], [601], [1000000], [1.5], ['60'], [true], [[60]], [{}], [1e308]])('rejects %j with 400 and creates no key', async (rate) => {
      const res = await request(app).post('/api/v1/agent/api-keys').send({ keyName: 'K', rateLimitPerMin: rate });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/rateLimitPerMin must be a whole number from 1 to 600/);
      expect(mockGenerateKey).not.toHaveBeenCalled();
    });

    it('a missing or null rate means the default: the service gets undefined', async () => {
      await request(app).post('/api/v1/agent/api-keys').send({ keyName: 'K' });
      await request(app).post('/api/v1/agent/api-keys').send({ keyName: 'K', rateLimitPerMin: null });
      expect(mockGenerateKey.mock.calls.map((c) => c[3])).toEqual([undefined, undefined]);
    });

    it('checkRateLimitPerMin: NaN and Infinity (which JSON cannot carry, but a caller in process can) are refused', () => {
      expect(checkRateLimitPerMin(NaN)).toMatchObject({ ok: false });
      expect(checkRateLimitPerMin(Infinity)).toMatchObject({ ok: false });
      expect(checkRateLimitPerMin(-Infinity)).toMatchObject({ ok: false });
      expect(checkRateLimitPerMin(undefined)).toEqual({ ok: true, value: undefined });
      expect(checkRateLimitPerMin(null)).toEqual({ ok: true, value: undefined });
      expect(checkRateLimitPerMin(600)).toEqual({ ok: true, value: 600 });
    });

    it('the rate is checked before a scope problem is reported or anything is created', async () => {
      const res = await request(app).post('/api/v1/agent/api-keys').send({ keyName: 'K', scopes: ['tools:read'], rateLimitPerMin: 99999 });
      expect(res.status).toBe(400);
      expect(mockGenerateKey).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/agent/api-keys (list keys)', () => {
    it('should return user keys without hashes', async () => {
      mockGetKeysByUserId.mockResolvedValue([
        {
          keyId: 'key-1',
          keyHash: 'secret-hash',
          maskedKey: 'aw_...abc',
          userId: 'test-user-id',
          keyName: 'Key 1',
          scopes: ['tools:read'],
          rateLimitPerMin: 60,
          createdAt: '2025-01-01T00:00:00.000Z',
          status: 'active',
        },
      ]);

      const res = await request(app).get('/api/v1/agent/api-keys');

      expect(res.status).toBe(200);
      expect(res.body.keys).toHaveLength(1);
      expect(res.body.keys[0].keyHash).toBeUndefined();
      expect(res.body.keys[0].maskedKey).toBe('aw_...abc');
    });

    it('should return empty array when no keys', async () => {
      mockGetKeysByUserId.mockResolvedValue([]);

      const res = await request(app).get('/api/v1/agent/api-keys');

      expect(res.status).toBe(200);
      expect(res.body.keys).toEqual([]);
    });
  });

  describe('DELETE /api/v1/agent/api-keys/:keyId (revoke key)', () => {
    it('should revoke a key', async () => {
      mockRevokeKey.mockResolvedValue(undefined);

      const res = await request(app).delete('/api/v1/agent/api-keys/key-123');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('revoked');
      expect(mockRevokeKey).toHaveBeenCalledWith('key-123', 'test-user-id');
    });

    it('should return 404 when key not found', async () => {
      mockRevokeKey.mockRejectedValue(new Error('API key not found'));

      const res = await request(app).delete('/api/v1/agent/api-keys/nonexistent');

      expect(res.status).toBe(404);
    });

    it('should return 403 when user does not own the key', async () => {
      mockRevokeKey.mockRejectedValue(new Error('Unauthorized'));

      const res = await request(app).delete('/api/v1/agent/api-keys/key-other');

      expect(res.status).toBe(403);
    });
  });
});
