import { OAuthDynamoFixture } from './fixtures/dynamo';
const mockDb = new OAuthDynamoFixture();
jest.mock('aws-sdk', () => ({ __esModule: true, default: { DynamoDB: { DocumentClient: jest.fn(() => mockDb) } } }));
jest.mock('../../../middleware/auth', () => ({ authenticateToken: jest.fn(), getUserFromToken: jest.fn() }));
jest.mock('../../../services/mcpUsageEventsService', () => ({
  classifyMcpClient: () => 'hermes', recordMcpOAuthStarted: async () => true,
  recordMcpOAuthAuthorized: async () => true, recordMcpOAuthTokenIssued: async () => true,
}));
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupMcpOAuth } from '../oauthRoutes';
import { McpOAuthService } from '../oauthService';
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const verifier = 'a'.repeat(43);
const redirect = 'http://127.0.0.1:49152/callback';
const service = new McpOAuthService();
const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: true })); setupMcpOAuth(app);
let client: any;
beforeEach(async () => {
  jest.clearAllMocks(); mockDb.rows.clear(); mockDb.beforeWrite = undefined; mockDb.queryItems = undefined;
  client = await service.registerClient({ clientName: 'native', redirectUris: [redirect] });
});
async function code(scopes: string[] = ['mcp:tools']) {
  return (await service.createAuthorizationCode({ clientId: client.clientId, userId: 'user', redirectUri: redirect,
    scopes, codeChallenge: crypto.createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' })).code;
}
function exchange(c: string, extras: any = {}) {
  return request(app).post('/oauth/token').send({ grant_type: 'authorization_code', code: c,
    client_id: client.clientId, redirect_uri: redirect, code_verifier: verifier, ...extras });
}
async function pair(scopes: string[] = ['mcp:tools']) { return service.createTokenPair({ clientId: client.clientId, userId: 'user', scopes }); }
function refresh(token: string, extras: any = {}) {
  return request(app).post('/oauth/token').send({ grant_type: 'refresh_token', refresh_token: token, client_id: client.clientId, ...extras });
}
function row(token: string) { return mockDb.rows.get(`AW-MCPOAuthTokens:${hash(token)}`); }

test.each(['wrong', undefined])('invalid verifier %p preserves the code for a subsequent valid exchange', async wrong => {
  const c = await code();
  expect((await exchange(c, { code_verifier: wrong })).status).toBe(400);
  expect((await exchange(c)).status).toBe(200);
  expect((await exchange(c)).status).toBe(400); // same valid verifier on replay
});
test('wrong confidential secret preserves code', async () => {
  client = await service.registerClient({ clientName: 'secret', redirectUris: [redirect], tokenEndpointAuthMethod: 'client_secret_post' });
  const c = await code();
  expect((await exchange(c, { client_secret: 'wrong' })).status).toBe(401);
  expect((await exchange(c, { client_secret: client.clientSecret })).status).toBe(200);
});
test('concurrent valid exchanges issue exactly one pair', async () => {
  const c = await code();
  const results = await Promise.all([exchange(c), exchange(c)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  expect([...mockDb.rows.values()].filter(r => r.refreshTokenHash)).toHaveLength(1);
});
test.each(['used', 'expiresAt', 'clientId', 'redirectUri', 'codeChallenge', 'codeChallengeMethod'])('code write rechecks %s after validation', async field => {
  const c = await code();
  mockDb.beforeWrite = p => {
    if (!p.Key?.code) return;
    const r = mockDb.rows.get(mockDb.key(p));
    r[field] = field === 'used' ? true : field === 'expiresAt' ? 0 : 'changed';
  };
  expect((await exchange(c)).status).toBe(400);
});
test.each([undefined, 'other-client'])('refresh requires issuing client identity %p and preserves the token on denial', async id => {
  const p = await pair();
  expect((await refresh(p.refreshToken, { client_id: id })).status).toBeGreaterThanOrEqual(400);
  expect((await refresh(p.refreshToken)).status).toBe(200);
});
test.each(['client_secret_post', 'client_secret_basic'])('refresh authenticates %s', async method => {
  client = await service.registerClient({ clientName: 'secret', redirectUris: [redirect], tokenEndpointAuthMethod: method });
  const p = await pair();
  expect((await refresh(p.refreshToken)).status).toBe(401);
  expect((await refresh(p.refreshToken, { client_secret: 'wrong' })).status).toBe(401);
  const req = method === 'client_secret_basic'
    ? request(app).post('/oauth/token').auth(client.clientId, client.clientSecret).send({ grant_type: 'refresh_token', refresh_token: p.refreshToken })
    : refresh(p.refreshToken, { client_secret: client.clientSecret });
  expect((await req).status).toBe(200);
});
test('a missing registered client cannot refresh', async () => {
  const p = await pair(); mockDb.rows.delete(`AW-MCPOAuthClients:${client.clientId}`);
  expect((await refresh(p.refreshToken)).status).toBe(401);
});
test('concurrent refresh grants both within the grace window and a late replay disables the family', async () => {
  const p = await pair();
  const results = await Promise.all([refresh(p.refreshToken), refresh(p.refreshToken)]);
  expect(results.map(r => r.status).sort()).toEqual([200, 200]);
  // Outside the duplicate-delivery grace window, re-presenting the consumed original
  // is theft: family revoked and every descendant dies.
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 1000);
  try {
    expect((await refresh(p.refreshToken)).status).toBe(400);
    for (const r of results) expect(await service.validateAccessToken(r.body.access_token)).toBeNull();
  } finally { jest.restoreAllMocks(); }
});
test('duplicate refresh delivery within the grace window mints a sibling pair without revoking', async () => {
  const p = await pair();
  const first = await refresh(p.refreshToken); expect(first.status).toBe(200);
  // Immediate re-presentation of the consumed token (benign race / retried request):
  // 200 with a fresh usable pair, family intact.
  const dupe = await refresh(p.refreshToken); expect(dupe.status).toBe(200);
  expect(dupe.body.refresh_token).not.toBe(first.body.refresh_token);
  expect(await service.validateAccessToken(dupe.body.access_token)).not.toBeNull();
  expect(await service.validateAccessToken(first.body.access_token)).not.toBeNull();
  expect((await refresh(dupe.body.refresh_token)).status).toBe(200);
});
test('replay after the grace window revokes the family', async () => {
  const p = await pair();
  const first = await refresh(p.refreshToken); expect(first.status).toBe(200);
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 1000);
  try {
    expect((await refresh(p.refreshToken)).status).toBe(400);
    expect(await service.validateAccessToken(first.body.access_token)).toBeNull();
  } finally { jest.restoreAllMocks(); }
});
test('replay of an ancestor disables the latest descendant, even with a stale GSI result', async () => {
  const p = await pair(); const stale = { ...row(p.accessToken) };
  const first = await refresh(p.refreshToken); expect(first.status).toBe(200);
  const second = await refresh(first.body.refresh_token); expect(second.status).toBe(200);
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 1000);
  try {
    mockDb.queryItems = [stale];
    expect((await refresh(p.refreshToken)).status).toBe(400);
    mockDb.queryItems = undefined;
    expect((await refresh(second.body.refresh_token)).status).toBe(400);
    expect(await service.validateAccessToken(second.body.access_token)).toBeNull();
  } finally { jest.restoreAllMocks(); }
});
test('wrong client replay cannot disable the legitimate family', async () => {
  const p = await pair(); const next = await refresh(p.refreshToken);
  expect((await refresh(p.refreshToken, { client_id: 'attacker' })).status).toBeGreaterThanOrEqual(400);
  expect((await refresh(next.body.refresh_token)).status).toBe(200);
});
test('family revocation racing a descendant rotation prevents a usable successor', async () => {
  const p = await pair(); const next = await refresh(p.refreshToken);
  mockDb.beforeWrite = params => {
    if (params.TransactItems) row(p.accessToken).familyRevoked = true;
  };
  expect((await refresh(next.body.refresh_token)).status).toBe(400);
  expect(await service.validateAccessToken(next.body.access_token)).toBeNull();
});
test('transaction failure cannot consume the old token or leave an orphan successor', async () => {
  const p = await pair();
  mockDb.beforeWrite = params => { if (params.TransactItems) throw new Error('storage unavailable'); };
  expect((await refresh(p.refreshToken)).status).toBe(500);
  expect(row(p.accessToken).revoked).toBe(false);
  expect([...mockDb.rows.values()].filter(r => r.refreshTokenHash)).toHaveLength(1);
  mockDb.beforeWrite = undefined;
  expect((await refresh(p.refreshToken)).status).toBe(200);
});
test('access expiry stays one hour while family evidence survives until fixed refresh expiry', async () => {
  const p = await pair(); const r = row(p.accessToken);
  expect(r.expiresAt).toBeGreaterThanOrEqual(r.refreshExpiresAt);
  expect(r.accessExpiresAt).toBeLessThan(r.refreshExpiresAt);
  const now = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(now + 3601 * 1000);
  try {
    expect(await service.validateAccessToken(p.accessToken)).toBeNull();
    const next = await refresh(p.refreshToken); expect(next.status).toBe(200);
    expect(row(next.body.access_token).refreshExpiresAt).toBe(r.refreshExpiresAt);
  } finally { jest.restoreAllMocks(); }
});
test('legacy access remains valid but refresh without recoverable lineage requires reauthentication', async () => {
  const p = await pair(); const r = row(p.accessToken);
  delete r.familyId; delete r.familyRevoked; delete r.accessExpiresAt;
  r.expiresAt = Math.floor(Date.now() / 1000) + 3600;
  expect(await service.validateAccessToken(p.accessToken)).not.toBeNull();
  expect((await refresh(p.refreshToken)).status).toBe(400);
  expect(r.revoked).toBe(false);
});
test('missing family evidence fails closed', async () => {
  const p = await pair(); const next = await refresh(p.refreshToken);
  mockDb.rows.delete(`AW-MCPOAuthTokens:${hash(p.accessToken)}`);
  expect((await refresh(next.body.refresh_token)).status).toBe(400);
  expect(await service.validateAccessToken(next.body.access_token)).toBeNull();
});

test.each([['userId', []], ['scope', {}], ['revoked', undefined], ['accessExpiresAt', 'tomorrow'], ['accessExpiresAt', undefined]])('malformed access record %s fails closed', async (field, value) => {
  const p = await pair(); row(p.accessToken)[field as string] = value;
  expect(await service.validateAccessToken(p.accessToken)).toBeNull();
});
test.each([['userId', []], ['scope', {}], ['used', undefined], ['expiresAt', 'tomorrow']])('malformed authorization record %s fails closed', async (field, value) => {
  const c = await code(); mockDb.rows.get(`AW-MCPOAuthCodes:${c}`)[field as string] = value;
  expect((await exchange(c)).status).toBe(400);
  expect(mockDb.update).not.toHaveBeenCalled();
});
test.each([undefined, 'unsupported', 1])('client with malformed auth method %p cannot refresh', async method => {
  const p = await pair(); mockDb.rows.get(`AW-MCPOAuthClients:${client.clientId}`).tokenEndpointAuthMethod = method;
  expect((await refresh(p.refreshToken)).status).toBe(401);
});
test.each([null, {}, [null], [{ tokenHash: 123 }], [{ tokenHash: 'missing' }]])('malformed GSI result %p fails closed', async items => {
  const p = await pair(); mockDb.queryItems = items as any;
  // Override null explicitly too (the normal fixture uses nullish fallback).
  mockDb.query.mockReturnValueOnce({ promise: async () => ({ Items: items as any }) });
  expect((await refresh(p.refreshToken)).status).toBe(400);
});
test('concurrent service rotations both succeed within the grace window', async () => {
  const p = await pair();
  const results = await Promise.all([service.refreshTokens(p.refreshToken, client.clientId), service.refreshTokens(p.refreshToken, client.clientId)]);
  expect(results.filter(Boolean)).toHaveLength(2);
  for (const next of results) expect(await service.validateAccessToken(next!.accessToken)).not.toBeNull();
});
test('incorrect confidential credentials on replay preserve the successor', async () => {
  client = await service.registerClient({ clientName: 'secret', redirectUris: [redirect], tokenEndpointAuthMethod: 'client_secret_post' });
  const p = await pair(); const next = await refresh(p.refreshToken, { client_secret: client.clientSecret });
  expect((await refresh(p.refreshToken, { client_secret: 'wrong' })).status).toBe(401);
  expect((await refresh(next.body.refresh_token, { client_secret: client.clientSecret })).status).toBe(200);
});
test('refresh reports the actual access lifetime near fixed family expiry', async () => {
  const p = await pair(); const expiry = row(p.accessToken).refreshExpiresAt;
  jest.spyOn(Date, 'now').mockReturnValue((expiry - 10) * 1000);
  try {
    const next = await refresh(p.refreshToken); expect(next.status).toBe(200);
    expect(next.body.expires_in).toBe(10);
  } finally { jest.restoreAllMocks(); }
});
test('refresh transaction checks expiry again after the read', async () => {
  const p = await pair();
  mockDb.beforeWrite = params => { if (params.TransactItems) row(p.accessToken).refreshExpiresAt = 0; };
  expect((await refresh(p.refreshToken)).status).toBe(400);
  expect([...mockDb.rows.values()].filter(r => r.refreshTokenHash)).toHaveLength(1);
});

test('a transient DynamoDB transaction conflict retries without consuming the grant twice', async () => {
  const p = await pair();
  mockDb.transactWrite.mockReturnValueOnce({ promise: async () => { throw Object.assign(new Error('conflict'), {
    code: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
  }); } });
  expect((await refresh(p.refreshToken)).status).toBe(200);
  expect([...mockDb.rows.values()].filter(r => r.refreshTokenHash)).toHaveLength(2);
});
test('replay revocation retries a conflict with a descendant transaction', async () => {
  const p = await pair(); const next = await refresh(p.refreshToken);
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61 * 1000);
  try {
    mockDb.update.mockReturnValueOnce({ promise: async () => { throw Object.assign(new Error('conflict'), { code: 'TransactionConflictException' }); } });
    expect((await refresh(p.refreshToken)).status).toBe(400);
    expect(await service.validateAccessToken(next.body.access_token)).toBeNull();
  } finally { jest.restoreAllMocks(); }
});

test.each(['unsupported', '', [], 1, null])('registration rejects unsupported or malformed auth method %p before persistence', async method => {
  const before = mockDb.rows.size;
  const res = await request(app).post('/oauth/register').send({ client_name: 'bad', redirect_uris: [redirect], token_endpoint_auth_method: method });
  expect(res.status).toBe(400);
  expect(mockDb.rows.size).toBe(before);
});

test.each([
  ['authorization_code', 'client_secret_basic'], ['authorization_code', 'client_secret_post'],
  ['refresh_token', 'client_secret_basic'], ['refresh_token', 'client_secret_post'],
])('%s enforces the registered %s credential transport without consuming the grant', async (grant, method) => {
  client = await service.registerClient({ clientName: 'secret', redirectUris: [redirect], tokenEndpointAuthMethod: method });
  const c = grant === 'authorization_code' ? await code() : undefined;
  const p = grant === 'refresh_token' ? await pair() : undefined;
  const body = grant === 'authorization_code'
    ? { grant_type: grant, code: c, code_verifier: verifier }
    : { grant_type: grant, refresh_token: p!.refreshToken };
  const wrong = request(app).post('/oauth/token');
  if (method === 'client_secret_post') wrong.auth(client.clientId, client.clientSecret);
  expect((await wrong.send({ ...body, ...(method === 'client_secret_basic' ? { client_id: client.clientId, client_secret: client.clientSecret } : {}) })).status).toBe(401);
  const correct = request(app).post('/oauth/token');
  if (method === 'client_secret_basic') correct.auth(client.clientId, client.clientSecret);
  expect((await correct.send({ ...body, ...(method === 'client_secret_post' ? { client_id: client.clientId, client_secret: client.clientSecret } : {}) })).status).toBe(200);
});
