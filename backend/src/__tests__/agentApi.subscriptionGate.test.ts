import express from 'express';
import request from 'supertest';

// Mock auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com', isAdmin: false };
    next();
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

import agentApiRoutes from '../routes/agentApi';

const app = express();
app.use(express.json());
app.use('/api/v1/agent', agentApiRoutes);

describe('Agent API - API Key Access (all authenticated users)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/agent/api-keys', () => {
    it('should return 201 for any authenticated user', async () => {
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
  });

  describe('GET /api/v1/agent/api-keys', () => {
    it('should return 200 for any authenticated user', async () => {
      mockGetKeysByUserId.mockResolvedValue([]);

      const res = await request(app).get('/api/v1/agent/api-keys');

      expect(res.status).toBe(200);
      expect(res.body.keys).toEqual([]);
    });
  });

  describe('DELETE /api/v1/agent/api-keys/:keyId', () => {
    it('should return 200 for any authenticated user', async () => {
      mockRevokeKey.mockResolvedValue(undefined);

      const res = await request(app).delete('/api/v1/agent/api-keys/key-123');

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('revoked');
    });
  });
});
