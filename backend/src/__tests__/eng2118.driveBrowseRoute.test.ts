/**
 * ENG-2118 — the route layer of GET /api/oauth/google-drive/access-inventory:
 * the org-admin gate holds on the new ?browse=1 path, bad input is rejected
 * before any provider call, and the legacy flat shape is still served when
 * browse is not asked for.
 */
import request from 'supertest';
import express from 'express';

const mockFilesList = jest.fn();
const mockDrivesList = jest.fn();

jest.mock('googleapis', () => ({
  google: { drive: jest.fn(() => ({ files: { list: mockFilesList }, drives: { list: mockDrivesList } })) },
}));
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn() })),
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'user-1' }; next(); },
}));
jest.mock('../config/integrations', () => ({
  getGoogleDriveConfig: jest.fn().mockResolvedValue({ clientId: 'cid', clientSecret: 'secret' }),
}));
jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'test-secret' }));
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn(),
  getAccountByPlatform: jest.fn(),
}));
jest.mock('../utils/accountSecretRedaction', () => ({ redactAccountSecrets: (a: unknown) => a }));
jest.mock('../services/orgAuthz', () => ({ canInOrg: jest.fn() }));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));

import googleDriveAuthRoutes from '../routes/googleDriveAuth';
import { getAccountByPlatform } from '../services/connectedAccountsDb';
import { canInOrg } from '../services/orgAuthz';
import { userDb, orgDb } from '../services/db';

const app = express();
app.use(express.json());
app.use('/api/oauth/google-drive', googleDriveAuthRoutes);
const URL = '/api/oauth/google-drive/access-inventory';

beforeEach(() => {
  jest.clearAllMocks();
  (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', orgId: 'org-1', orgRole: 'admin' });
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ orgId: 'org-1' });
  (canInOrg as jest.Mock).mockReturnValue(true);
  (getAccountByPlatform as jest.Mock).mockResolvedValue({ config: { email: 'a@b.com', access_token: 't', refresh_token: 'r' } });
  mockDrivesList.mockResolvedValue({ data: { drives: [] } });
  mockFilesList.mockResolvedValue({ data: { files: [{ id: 'f1', name: 'Marketing', mimeType: 'application/vnd.google-apps.folder' }] } });
});

describe('GET access-inventory — browse routing', () => {
  it('returns one page of items with Cache-Control: no-store', async () => {
    const res = await request(app).get(`${URL}?browse=1&pageSize=100`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ connected: true, identity: { email: 'a@b.com' }, items: expect.any(Array) });
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(['Marketing']);
    expect(mockFilesList.mock.calls[0][0]).toMatchObject({ pageSize: 100 });
  });

  it("opens a folder by id and passes the page token through as a parameter, not into the query", async () => {
    await request(app).get(`${URL}?browse=1&parent=abc_123&pageToken=tok-9`);
    const params = mockFilesList.mock.calls[0][0];
    expect(params.q).toBe("'abc_123' in parents and trashed=false");
    expect(params.pageToken).toBe('tok-9');
    expect(params.q).not.toContain('tok-9');
  });

  it.each([
    ['an injection attempt', "parent=x'%20or%20'1'='1"],
    ['an empty id', 'parent='],
    ['a repeated parent (array)', 'parent=a&parent=b'],
    ['an over-long id', `parent=${'a'.repeat(129)}`],
  ])('rejects %s with 400 and never calls Drive', async (_name, qs) => {
    const res = await request(app).get(`${URL}?browse=1&${qs}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid parent' });
    expect(mockFilesList).not.toHaveBeenCalled();
    expect(mockDrivesList).not.toHaveBeenCalled();
  });

  it('rejects an over-long page token with 400', async () => {
    const res = await request(app).get(`${URL}?browse=1&pageToken=${'t'.repeat(2049)}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid pageToken' });
    expect(mockFilesList).not.toHaveBeenCalled();
  });

  it('falls back to 50 for a page size that is not 50/100/200', async () => {
    await request(app).get(`${URL}?browse=1&pageSize=5000`);
    expect(mockFilesList.mock.calls[0][0].pageSize).toBe(50);
  });
});

describe('GET access-inventory — the org-admin gate holds on every path', () => {
  it.each([['browse=1'], ['browse=1&parent=abc'], ['']])('a user with no org gets 403 on ?%s without touching Drive', async (qs) => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1' });
    const res = await request(app).get(`${URL}?${qs}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Org admin access required' });
    expect(mockFilesList).not.toHaveBeenCalled();
  });

  it.each([['browse=1'], ['browse=1&parent=abc'], ['']])('a member without org:accounts:read gets 403 on ?%s without touching Drive', async (qs) => {
    (canInOrg as jest.Mock).mockReturnValue(false);
    const res = await request(app).get(`${URL}?${qs}`);
    expect(res.status).toBe(403);
    expect(mockFilesList).not.toHaveBeenCalled();
  });

  it('checks the capability the inventory is gated on', async () => {
    await request(app).get(`${URL}?browse=1`);
    expect((canInOrg as jest.Mock).mock.calls[0][2]).toBe('org:accounts:read');
  });
});

describe('GET access-inventory — older portal builds', () => {
  it.each([[''], ['browse=0'], ['browse=']])('keeps the original flat inventory for ?%s', async (qs) => {
    const res = await request(app).get(`${URL}?${qs}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('folders');
    expect(res.body).toHaveProperty('sharedDrives');
    expect(res.body).not.toHaveProperty('items');
  });

  it('reports not connected, without calling Drive, when the org has no Drive account', async () => {
    (getAccountByPlatform as jest.Mock).mockResolvedValue(null);
    const res = await request(app).get(`${URL}?browse=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connected: false, items: [] });
    expect(mockFilesList).not.toHaveBeenCalled();
  });
});
