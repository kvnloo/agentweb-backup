import { Request, Response, NextFunction } from 'express';

// Mock agentApiKeyService
jest.mock('../services/agentApiKeyService', () => ({
  agentApiKeyService: {
    validateKey: jest.fn(),
  },
}));

// Mock rateLimiter
jest.mock('../middleware/rateLimiter', () => ({
  rateLimiter: {
    check: jest.fn(),
  },
}));

import { authenticateAgentApiKey, requireScope, AgentApiRequest } from '../middleware/agentApiAuth';
import { agentApiKeyService } from '../services/agentApiKeyService';
import { rateLimiter } from '../middleware/rateLimiter';

const mockValidateKey = agentApiKeyService.validateKey as jest.Mock;
const mockRateLimitCheck = rateLimiter.check as jest.Mock;

function createMockReqRes() {
  const req = {
    headers: {},
  } as Partial<Request>;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  } as Partial<Response>;

  const next = jest.fn() as NextFunction;

  return { req: req as Request, res: res as Response, next };
}

describe('authenticateAgentApiKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimitCheck.mockReturnValue({ allowed: true, remaining: 59, resetInMs: 60000 });
  });

  it('should return 401 when no Authorization header', async () => {
    const { req, res, next } = createMockReqRes();

    await authenticateAgentApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Missing') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when token does not start with aw_', async () => {
    const { req, res, next } = createMockReqRes();
    req.headers = { authorization: 'Bearer some-jwt-token' };

    await authenticateAgentApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when key is invalid', async () => {
    const { req, res, next } = createMockReqRes();
    req.headers = { authorization: 'Bearer aw_invalidkey' };
    mockValidateKey.mockResolvedValue(null);

    await authenticateAgentApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Invalid') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 429 when rate limit is exceeded', async () => {
    const { req, res, next } = createMockReqRes();
    req.headers = { authorization: 'Bearer aw_validkey' };

    mockValidateKey.mockResolvedValue({
      keyId: 'key-123',
      userId: 'user-123',
      rateLimitPerMin: 60,
      scopes: ['tools:read'],
    });

    mockRateLimitCheck.mockReturnValue({ allowed: false, remaining: 0, resetInMs: 30000 });

    await authenticateAgentApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Rate limit') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should set rate limit headers on success', async () => {
    const { req, res, next } = createMockReqRes();
    req.headers = { authorization: 'Bearer aw_validkey' };

    mockValidateKey.mockResolvedValue({
      keyId: 'key-123',
      userId: 'user-123',
      rateLimitPerMin: 60,
      scopes: ['tools:read', 'tools:execute'],
    });

    mockRateLimitCheck.mockReturnValue({ allowed: true, remaining: 58, resetInMs: 45000 });

    await authenticateAgentApiKey(req, res, next);

    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'X-RateLimit-Limit': '60',
        'X-RateLimit-Remaining': '58',
      })
    );
    expect(next).toHaveBeenCalled();
  });

  it('should set agentApiKey and agentUserId on request', async () => {
    const { req, res, next } = createMockReqRes();
    req.headers = { authorization: 'Bearer aw_validkey' };

    const keyRecord = {
      keyId: 'key-123',
      userId: 'user-123',
      rateLimitPerMin: 60,
      scopes: ['tools:read', 'tools:execute'],
    };

    mockValidateKey.mockResolvedValue(keyRecord);

    await authenticateAgentApiKey(req, res, next);

    const agentReq = req as AgentApiRequest;
    expect(agentReq.agentApiKey).toEqual(keyRecord);
    expect(agentReq.agentUserId).toBe('user-123');
    expect(next).toHaveBeenCalled();
  });

  it('should handle service errors gracefully', async () => {
    const { req, res, next } = createMockReqRes();
    req.headers = { authorization: 'Bearer aw_validkey' };
    mockValidateKey.mockRejectedValue(new Error('DynamoDB down'));

    await authenticateAgentApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireScope', () => {
  it('should call next when key has required scope', () => {
    const { req, res, next } = createMockReqRes();
    (req as any).agentApiKey = { scopes: ['tools:read', 'tools:execute'] };

    requireScope('tools:execute')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('should return 403 when key lacks required scope', () => {
    const { req, res, next } = createMockReqRes();
    (req as any).agentApiKey = { scopes: ['tools:read'] };

    requireScope('tools:execute')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('scope') })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when no agentApiKey on request', () => {
    const { req, res, next } = createMockReqRes();

    requireScope('tools:read')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
