/**
 * ENG-2906 PR1 — product persists on the auth code and the token record, and survives refresh
 * rotation. The pending-authorization row can never be redeemed as an authorization code.
 */
const mockPut = jest.fn();
const mockGet = jest.fn();
const mockDelete = jest.fn();
const mockQuery = jest.fn();
const mockTransact = jest.fn();
jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: (p: any) => ({ promise: () => mockPut(p) }),
        get: (p: any) => ({ promise: () => mockGet(p) }),
        delete: (p: any) => ({ promise: () => mockDelete(p) }),
        query: (p: any) => ({ promise: () => mockQuery(p) }),
        update: () => ({ promise: () => Promise.resolve({}) }),
        transactWrite: (p: any) => ({ promise: () => mockTransact(p) }),
      })),
    },
  },
}));
jest.mock('../services/evaluationPersistence', () => ({
  writeWithEvaluationGuard: (doc: any, _u: any, _p: any, op: any) =>
    op.Put ? doc.put(op.Put).promise() : doc.update(op.Update).promise(),
  activeEvaluationCondition: jest.fn(),
  isTransactionConditionFailure: () => false,
}));
jest.mock('../services/evaluationPolicy', () => ({ isEvaluationUser: () => false, requireActiveEvaluation: jest.fn() }));

import crypto from 'crypto';
import { McpOAuthService } from '../mcp/oauth/oauthService';

beforeEach(() => {
  jest.clearAllMocks();
  mockPut.mockResolvedValue({});
  mockDelete.mockResolvedValue({});
  mockTransact.mockResolvedValue({});
});

describe('ENG-2906 oauthService product persistence', () => {
  it('stores product, confidence and ref on the authorization code', async () => {
    await new McpOAuthService().createAuthorizationCode({
      clientId: 'c1', userId: 'u1', redirectUri: 'http://localhost/cb', scope: 'mcp:tools', codeChallenge: 'ch', codeChallengeMethod: 'S256',
      product: 'zoma', attributionConfidence: 'explicit', ref: 'hn',
    });
    expect(mockPut.mock.calls[0][0].Item).toMatchObject({ product: 'zoma', attributionConfidence: 'explicit', ref: 'hn' });
  });

  it('stores product on the token record', async () => {
    await new McpOAuthService().createTokenPair({ clientId: 'c1', userId: 'u1', scope: 'mcp:tools', product: 'emma_mcp' });
    expect(mockPut.mock.calls[0][0].Item).toMatchObject({ product: 'emma_mcp' });
  });

  it('propagates product to the rotated token on refresh', async () => {
    const svc = new McpOAuthService();
    const refresh = 'r'.repeat(96);
    const refreshTokenHash = crypto.createHash('sha256').update(refresh).digest('hex');
    const now = Math.floor(Date.now() / 1000);
    const record = {
      tokenHash: 'root', refreshTokenHash, userId: 'u1', clientId: 'c1', scope: 'mcp:tools', product: 'zoma',
      expiresAt: now + 1000, refreshExpiresAt: now + 1000, familyId: 'root', familyRevoked: false, revoked: false, createdAt: 'x',
    };
    mockQuery.mockResolvedValue({ Items: [{ tokenHash: 'root' }] });
    mockGet.mockResolvedValue({ Item: record });
    const out = await svc.refreshTokens(refresh, 'c1');
    expect(out).not.toBeNull();
    const successor = mockTransact.mock.calls[0][0].TransactItems.find((t: any) => t.Put).Put.Item;
    expect(successor.product).toBe('zoma');
  });

  it('saves a pending authorization that consumeAuthorizationCode can never redeem', async () => {
    const svc = new McpOAuthService();
    await svc.savePendingAuthorization('c1', 'ch', { product: 'zoma', confidence: 'explicit', ref: 'hn' });
    const item = mockPut.mock.calls[0][0].Item;
    expect(item.code).toMatch(/^pending#[0-9a-f]{64}$/);
    expect(item).not.toHaveProperty('used');
    expect(item).toMatchObject({ product: 'zoma', attributionConfidence: 'explicit', ref: 'hn' });
    mockGet.mockResolvedValue({ Item: item });
    await expect(svc.consumeAuthorizationCode(item.code, 'c1', undefined, 'verifier')).resolves.toBeNull();
  });

  it('takes (reads then deletes) the pending authorization for the same client + challenge', async () => {
    const svc = new McpOAuthService();
    await svc.savePendingAuthorization('c1', 'ch', { product: 'emma_mcp', confidence: 'explicit' });
    const item = mockPut.mock.calls[0][0].Item;
    mockGet.mockResolvedValue({ Item: item });
    await expect(svc.takePendingAuthorization('c1', 'ch')).resolves.toEqual({ product: 'emma_mcp', confidence: 'explicit' });
    expect(mockGet.mock.calls[0][0].Key).toEqual({ code: item.code });
    expect(mockDelete).toHaveBeenCalledWith(expect.objectContaining({ Key: { code: item.code } }));
  });

  it('can preserve a Zoma pending request for retries after admission refusal', async () => {
    const svc = new McpOAuthService();
    await svc.savePendingAuthorization('c1', 'ch', { product: 'zoma', confidence: 'explicit' });
    mockGet.mockResolvedValue({ Item: mockPut.mock.calls[0][0].Item });
    await expect(svc.takePendingAuthorization('c1', 'ch', true)).resolves.toMatchObject({ product: 'zoma' });
    expect(mockDelete).not.toHaveBeenCalled();
  });
  it('ignores an expired or malformed pending row', async () => {
    const svc = new McpOAuthService();
    mockGet.mockResolvedValue({ Item: { code: 'pending#x', kind: 'pending_authorization', product: 'nonsense', expiresAt: 1 } });
    await expect(svc.takePendingAuthorization('c1', 'ch')).resolves.toBeNull();
  });
});
