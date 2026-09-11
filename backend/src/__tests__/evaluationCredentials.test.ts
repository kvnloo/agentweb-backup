const mockGet = jest.fn();
const mockQuery = jest.fn();
const mockWrite = jest.fn(() => ({ promise: async () => ({}) }));
jest.mock('aws-sdk', () => ({ __esModule: true, default: { DynamoDB: { DocumentClient: jest.fn(() => ({ get: mockGet, query: mockQuery, put: mockWrite, update: mockWrite })) } } }));
jest.mock('../services/evaluationStore', () => ({ evaluationStore: { get: jest.fn() } }));
import { evaluationStore } from '../services/evaluationStore';
import { AgentApiKeyService } from '../services/agentApiKeyService';
import { McpOAuthService } from '../mcp/oauth/oauthService';

describe('ENG-1870 revoked evaluation credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', status: 'revoked' });
    const credential = { userId: 'eval_test', status: 'active', revoked: false, keyId: 'test', expiresAt: Math.floor(Date.now() / 1000) + 600, refreshExpiresAt: Math.floor(Date.now() / 1000) + 3600 };
    mockGet.mockReturnValue({ promise: async () => ({ Item: credential }) });
    mockQuery.mockReturnValue({ promise: async () => ({ Items: [{ ...credential, expiresAt: undefined }] }) });
  });
  it('rejects an API key even when its GSI still returns active', async () => {
    expect(await new AgentApiKeyService().validateKey('aw_synthetic')).toBeNull();
    expect(mockWrite).not.toHaveBeenCalled();
  });
  it('rejects an OAuth access token even when its own row is not revoked', async () => {
    expect(await new McpOAuthService().validateAccessToken('synthetic-access')).toBeNull();
  });
  it('cannot refresh a revoked evaluation into a new session', async () => {
    expect(await new McpOAuthService().refreshTokens('synthetic-refresh')).toBeNull();
    expect(mockWrite).not.toHaveBeenCalled();
  });
  it('cannot mint a new API key after revocation', async () => {
    await expect(new AgentApiKeyService().generateKey('eval_test', 'synthetic')).rejects.toThrow();
    expect(mockWrite).not.toHaveBeenCalled();
  });
  it.each([42, {}, [], true])('malformed credential owner %p cannot bypass the evaluation policy', async userId => {
    mockQuery.mockReturnValue({ promise: async () => ({ Items: [{ userId, keyId: 'synthetic', status: 'active', revoked: false, tokenHash: 'synthetic-hash', refreshExpiresAt: Math.floor(Date.now() / 1000) + 600 }] }) });
    mockGet.mockReturnValue({ promise: async () => ({ Item: { userId, revoked: false, expiresAt: Math.floor(Date.now() / 1000) + 600 } }) });
    expect(await new AgentApiKeyService().validateKey('aw_synthetic')).toBeNull();
    expect(await new McpOAuthService().validateAccessToken('synthetic')).toBeNull();
    expect(await new McpOAuthService().refreshTokens('synthetic')).toBeNull();
  });
});
