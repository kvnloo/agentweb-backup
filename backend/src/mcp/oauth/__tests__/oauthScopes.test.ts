/**
 * The opt-in `email:read` OAuth scope: advertised, parsed as a closed set,
 * consented to only from a non-delegated session, carried code → access →
 * refresh without ever widening, and absent on legacy records.
 * Real service + routes over the stateful DynamoDB fixture.
 */
import { OAuthDynamoFixture } from './fixtures/dynamo';
const mockDb = new OAuthDynamoFixture();
const mockAuthState: { delegated: boolean } = { delegated: false };
jest.mock('aws-sdk', () => ({ __esModule: true, default: { DynamoDB: { DocumentClient: jest.fn(() => mockDb) } } }));
jest.mock('../../../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user', email: 'user@example.com', isAdmin: false };
    if (mockAuthState.delegated) {
      req.delegateInfo = { adminUserId: 'admin', adminEmail: 'admin@example.com', isDelegated: true };
    }
    next();
  },
  getUserFromToken: jest.fn(),
}));
jest.mock('../../../services/mcpUsageEventsService', () => ({
  classifyMcpClient: () => 'hermes', recordMcpOAuthStarted: async () => true,
  recordMcpOAuthAuthorized: async () => true, recordMcpOAuthTokenIssued: async () => true,
}));
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupMcpOAuth } from '../oauthRoutes';
import { McpOAuthService } from '../oauthService';
import { grantedOAuthScopes, parseRequestedScopes } from '../oauthScopes';

const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const verifier = 'a'.repeat(43);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const redirect = 'http://127.0.0.1:49152/callback';
const service = new McpOAuthService();
const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: true })); setupMcpOAuth(app);
let client: any;

beforeEach(async () => {
  jest.clearAllMocks(); mockDb.rows.clear(); mockAuthState.delegated = false;
  client = await service.registerClient({ clientName: 'native', redirectUris: [redirect] });
});

function row(token: string) { return mockDb.rows.get(`AW-MCPOAuthTokens:${hash(token)}`); }
function codeRows() { return [...mockDb.rows.entries()].filter(([k]) => k.startsWith('AW-MCPOAuthCodes:')).map(([, v]) => v); }
function decide(scope: string | undefined) {
  return request(app).post('/oauth/authorize/decision').type('form').send({
    client_id: client.clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256',
    approved: 'true', ...(scope !== undefined && { scope }),
  });
}
function exchange(code: string) {
  return request(app).post('/oauth/token').send({ grant_type: 'authorization_code', code,
    client_id: client.clientId, redirect_uri: redirect, code_verifier: verifier });
}
function refresh(token: string, scope?: string) {
  return request(app).post('/oauth/token').send({ grant_type: 'refresh_token', refresh_token: token,
    client_id: client.clientId, ...(scope !== undefined && { scope }) });
}
async function signIn(scope: string) {
  const decision = await decide(scope);
  expect(decision.status).toBe(302);
  const code = new URL(decision.headers.location).searchParams.get('code')!;
  const tokens = await exchange(code);
  expect(tokens.status).toBe(200);
  return tokens.body;
}

describe('scope parsing', () => {
  it('defaults to mcp:tools, dedupes, canonicalises, and rejects unknown scopes', () => {
    expect(parseRequestedScopes(undefined)).toEqual(['mcp:tools']);
    expect(parseRequestedScopes('  ')).toEqual(['mcp:tools']);
    expect(parseRequestedScopes('email:read  mcp:tools email:read')).toEqual(['mcp:tools', 'email:read']);
    expect(parseRequestedScopes('mcp:tools email:send')).toBeNull();
    expect(parseRequestedScopes('MCP:TOOLS')).toBeNull();
  });
});

describe('metadata', () => {
  it('advertises email:read in both metadata documents', async () => {
    const as = await request(app).get('/.well-known/oauth-authorization-server');
    const pr = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(as.body.scopes_supported).toEqual(['mcp:tools', 'email:read']);
    expect(pr.body.scopes_supported).toEqual(['mcp:tools', 'email:read']);
  });
});

describe('GET /oauth/authorize', () => {
  const authorize = (scope?: string) => request(app).get('/oauth/authorize').query({
    response_type: 'code', client_id: client.clientId, redirect_uri: redirect, state: 's1',
    code_challenge: challenge, code_challenge_method: 'S256', ...(scope !== undefined && { scope }),
  });

  it('rejects an unknown scope with invalid_scope back to the client', async () => {
    const res = await authorize('mcp:tools admin:all');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(`${loc.origin}${loc.pathname}`).toBe(redirect);
    expect(loc.searchParams.get('error')).toBe('invalid_scope');
    expect(loc.searchParams.get('state')).toBe('s1');
  });

  it('forwards the requested email:read scope to the consent page', async () => {
    const res = await authorize('mcp:tools email:read');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.pathname).toBe('/oauth/authorize');
    expect(loc.searchParams.get('scope')).toBe('mcp:tools email:read');
  });

  it('defaults a missing scope to mcp:tools', async () => {
    const res = await authorize();
    expect(new URL(res.headers.location).searchParams.get('scope')).toBe('mcp:tools');
  });
});

