/**
 * ENG-2906 PR1 — OAuth product capture end to end through the routes:
 *   RFC 8707 `resource` (+ optional `ref`) on /oauth/authorize -> pending row keyed by the PKCE
 *   challenge (the portal consent form does not round-trip extra params) -> auth code ->
 *   token -> usage events + journey. Unknown is allowed and NEVER rejects authorization.
 */
const mockZomaAuthorizationAdmission = jest.fn().mockResolvedValue('approved');
jest.mock('../services/zomaAuthorizationAdmission', () => ({ admitZomaAuthorizationSignup: (...a: unknown[]) => mockZomaAuthorizationAdmission(...a) }));
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
  markZomaMilestone: jest.fn().mockResolvedValue(true),
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
  getUserFromToken: (...a: any[]) => mockGetUserFromToken(...a),
}));
const mockGetUserFromToken = jest.fn();

import express from 'express';
import request from 'supertest';
import { setupMcpOAuth } from '../mcp/oauth/oauthRoutes';
import { buildMcpAuthChallenge } from '../mcp/oauth/authChallenge';
import {
  discoverOAuthProtectedResourceMetadata,
  extractWWWAuthenticateParams,
  selectResourceURL,
} from '@modelcontextprotocol/sdk/client/auth.js';

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
  mockZomaAuthorizationAdmission.mockResolvedValue('approved');
  process.env.BACKEND_URL = BASE;
  mockSvc.getClient.mockResolvedValue({ clientId: 'c1', clientName: 'Claude Code', redirectUris: ['http://localhost:9/cb'], tokenEndpointAuthMethod: 'none' });
  mockSvc.savePendingAuthorization.mockResolvedValue(undefined);
  mockSvc.takePendingAuthorization.mockResolvedValue(null);
  mockSvc.createAuthorizationCode.mockResolvedValue({ code: 'code-1' });
  mockSvc.createTokenPair.mockResolvedValue({ accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer', expiresIn: 3600, scope: 'mcp:tools' });
  mockGetUserFromToken.mockResolvedValue({});
  delete process.env.MCP_OAUTH_SKIP_CONSENT;
});

const authorize = (extra: Record<string, string>) =>
  request(app())
    .get('/oauth/authorize')
    .query({ response_type: 'code', client_id: 'c1', redirect_uri: 'http://localhost:9/cb', code_challenge: 'ch', code_challenge_method: 'S256', ...extra });

