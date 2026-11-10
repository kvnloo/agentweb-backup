/**
 * ENG-2906 PR1 — OAuth product capture end to end through the routes:
 *   RFC 8707 `resource` (+ optional `ref`) on /oauth/authorize -> pending row keyed by the PKCE
 *   challenge (the portal consent form does not round-trip extra params) -> auth code ->
 *   token -> usage events + journey. Unknown is allowed and NEVER rejects authorization.
 */
const mockSvc = {
  getClient: jest.fn(),
  createAuthorizationCode: jest.fn(),
  consumeAuthorizationCode: jest.fn(),
  createTokenPair: jest.fn(),
  refreshTokens: jest.fn(),
  validateClientSecret: jest.fn(),
  savePendingAuthorization: jest.fn(),
  takePendingAuthorization: jest.fn(),
};
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: mockSvc }));

const mockStarted = jest.fn().mockResolvedValue(true);
const mockAuthorized = jest.fn().mockResolvedValue(true);
const mockIssued = jest.fn().mockResolvedValue(true);
jest.mock('../services/mcpUsageEventsService', () => ({
  classifyMcpClient: () => 'claude_code',
  recordMcpOAuthStarted: (...a: any[]) => mockStarted(...a),
  recordMcpOAuthAuthorized: (...a: any[]) => mockAuthorized(...a),
  recordMcpOAuthTokenIssued: (...a: any[]) => mockIssued(...a),
}));

const mockJourney = { trackJourney: jest.fn().mockResolvedValue(undefined), identifyJourney: jest.fn().mockResolvedValue(undefined) };
jest.mock('../services/journeyTracking', () => mockJourney);

const mockAttr = {
  recordSignupAttribution: jest.fn().mockResolvedValue(true),
  touchProduct: jest.fn().mockResolvedValue('touched'),
  advanceZomaStage: jest.fn().mockResolvedValue(true),
};
jest.mock('../services/journeyAttribution', () => ({
  ...jest.requireActual('../services/journeyAttribution'),
  journeyAttribution: mockAttr,
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-9', email: 'o@acme.com', isAdmin: false };
    next();
  },
  getUserFromToken: jest.fn().mockResolvedValue({}),
}));

import express from 'express';
import request from 'supertest';
import { setupMcpOAuth } from '../mcp/oauth/oauthRoutes';

const BASE = 'https://api.agentweb.pro';
function app() {
  const a = express();
  a.use(express.json());
  a.use(express.urlencoded({ extended: true }));
  setupMcpOAuth(a);
  return a;
}
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.BACKEND_URL = BASE;
  mockSvc.getClient.mockResolvedValue({ clientId: 'c1', clientName: 'Claude Code', redirectUris: ['http://localhost:9/cb'], tokenEndpointAuthMethod: 'none' });
  mockSvc.savePendingAuthorization.mockResolvedValue(undefined);
  mockSvc.takePendingAuthorization.mockResolvedValue(null);
  mockSvc.createAuthorizationCode.mockResolvedValue({ code: 'code-1' });
  mockSvc.createTokenPair.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresIn: 3600, scope: 'mcp:tools' });
});

const authorize = (extra: Record<string, string>) =>
  request(app())
    .get('/oauth/authorize')
    .query({ response_type: 'code', client_id: 'c1', redirect_uri: 'http://localhost:9/cb', code_challenge: 'ch', code_challenge_method: 'S256', ...extra });

