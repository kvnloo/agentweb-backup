import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import axios from 'axios';
process.env.JWT_SECRET = 'clickup-admin-test-secret';
process.env.CUSTOMER_FRONTEND_URL = 'https://app.example.com';
const mockUser = { userId: 'admin', orgId: 'org', orgRole: 'admin', email: 'admin@example.com' };
const mockOrg = { orgId: 'org', ownerUserId: 'owner' };
jest.mock('../middleware/auth', () => ({ authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'admin' }; next(); } }));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(async () => mockUser), updateUser: jest.fn() },
  orgDb: { getOrgById: jest.fn(async () => mockOrg), setOrgSecret: jest.fn(), removeOrgSecret: jest.fn() },
}));
jest.mock('../services/clickupService', () => ({ getAccessToken: jest.fn(), getWorkspaces: jest.fn(), getClickUpIdentity: jest.fn(), listDocs: jest.fn(), listTasks: jest.fn() }));
jest.mock('../utils/crypto', () => ({ encryptPassword: jest.fn(() => 'encrypted') }));
jest.mock('../services/adminAuditLog', () => ({ recordAdminAudit: jest.fn() }));
jest.mock('../config/integrations', () => ({ getClickUpConfig: jest.fn(async () => ({ authorizationUrl: 'https://app.clickup.com/api', tokenUrl: 'https://api.clickup.com/token', clientId: 'client', clientSecret: 'secret', redirectUri: 'https://api.example.com/callback' })) }));
jest.mock('axios');
import router from '../routes/clickupAuth';
import { orgDb, userDb } from '../services/db';
import * as clickup from '../services/clickupService';
import { recordAdminAudit } from '../services/adminAuditLog';
const app = express(); app.use(express.json()); app.use('/clickup', router);
const current = { id: '1', email: 'integration@xcures.ai', username: 'integration' };
const incoming = { id: '2', email: 'personal@example.com', username: 'personal' };
const workspaces = [{ id: 'ws', name: 'xCures' }];
const state = () => jwt.sign({ userId: 'admin', orgId: 'org', nonce: 'nonce', frontendUrl: 'https://app.example.com' }, process.env.JWT_SECRET!, { expiresIn: '15m' });
beforeEach(() => {
  jest.clearAllMocks(); mockUser.orgRole = 'admin'; mockUser.orgId = 'org';
  (clickup.getAccessToken as jest.Mock).mockResolvedValue('old-token');
  (clickup.getWorkspaces as jest.Mock).mockResolvedValue(workspaces);
  (clickup.getClickUpIdentity as jest.Mock).mockImplementation(async (token) => token === 'old-token' ? current : incoming);
});
it.each(['/init', '/connect', '/save-token', '/disconnect', '/finalize', '/callback'])('rejects a member at %s before provider calls or writes', async (path) => {
  mockUser.orgRole = 'member';
  const req = ['/init', '/callback'].includes(path) ? request(app).get(`/clickup${path}`).query({ state: state(), code: 'code' }) : request(app).post(`/clickup${path}`).send({ token: 'new-token', code: 'code', state: state(), tokenSessionId: 'session' });
  expect((await req).status).toBe(403);
  expect(axios.post).not.toHaveBeenCalled(); expect(clickup.getWorkspaces).not.toHaveBeenCalled();
  expect(orgDb.setOrgSecret).not.toHaveBeenCalled(); expect(orgDb.removeOrgSecret).not.toHaveBeenCalled();
});
it('lets members read an existing connection without rewriting secrets', async () => {
  mockUser.orgRole = 'member';
  const result = await request(app).get('/clickup/status');
  expect(result.body).toMatchObject({ connected: true, identity: current, workspaces });
  expect(orgDb.setOrgSecret).not.toHaveBeenCalled(); expect(userDb.updateUser).not.toHaveBeenCalled();
});
it('requires confirmation of a changed identity before replacing the token', async () => {
  const warning = await request(app).post('/clickup/save-token').send({ token: 'new-token' });
  expect(warning.status).toBe(409);
  expect(warning.body).toMatchObject({ code: 'CLICKUP_IDENTITY_CHANGED', currentIdentity: current, incomingIdentity: incoming });
  expect(orgDb.setOrgSecret).not.toHaveBeenCalled();
  const result = await request(app).post('/clickup/save-token').send({ token: 'new-token', confirmationToken: warning.body.confirmationToken });
  expect(result.status).toBe(200);
  expect(orgDb.setOrgSecret).toHaveBeenCalledWith('org', 'clickup_access_token', 'encrypted');
  expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'clickup_connect', actorUserId: 'admin', orgId: 'org', clickupIdentity: incoming }));
});
it('does not accept an unsigned confirmation', async () => {
  expect((await request(app).post('/clickup/save-token').send({ token: 'new-token', confirmationToken: 'yes' })).status).toBe(409);
  expect(orgDb.setOrgSecret).not.toHaveBeenCalled();
});
it('logs disconnect identity and actor', async () => {
  expect((await request(app).post('/clickup/disconnect')).status).toBe(200);
  expect(recordAdminAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'clickup_disconnect', actorUserId: 'admin', clickupIdentity: current }));
});
it('rejects unsigned callback state and changed org membership', async () => {
  expect((await request(app).get('/clickup/callback').query({ code: 'code', state: 'forged' })).status).toBe(403);
  const signed = state(); mockUser.orgId = 'another-org';
  expect((await request(app).get('/clickup/callback').query({ code: 'code', state: signed })).status).toBe(403);
});
it('keeps status connected when identity lookup is temporarily unavailable', async () => {
  (clickup.getClickUpIdentity as jest.Mock).mockRejectedValue(new Error('timeout'));
  const result = await request(app).get('/clickup/status');
  expect(result.body).toMatchObject({ connected: true, identity: null, workspaces });
  expect(orgDb.setOrgSecret).not.toHaveBeenCalled();
});
it('allows an owner to connect the same identity without warning', async () => {
  mockUser.orgRole = 'owner';
  (clickup.getClickUpIdentity as jest.Mock).mockResolvedValue(current);
  expect((await request(app).post('/clickup/save-token').send({ token: 'new-token' })).status).toBe(200);
});
it('OAuth retains session across warning and consumes it only on confirmation', async () => {
  (axios.post as jest.Mock).mockResolvedValue({ data: { access_token: 'new-token' } });
  const init = await request(app).get('/clickup/init').query({ frontend_url: 'https://app.example.com' });
  const signedState = new URL(init.body.url).searchParams.get('state');
  expect((await request(app).get('/clickup/callback').query({ state: signedState, code: 'code' })).status).toBe(302);
  const finalized = await request(app).post('/clickup/finalize').send({ state: signedState, code: 'code' });
  const tokenSessionId = finalized.body.tokenSessionId;
  const warning = await request(app).post('/clickup/connect').send({ tokenSessionId });
  expect(warning.status).toBe(409);
  expect(orgDb.setOrgSecret).not.toHaveBeenCalled();
  const confirmed = await request(app).post('/clickup/connect').send({ tokenSessionId, confirmationToken: warning.body.confirmationToken });
  expect(confirmed.status).toBe(200);
  expect((await request(app).post('/clickup/connect').send({ tokenSessionId })).status).toBe(401);
});
it('does not reuse confirmation for a different candidate or changed current connection', async () => {
  const warning = await request(app).post('/clickup/save-token').send({ token: 'new-token' });
  expect((await request(app).post('/clickup/save-token').send({ token: 'another-token', confirmationToken: warning.body.confirmationToken })).status).toBe(409);
  (clickup.getAccessToken as jest.Mock).mockResolvedValue('changed-token');
  (clickup.getClickUpIdentity as jest.Mock).mockImplementation(async token => token === 'changed-token' ? current : incoming);
  expect((await request(app).post('/clickup/save-token').send({ token: 'new-token', confirmationToken: warning.body.confirmationToken })).status).toBe(409);
  expect(orgDb.setOrgSecret).not.toHaveBeenCalled();
});
it('warns before replacing a connection whose identity cannot be read', async () => {
  (clickup.getClickUpIdentity as jest.Mock).mockImplementation(async token => { if (token === 'old-token') throw new Error('revoked'); return incoming; });
  const result = await request(app).post('/clickup/save-token').send({ token: 'new-token' });
  expect(result.status).toBe(409); expect(result.body.currentIdentity).toBeNull();
  expect(orgDb.setOrgSecret).not.toHaveBeenCalled();
});
it('rejects wrong-type OAuth tokens without creating a session', async () => {
  (axios.post as jest.Mock).mockResolvedValue({ data: { access_token: { token: 'wrong' } } });
  expect((await request(app).post('/clickup/finalize').send({ state: state(), code: 'code' })).status).toBe(500);
});

it('disconnects a legacy per-user connection without removing unrelated secrets', async () => {
  (mockUser as any).secrets = { clickup_access_token: 'encrypted-legacy', another_token: 'keep' };
  try {
    expect((await request(app).post('/clickup/disconnect')).status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('admin', { secrets: { another_token: 'keep' } });
  } finally { delete (mockUser as any).secrets; }
});
it.each([null, 42, {}, '', '   '])('rejects invalid personal token %p without writes', async token => {
  expect((await request(app).post('/clickup/save-token').send({ token })).status).toBe(400);
  expect(orgDb.setOrgSecret).not.toHaveBeenCalled();
});
it('does not disconnect merely because a status provider request failed', async () => {
  (clickup.getWorkspaces as jest.Mock).mockRejectedValueOnce(new Error('timeout'));
  expect((await request(app).get('/clickup/status')).status).toBe(502);
  expect(orgDb.removeOrgSecret).not.toHaveBeenCalled(); expect(userDb.updateUser).not.toHaveBeenCalled();
});

it.each(['https://attacker.example', 'javascript:alert(1)', 'not-a-url'])('does not sign an untrusted frontend origin %s', async frontend_url => {
  expect((await request(app).get('/clickup/init').query({ frontend_url })).status).toBe(400);
});