describe('GET /oauth/authorize product capture', () => {
  it('adds a signed signup intent only to Zoma consent redirects', async () => {
    const { isZomaSignup } = require('../services/zomaSignupIntent');
    const zomaRequests: Record<string, string>[] = [{ resource: `${BASE}/api/meta-toolkit/mcp` }, { client_id: 'zoma-device-setup' }];
    for (const extra of zomaRequests) {
      const res = await authorize(extra);
      expect(res.status).toBe(302);
      const signupIntent = new URL(res.headers.location).searchParams.get('mcp_signup_intent');
      expect(isZomaSignup({ signupIntent })).toBe(true);
    }
    const emma = await authorize({ resource: `${BASE}/mcp` });
    expect(new URL(emma.headers.location).searchParams.has('mcp_signup_intent')).toBe(false);
  });
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

  it('blocks a new Zoma account at consent but never consults capacity for Emma', async () => {
    mockZomaAuthorizationAdmission.mockResolvedValue('waitlisted');
    mockSvc.takePendingAuthorization.mockResolvedValue({ product: 'zoma', confidence: 'explicit' });
    expect((await decide()).status).toBe(202);
    expect(mockSvc.createAuthorizationCode).not.toHaveBeenCalled();
    mockZomaAuthorizationAdmission.mockClear();
    mockSvc.takePendingAuthorization.mockResolvedValue({ product: 'emma_mcp', confidence: 'explicit' });
    expect((await decide()).status).toBe(302);
    expect(mockZomaAuthorizationAdmission).not.toHaveBeenCalled();
  });
  it('puts the pending product + ref on the auth code and attributes a consent-page OAuth signup', async () => {
    mockSvc.takePendingAuthorization.mockResolvedValue({ product: 'zoma', confidence: 'explicit', ref: 'hn_launch' });
    const res = await decide();
    expect(res.status).toBe(302);
    expect(mockSvc.takePendingAuthorization).toHaveBeenCalledWith('c1', 'ch', true);
    expect(mockSvc.createAuthorizationCode.mock.calls[0][0]).toMatchObject({ product: 'zoma', attributionConfidence: 'explicit', ref: 'hn_launch' });
    await flush();
    expect(mockAuthorized.mock.calls[0][0]).toMatchObject({ product: 'zoma' });
    expect(mockAttr.recordSignupAttribution).toHaveBeenCalledWith(
      'user-9',
      { product: 'zoma', path: 'oauth_direct', client: 'claude_code', ref: 'hn_launch', confidence: 'explicit' },
      // Only a row register stamped signupSource "mcp" qualifies — never account age.
      { requireSignupSource: 'mcp' },
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

describe('GET /oauth/authorize skip-consent fast path', () => {
  it('attributes the consent-page signup with product + ref exactly like the decision path', async () => {
    process.env.MCP_OAUTH_SKIP_CONSENT = 'true';
    mockGetUserFromToken.mockResolvedValue({ user: { userId: 'user-5' } });
    const res = await authorize({ resource: `${BASE}/api/meta-toolkit/mcp?ref=hn_launch` });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('code=code-1');
    expect(mockSvc.createAuthorizationCode.mock.calls[0][0]).toMatchObject({ userId: 'user-5', product: 'zoma', attributionConfidence: 'explicit', ref: 'hn_launch' });
    await flush();
    expect(mockAttr.recordSignupAttribution).toHaveBeenCalledWith(
      'user-5',
      { product: 'zoma', path: 'oauth_direct', client: 'claude_code', ref: 'hn_launch', confidence: 'explicit' },
      { requireSignupSource: 'mcp' },
    );
  });

  it('falls through to the consent page (no attribution) without an authenticated user', async () => {
    process.env.MCP_OAUTH_SKIP_CONSENT = 'true';
    const res = await authorize({ resource: `${BASE}/mcp` });
    expect(res.headers.location).toContain('/oauth/authorize');
    await flush();
    expect(mockAttr.recordSignupAttribution).not.toHaveBeenCalled();
  });
});

describe('ENG-2781 Databricks-origin OAuth clients and the Zoma seat cap', () => {
  const DATABRICKS_REDIRECT = 'https://dbc-519ea225-682e.cloud.databricks.com/login/oauth/http.html';
  const LOCAL_REDIRECT = 'http://localhost:9/cb';
  const databricksClient = (over: Record<string, unknown> = {}) => ({
    clientId: 'c1', clientName: 'Databricks', redirectUris: [DATABRICKS_REDIRECT], tokenEndpointAuthMethod: 'none', ...over,
  });
  // Seats are full: authorization only passes for a Databricks origin.
  const capFull = (_userId: string, origin?: { databricks?: boolean }) => Promise.resolve(origin?.databricks ? 'approved' : 'waitlisted');
  const decide = (redirectUri = LOCAL_REDIRECT) =>
    request(app())
      .post('/oauth/authorize/decision')
      .type('form')
      .send({ client_id: 'c1', redirect_uri: redirectUri, code_challenge: 'ch', code_challenge_method: 'S256', approved: 'true' });
  const intentFrom = (res: request.Response) => new URL(res.headers.location).searchParams.get('mcp_signup_intent');
  const zoma = { resource: `${BASE}/api/meta-toolkit/mcp` };

  beforeEach(() => {
    mockZomaAuthorizationAdmission.mockImplementation(capFull);
    mockSvc.takePendingAuthorization.mockResolvedValue({ product: 'zoma', confidence: 'explicit' });
    process.env.ZOMA_WAITLIST_ENABLED = 'true';
  });
  afterEach(() => { delete process.env.ZOMA_WAITLIST_ENABLED; });

  describe('authorization', () => {
    it('admits a Databricks client past the full cap, and says so to the admission service', async () => {
      mockSvc.getClient.mockResolvedValue(databricksClient());
      const res = await decide(DATABRICKS_REDIRECT);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('code=code-1');
      expect(mockZomaAuthorizationAdmission).toHaveBeenCalledWith('user-9', { databricks: true, clientId: 'c1' });
    });

    it('still waitlists a client that is not Databricks-origin, with the admission call unchanged', async () => {
      const res = await decide();
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ code: 'waitlisted' });
      expect(mockSvc.createAuthorizationCode).not.toHaveBeenCalled();
      expect(mockZomaAuthorizationAdmission.mock.calls).toEqual([['user-9']]);
    });

    it('a client that only calls itself Databricks is still waitlisted: the registered redirect URI decides', async () => {
      mockSvc.getClient.mockResolvedValue({ ...databricksClient(), redirectUris: [LOCAL_REDIRECT] });
      const res = await decide();
      expect(res.status).toBe(202);
      expect(mockSvc.createAuthorizationCode).not.toHaveBeenCalled();
      expect(mockZomaAuthorizationAdmission.mock.calls).toEqual([['user-9']]);
    });

    it.each([
      'https://databricks.com.evil.example/login/oauth/http.html',
      'https://evildatabricks.com/login/oauth/http.html',
      'https://example.com/callback?next=https://x.cloud.databricks.com/',
    ])('a lookalike redirect %s is still waitlisted', async (uri) => {
      mockSvc.getClient.mockResolvedValue({ ...databricksClient({ clientName: 'Claude' }), redirectUris: [uri] });
      expect((await decide(uri)).status).toBe(202);
      expect(mockZomaAuthorizationAdmission.mock.calls).toEqual([['user-9']]);
    });

    it('mirrors the read-only gate: a client with any Databricks redirect URI is Databricks-origin', async () => {
      mockSvc.getClient.mockResolvedValue({ ...databricksClient({ clientName: 'Claude' }), redirectUris: [LOCAL_REDIRECT, DATABRICKS_REDIRECT] });
      expect((await decide(LOCAL_REDIRECT)).status).toBe(302);
      expect(mockZomaAuthorizationAdmission).toHaveBeenCalledWith('user-9', { databricks: true, clientId: 'c1' });
    });

    it('never consults capacity for Emma, Databricks client or not', async () => {
      mockSvc.getClient.mockResolvedValue(databricksClient());
      mockSvc.takePendingAuthorization.mockResolvedValue({ product: 'emma_mcp', confidence: 'explicit' });
      expect((await decide(DATABRICKS_REDIRECT)).status).toBe(302);
      expect(mockZomaAuthorizationAdmission).not.toHaveBeenCalled();
    });

    it('applies on the skip-consent fast path too', async () => {
      process.env.MCP_OAUTH_SKIP_CONSENT = 'true';
      mockGetUserFromToken.mockResolvedValue({ user: { userId: 'user-5' } });
      mockSvc.getClient.mockResolvedValue(databricksClient());
      const ok = await request(app())
        .get('/oauth/authorize')
        .query({ response_type: 'code', client_id: 'c1', redirect_uri: DATABRICKS_REDIRECT, code_challenge: 'ch', code_challenge_method: 'S256', ...zoma });
      expect(ok.status).toBe(302);
      expect(ok.headers.location).toContain('code=code-1');
      expect(mockZomaAuthorizationAdmission).toHaveBeenCalledWith('user-5', { databricks: true, clientId: 'c1' });

      mockZomaAuthorizationAdmission.mockClear();
      mockSvc.getClient.mockResolvedValue({ ...databricksClient(), redirectUris: [LOCAL_REDIRECT] });
      const waitlisted = await authorize(zoma);
      expect(waitlisted.status).toBe(202);
      expect(mockZomaAuthorizationAdmission.mock.calls).toEqual([['user-5']]);
    });

    it('a gate that is off is decided by the admission service as before: nothing Databricks-specific leaks', async () => {
      delete process.env.ZOMA_WAITLIST_ENABLED;
      mockZomaAuthorizationAdmission.mockResolvedValue('approved');
      expect((await decide()).status).toBe(302);
      expect(mockZomaAuthorizationAdmission.mock.calls).toEqual([['user-9']]);
    });

    it('a gate that is off treats a Databricks-redirect client exactly as main does: ordinary intent, one-argument admission call', async () => {
      delete process.env.ZOMA_WAITLIST_ENABLED;
      mockZomaAuthorizationAdmission.mockResolvedValue('approved');
      mockSvc.getClient.mockResolvedValue(databricksClient());
      const { isDatabricksSignupIntent } = require('../services/zomaSignupIntent');
      const consent = await authorize({ ...zoma, redirect_uri: DATABRICKS_REDIRECT });
      const intent = new URL(consent.headers.location).searchParams.get('mcp_signup_intent');
      expect(isDatabricksSignupIntent(intent)).toBe(false);
      expect(intent!.split('.')).toHaveLength(2);
      const res = await decide(DATABRICKS_REDIRECT);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('code=code-1');
      expect(mockZomaAuthorizationAdmission.mock.calls).toEqual([['user-9']]);
    });

    it('a refusal for a Databricks client (an admin Reject surfaces as a non-approved decision) is a waitlist response, with no code issued', async () => {
      mockZomaAuthorizationAdmission.mockResolvedValue('rejected');
      mockSvc.getClient.mockResolvedValue(databricksClient());
      const res = await decide(DATABRICKS_REDIRECT);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ code: 'waitlisted' });
      expect(mockSvc.createAuthorizationCode).not.toHaveBeenCalled();
    });
  });

  describe('signup intent minted for the consent page', () => {
    const { isZomaSignup, isDatabricksSignupIntent } = require('../services/zomaSignupIntent');

    it('marks the intent Databricks-origin for a Databricks client while the gate is on', async () => {
      mockSvc.getClient.mockResolvedValue(databricksClient());
      const intent = intentFrom(await authorize({ ...zoma, redirect_uri: DATABRICKS_REDIRECT }));
      expect(isZomaSignup({ signupIntent: intent })).toBe(true);
      expect(isDatabricksSignupIntent(intent)).toBe(true);
    });

    it('mints the ordinary intent for any other client', async () => {
      const intent = intentFrom(await authorize(zoma));
      expect(isZomaSignup({ signupIntent: intent })).toBe(true);
      expect(isDatabricksSignupIntent(intent)).toBe(false);
      expect(intent!.split('.')).toHaveLength(2);
    });

    it('mints the ordinary intent for a client that only calls itself Databricks', async () => {
      mockSvc.getClient.mockResolvedValue({ ...databricksClient(), redirectUris: [LOCAL_REDIRECT] });
      const intent = intentFrom(await authorize(zoma));
      expect(isZomaSignup({ signupIntent: intent })).toBe(true);
      expect(isDatabricksSignupIntent(intent)).toBe(false);
    });

    it('mints exactly the old intent while the gate is off, even for a Databricks client', async () => {
      delete process.env.ZOMA_WAITLIST_ENABLED;
      mockSvc.getClient.mockResolvedValue(databricksClient());
      const intent = intentFrom(await authorize({ ...zoma, redirect_uri: DATABRICKS_REDIRECT }));
      expect(isZomaSignup({ signupIntent: intent })).toBe(true);
      expect(isDatabricksSignupIntent(intent)).toBe(false);
      expect(intent!.split('.')).toHaveLength(2);
    });

    it('adds no intent for an Emma authorization, Databricks client or not', async () => {
      mockSvc.getClient.mockResolvedValue(databricksClient());
      const res = await authorize({ resource: `${BASE}/mcp`, redirect_uri: DATABRICKS_REDIRECT });
      expect(new URL(res.headers.location).searchParams.has('mcp_signup_intent')).toBe(false);
    });
  });
});

describe('ref survives the 401 challenge -> protected-resource metadata -> authorize chain', () => {
  const prm = (path: string) => request(app()).get(path);

  it('echoes a valid ref into the metadata resource; drops an invalid one', async () => {
    expect((await prm('/.well-known/oauth-protected-resource/mcp?ref=hn')).body.resource).toBe(`${BASE}/mcp?ref=hn`);
    expect((await prm('/.well-known/oauth-protected-resource/api/meta-toolkit/mcp?ref=hn')).body.resource).toBe(`${BASE}/api/meta-toolkit/mcp?ref=hn`);
    expect((await prm('/.well-known/oauth-protected-resource/mcp?ref=BAD%20REF')).body.resource).toBe(`${BASE}/mcp`);
    expect((await prm('/.well-known/oauth-protected-resource/mcp')).body.resource).toBe(`${BASE}/mcp`);
  });

  it('the 401 challenge points at the ref-bearing metadata URL, never an unescaped value', () => {
    expect(buildMcpAuthChallenge(BASE, undefined, '/mcp', 'hn')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp?ref=hn"`);
    expect(buildMcpAuthChallenge(BASE, undefined, '/mcp', 'a"b')).not.toContain('a"b');
    expect(buildMcpAuthChallenge(BASE)).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });

  // Route the MCP SDK's own discovery fetches into the express app.
  const sdkFetch = async (url: string | URL) => {
    const u = new URL(String(url));
    const res = await request(app()).get(u.pathname + u.search);
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  };

  for (const [label, resourcePath] of [['Emma /mcp', '/mcp'], ['Zoma meta-toolkit', '/api/meta-toolkit/mcp']] as const) {
    it(`${label}: the SDK sends a resource that still carries ref, and authorize records it`, async () => {
      const serverUrl = new URL(`${BASE}${resourcePath}?ref=hn_launch`);
      const challenge = new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': buildMcpAuthChallenge(BASE, undefined, resourcePath, 'hn_launch') },
      });
      const { resourceMetadataUrl } = extractWWWAuthenticateParams(challenge);
      const metadata = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl }, sdkFetch as any);
      // The SDK prefers the metadata's resource over its own server URL.
      const resource = await selectResourceURL(serverUrl, {} as any, metadata);
      expect(resource?.href).toBe(`${BASE}${resourcePath}?ref=hn_launch`);

      await authorize({ resource: resource!.href });
      expect(mockSvc.savePendingAuthorization).toHaveBeenCalledWith('c1', 'ch', expect.objectContaining({ ref: 'hn_launch', confidence: 'explicit' }));
    });
  }

  it('without the challenge, SDK path-aware discovery keeps the server URL query and still carries ref', async () => {
    const serverUrl = new URL(`${BASE}/mcp?ref=docs`);
    const metadata = await discoverOAuthProtectedResourceMetadata(serverUrl, {}, sdkFetch as any);
    const resource = await selectResourceURL(serverUrl, {} as any, metadata);
    expect(resource?.href).toBe(`${BASE}/mcp?ref=docs`);
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