describe('GET /oauth/authorize product capture', () => {
  it('persists zoma + ref for the Meta Toolkit resource, keyed by client and PKCE challenge', async () => {
    const res = await authorize({ resource: `${BASE}/api/meta-toolkit/mcp`, ref: 'hn_launch' });
    expect(res.status).toBe(302);
    expect(mockSvc.savePendingAuthorization).toHaveBeenCalledWith('c1', 'ch', { product: 'zoma', confidence: 'explicit', ref: 'hn_launch' });
    await flush();
    expect(mockStarted.mock.calls[0][0]).toMatchObject({ product: 'zoma' });
  });

  it('maps /mcp to emma_mcp and reads ref from the resource query', async () => {
    await authorize({ resource: `${BASE}/mcp?ref=docs` });
    expect(mockSvc.savePendingAuthorization).toHaveBeenCalledWith('c1', 'ch', { product: 'emma_mcp', confidence: 'explicit', ref: 'docs' });
  });

  it('never rejects for an unknown resource or an invalid ref, and stores nothing to remember', async () => {
    const res = await authorize({ resource: 'https://elsewhere.example/x', ref: 'NOT VALID' });
    expect(res.status).toBe(302);
    expect(mockSvc.savePendingAuthorization).not.toHaveBeenCalled();
    await flush();
    expect(mockStarted.mock.calls[0][0]).toMatchObject({ product: 'unknown' });
  });

  it('a failing pending write never blocks authorization', async () => {
    mockSvc.savePendingAuthorization.mockRejectedValue(new Error('dynamo down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await authorize({ resource: `${BASE}/mcp` });
    expect(res.status).toBe(302);
  });
});

describe('POST /oauth/authorize/decision product propagation', () => {
  const decide = () =>
    request(app())
      .post('/oauth/authorize/decision')
      .type('form')
      .send({ client_id: 'c1', redirect_uri: 'http://localhost:9/cb', code_challenge: 'ch', code_challenge_method: 'S256', approved: 'true' });

  it('puts the pending product + ref on the auth code and attributes a fresh OAuth signup', async () => {
    mockSvc.takePendingAuthorization.mockResolvedValue({ product: 'zoma', confidence: 'explicit', ref: 'hn_launch' });
    const res = await decide();
    expect(res.status).toBe(302);
    expect(mockSvc.takePendingAuthorization).toHaveBeenCalledWith('c1', 'ch');
    expect(mockSvc.createAuthorizationCode.mock.calls[0][0]).toMatchObject({ product: 'zoma', attributionConfidence: 'explicit', ref: 'hn_launch' });
    await flush();
    expect(mockAuthorized.mock.calls[0][0]).toMatchObject({ product: 'zoma' });
    expect(mockAttr.recordSignupAttribution).toHaveBeenCalledWith(
      'user-9',
      { product: 'zoma', path: 'oauth_direct', client: 'claude_code', ref: 'hn_launch', confidence: 'explicit' },
      expect.objectContaining({ createdSince: expect.any(String) }),
    );
  });

  it('infers zoma for the first-party Zoma device client and records a zoma_device signup', async () => {
    mockSvc.getClient.mockResolvedValue({ clientId: 'zoma-device-setup', clientName: 'Zoma (agent setup)', redirectUris: ['http://localhost:9/cb'], tokenEndpointAuthMethod: 'none' });
    await request(app())
      .post('/oauth/authorize/decision')
      .type('form')
      .send({ client_id: 'zoma-device-setup', redirect_uri: 'http://localhost:9/cb', code_challenge: 'ch', approved: 'true' });
    expect(mockSvc.createAuthorizationCode.mock.calls[0][0]).toMatchObject({ product: 'zoma', attributionConfidence: 'inferred' });
    await flush();
    expect(mockAttr.recordSignupAttribution.mock.calls[0][1]).toMatchObject({ product: 'zoma', path: 'zoma_device', client: 'zoma_device' });
  });

  it('unknown product still issues a code (attribution is never an authorization restriction)', async () => {
    mockSvc.takePendingAuthorization.mockRejectedValue(new Error('dynamo down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await decide();
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('code=code-1');
    expect(mockSvc.createAuthorizationCode.mock.calls[0][0]).toMatchObject({ product: 'unknown', attributionConfidence: 'unknown' });
  });
});

describe('POST /oauth/token product propagation', () => {
  const codeRecord = (extra: Record<string, unknown> = {}) => ({
    code: 'code-1', clientId: 'c1', userId: 'user-9', redirectUri: 'http://localhost:9/cb', scope: 'mcp:tools', ...extra,
  });

  it('carries the code product onto the token pair, the usage event and the connected journey step', async () => {
    mockSvc.consumeAuthorizationCode.mockResolvedValue(codeRecord({ product: 'zoma', attributionConfidence: 'explicit' }));
    const res = await request(app()).post('/oauth/token').send({ grant_type: 'authorization_code', code: 'code-1', client_id: 'c1', code_verifier: 'v' });
    expect(res.status).toBe(200);
    expect(mockSvc.createTokenPair.mock.calls[0][0]).toMatchObject({ product: 'zoma' });
    await flush();
    expect(mockIssued.mock.calls[0][0]).toMatchObject({ product: 'zoma' });
    expect(mockJourney.trackJourney).toHaveBeenCalledWith({ userId: 'user-9' }, 'connected', expect.objectContaining({ product: 'zoma' }));
    expect(mockAttr.touchProduct).toHaveBeenCalledWith('user-9', 'zoma');
    expect(mockAttr.advanceZomaStage).toHaveBeenCalledWith('user-9', 'connected');
  });

  it('fills an unknown code product from the token request resource (RFC 8707 at the token endpoint)', async () => {
    mockSvc.consumeAuthorizationCode.mockResolvedValue(codeRecord());
    await request(app())
      .post('/oauth/token')
      .send({ grant_type: 'authorization_code', code: 'code-1', client_id: 'c1', code_verifier: 'v', resource: `${BASE}/mcp` });
    expect(mockSvc.createTokenPair.mock.calls[0][0]).toMatchObject({ product: 'emma_mcp' });
  });

  it('a legacy code without product issues a token with product unknown and no zoma stage', async () => {
    mockSvc.consumeAuthorizationCode.mockResolvedValue(codeRecord());
    const res = await request(app()).post('/oauth/token').send({ grant_type: 'authorization_code', code: 'code-1', client_id: 'c1', code_verifier: 'v' });
    expect(res.status).toBe(200);
    expect(mockSvc.createTokenPair.mock.calls[0][0]).toMatchObject({ product: 'unknown' });
    await flush();
    expect(mockAttr.advanceZomaStage).not.toHaveBeenCalled();
    expect(mockAttr.touchProduct).not.toHaveBeenCalled();
  });
});