describe('POST /oauth/authorize/decision', () => {
  it('rejects an unknown scope and mints no code', async () => {
    const res = await decide('mcp:tools email:send');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
    expect(codeRows()).toHaveLength(0);
  });

  it('a delegated (impersonated) session cannot grant email:read', async () => {
    mockAuthState.delegated = true;
    const res = await decide('mcp:tools email:read');
    expect(res.status).toBe(403);
    expect(res.body.error_description).toMatch(/delegated session/);
    expect(codeRows()).toHaveLength(0);
  });

  it('a delegated session may still grant plain mcp:tools', async () => {
    mockAuthState.delegated = true;
    const res = await decide('mcp:tools');
    expect(res.status).toBe(302);
    expect(codeRows()[0].grantedScopes).toEqual(['mcp:tools']);
  });

  it('persists the consented scopes on the authorization code', async () => {
    await decide('email:read mcp:tools');
    expect(codeRows()[0]).toMatchObject({ scope: 'mcp:tools email:read', grantedScopes: ['mcp:tools', 'email:read'] });
  });
});

describe('token issuance and refresh', () => {
  it('carries email:read from the code to the access and refresh tokens', async () => {
    const tokens = await signIn('mcp:tools email:read');
    expect(tokens.scope).toBe('mcp:tools email:read');
    const record = await service.validateAccessToken(tokens.access_token);
    expect(grantedOAuthScopes(record)).toEqual(['mcp:tools', 'email:read']);

    const next = await refresh(tokens.refresh_token);
    expect(next.status).toBe(200);
    expect(next.body.scope).toBe('mcp:tools email:read');
    expect(grantedOAuthScopes(await service.validateAccessToken(next.body.access_token))).toEqual(['mcp:tools', 'email:read']);
  });

  it('a refresh cannot widen the grant, and the refused attempt does not consume the token', async () => {
    const tokens = await signIn('mcp:tools');
    const widened = await refresh(tokens.refresh_token, 'mcp:tools email:read');
    expect(widened.status).toBe(400);
    expect(widened.body.error).toBe('invalid_scope');
    expect(row(tokens.access_token).revoked).toBe(false);

    const next = await refresh(tokens.refresh_token);
    expect(next.status).toBe(200);
    expect(grantedOAuthScopes(await service.validateAccessToken(next.body.access_token))).toEqual(['mcp:tools']);
  });

  it('a refresh may narrow the grant', async () => {
    const tokens = await signIn('mcp:tools email:read');
    const narrowed = await refresh(tokens.refresh_token, 'mcp:tools');
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.scope).toBe('mcp:tools');
    expect(grantedOAuthScopes(await service.validateAccessToken(narrowed.body.access_token))).toEqual(['mcp:tools']);
    // ...and the narrowed token cannot widen back.
    expect((await refresh(narrowed.body.refresh_token, 'mcp:tools email:read')).body.error).toBe('invalid_scope');
  });

  it('a refresh with an unknown scope is invalid_scope', async () => {
    const tokens = await signIn('mcp:tools');
    expect((await refresh(tokens.refresh_token, 'email:send')).body.error).toBe('invalid_scope');
  });
});

describe('legacy records (issued before scopes were validated)', () => {
  it('a token with no grantedScopes is mcp:tools only, whatever its scope string says', async () => {
    const pair = await service.createTokenPair({ clientId: client.clientId, userId: 'user', scopes: ['mcp:tools', 'email:read'] });
    const legacy = row(pair.accessToken);
    delete legacy.grantedScopes;
    legacy.scope = 'mcp:tools email:read';
    expect(grantedOAuthScopes(await service.validateAccessToken(pair.accessToken))).toEqual(['mcp:tools']);

    // Its refresh keeps mcp:tools and cannot reach email:read.
    expect((await refresh(pair.refreshToken, 'mcp:tools email:read')).body.error).toBe('invalid_scope');
    const next = await refresh(pair.refreshToken);
    expect(next.status).toBe(200);
    expect(next.body.scope).toBe('mcp:tools');
  });

  it('an authorization code with no grantedScopes issues an mcp:tools token', async () => {
    const decision = await decide('mcp:tools email:read');
    const code = new URL(decision.headers.location).searchParams.get('code')!;
    delete mockDb.rows.get(`AW-MCPOAuthCodes:${code}`).grantedScopes;
    const tokens = await exchange(code);
    expect(tokens.status).toBe(200);
    expect(tokens.body.scope).toBe('mcp:tools');
    expect(grantedOAuthScopes(await service.validateAccessToken(tokens.body.access_token))).toEqual(['mcp:tools']);
  });
});
