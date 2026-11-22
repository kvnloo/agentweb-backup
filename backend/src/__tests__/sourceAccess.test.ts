import express from 'express';
import request from 'supertest';
import axios from 'axios';
import router from '../routes/sourceAccess';
import { inspectSource } from '../services/sourceAccessInventory';
import { userDb, orgDb } from '../services/db';

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn(), getOrgMembers: jest.fn() } }));
jest.mock('../middleware/auth', () => ({ authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'admin', orgId: 'forged', isAdmin: true }; next(); } }));
jest.mock('../utils/crypto', () => ({ decryptPassword: () => ({ password: 'org-token' }) }));
jest.mock('../config/integrations', () => ({ getGoogleDriveConfig: jest.fn() }));
jest.mock('axios');
jest.mock('express-rate-limit', () => ({ rateLimit: () => (_req: any, _res: any, next: any) => next() }));
const app = express();
app.use('/api/source-access', router);
const user = { userId: 'admin', orgId: 'org-a', orgRole: 'admin' };
const org = { orgId: 'org-a', ownerUserId: 'owner', secrets: { clickup_access_token: 'encrypted' } };
const drive = { platform: 'google_drive', account_id: 'drive-id', sharedWithOrg: true, config: { email: 'drive@example.com', access_token: 'drive-token', token_expires_at: Date.now() + 3600000 } };
beforeEach(() => {
  jest.resetAllMocks();
  (userDb.getUserById as jest.Mock).mockResolvedValue(user);
  (orgDb.getOrgById as jest.Mock).mockResolvedValue(org);
  (orgDb.getOrgMembers as jest.Mock).mockResolvedValue([]);
});

test('non-admin is denied before credentials, members or provider requests', async () => {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ ...user, orgRole: 'member', isAdmin: true });
  expect((await request(app).get('/api/source-access')).status).toBe(403);
  expect(orgDb.getOrgMembers).not.toHaveBeenCalled();
  expect(axios.get).not.toHaveBeenCalled();
});
test('owner role from another org cannot authorize the target org', async () => {
  (orgDb.getOrgById as jest.Mock).mockResolvedValue({ ...org, orgId: 'org-b' });
  expect((await request(app).get('/api/source-access')).status).toBe(403);
  expect(axios.get).not.toHaveBeenCalled();
});
test('source IDs cannot select another org or private teammate token', async () => {
  (orgDb.getOrgMembers as jest.Mock).mockResolvedValue([
    { userId: 'foreign', orgId: 'org-b', connected_accounts: [drive] },
    { userId: 'private', orgId: 'org-a', connected_accounts: [{ ...drive, sharedWithOrg: false }] },
  ]);
  for (const owner of ['foreign', 'private']) {
    expect((await request(app).get('/api/source-access').query({ source: JSON.stringify([owner, 'drive-id']) })).status).toBe(404);
  }
  expect(axios.get).not.toHaveBeenCalled();
});
test('fresh same-org admin sees shared sources without credentials', async () => {
  (orgDb.getOrgMembers as jest.Mock).mockResolvedValue([{ userId: 'teammate', orgId: 'org-a', connected_accounts: [drive] }]);
  const response = await request(app).get('/api/source-access');
  expect(response.status).toBe(200);
  expect(response.body.sources).toHaveLength(2);
  expect(JSON.stringify(response.body)).not.toMatch(/token|encrypted|config/);
  expect((await request(app).get('/api/source-access').query({ orgId: 'org-b' })).status).toBe(400);
});
test('ClickUp inventory uses the org token and returns only metadata', async () => {
  (axios.get as jest.Mock).mockImplementation(async (url: string) => ({ data:
    url.endsWith('/user') ? { user: { email: 'connected@example.com' } } :
    url.endsWith('/team') ? { teams: [{ id: 't', name: 'Workspace', secret: 'hidden' }] } :
    url.endsWith('/space') ? { spaces: [{ id: 's', name: 'Space' }] } :
    url.endsWith('/folder') ? { folders: [{ id: 'f', name: 'Folder', parent_folder: 'parent', lists: [{ id: 'embedded', name: 'Embedded list' }] }] } :
    url.endsWith('/list') ? { lists: [{ id: 'l', name: 'List' }] } :
    { docs: [{ id: 'd', name: 'Doc', parent: { type: 6, id: 'l' }, content: 'SECRET CONTENT' }] }
  }));
  const response = await request(app).get('/api/source-access').query({ source: 'clickup' });
  expect(response.status).toBe(200);
  expect(response.body.complete).toBe(true);
  expect(response.body.items).toEqual(expect.arrayContaining([{ id: 'd', name: 'Doc', kind: 'doc', parentId: 'list:l' }]));
  expect(response.body.items).toEqual(expect.arrayContaining([
    { id: 'f', name: 'Folder', kind: 'folder', parentId: 'folder:parent' },
    { id: 'embedded', name: 'Embedded list', kind: 'list', parentId: 'folder:f' },
  ]));
  expect(JSON.stringify(response.body)).not.toMatch(/SECRET CONTENT|hidden|org-token/);
  for (const [url, options] of (axios.get as jest.Mock).mock.calls) {
    expect(options.headers.Authorization).toBe('org-token');
    expect(url).not.toMatch(/pages|\/task\//);
  }
});
test('Drive follows pagination and requests a metadata field allowlist', async () => {
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { user: { emailAddress: 'drive@example.com' } } })
    .mockResolvedValueOnce({ data: { files: [{ id: 'folder', name: 'Folder', mimeType: 'application/vnd.google-apps.folder' }], nextPageToken: 'next' } })
    .mockResolvedValueOnce({ data: { files: [{ id: 'file', name: 'File', mimeType: 'text/plain', parents: ['folder'], content: 'hidden' }] } });
  const inventory = await inspectSource('google_drive', 'token');
  expect(inventory.complete).toBe(true);
  expect(inventory.items[1].parentId).toBe('folder:folder');
  expect((axios.get as jest.Mock).mock.calls[2][1].params.pageToken).toBe('next');
  expect((axios.get as jest.Mock).mock.calls[1][1].params.fields).toBe('nextPageToken,incompleteSearch,files(id,name,mimeType,parents)');
  expect(JSON.stringify(inventory)).not.toContain('hidden');
});
test.each([null, 'wrong', 5, { id: {}, name: 'bad' }, { id: 'a', name: {} }])('malformed per-element metadata is incomplete (%p)', async malformed => {
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { user: { emailAddress: 'drive@example.com' } } })
    .mockResolvedValueOnce({ data: { files: [malformed] } });
  expect((await inspectSource('google_drive', 'token')).complete).toBe(false);
});
test('repeated cursor terminates safely and marks incomplete', async () => {
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { user: { emailAddress: 'drive@example.com' } } })
    .mockResolvedValue({ data: { files: [], nextPageToken: 'repeat' } });
  expect((await inspectSource('google_drive', 'token')).complete).toBe(false);
  expect(axios.get).toHaveBeenCalledTimes(3);
});
test('provider failure retains metadata but never reports complete or leaks error', async () => {
  (axios.get as jest.Mock).mockRejectedValue({ message: 'secret-token', response: { data: 'private-content' } });
  const inventory = await inspectSource('clickup', 'secret-token');
  expect(inventory.complete).toBe(false);
  expect(JSON.stringify(inventory)).not.toMatch(/secret-token|private-content/);
});
test('hard cap bounds even endless unique pagination', async () => {
  let page = 0;
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { user: { emailAddress: 'drive@example.com' } } })
    .mockImplementation(async () => ({ data: { files: Array.from({ length: 100 }, (_, i) => ({ id: `${page}-${i}`, name: 'File', mimeType: 'text/plain' })), nextPageToken: String(++page) } }));
  const inventory = await inspectSource('google_drive', 'token');
  expect(inventory.items).toHaveLength(2000);
  expect(inventory.complete).toBe(false);
  expect(axios.get).toHaveBeenCalledTimes(21);
});
test('an inaccessible ClickUp hierarchy does not hide reachable docs', async () => {
  (axios.get as jest.Mock).mockImplementation(async (url: string) => {
    if (url.endsWith('/space')) throw new Error('Forbidden');
    return { data: url.endsWith('/user') ? { user: { email: 'connected@example.com' } } :
      url.endsWith('/team') ? { teams: [{ id: 't', name: 'Workspace' }] } :
      { docs: [{ id: 'd', name: 'Shared doc' }] } };
  });
  const result = await inspectSource('clickup', 'token');
  expect(result.complete).toBe(false);
  expect(result.items.some(item => item.id === 'd')).toBe(true);
});
test('Drive incompleteSearch cannot be mistaken for a complete security inventory', async () => {
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { user: { emailAddress: 'drive@example.com' } } })
    .mockResolvedValueOnce({ data: { files: [], incompleteSearch: true } });
  expect((await inspectSource('google_drive', 'token')).complete).toBe(false);
});
test('shared Drive inventory uses only the matching org member credential', async () => {
  (orgDb.getOrgMembers as jest.Mock).mockResolvedValue([{ userId: 'teammate', orgId: 'org-a', connected_accounts: [drive] }]);
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { user: { emailAddress: 'drive@example.com' } } })
    .mockResolvedValueOnce({ data: { files: [] } });
  const response = await request(app).get('/api/source-access').query({ source: JSON.stringify(['teammate', 'drive-id']) });
  expect(response.status).toBe(200);
  expect(response.body.complete).toBe(true);
  expect((axios.get as jest.Mock).mock.calls[0][1].headers.Authorization).toBe('Bearer drive-token');
});
test('refresh re-reads provider scope with the same stored connection', async () => {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ ...user, connected_accounts: [drive] });
  for (const filename of ['Before permission change', 'After permission change']) {
    (axios.get as jest.Mock).mockResolvedValueOnce({ data: { user: { emailAddress: 'drive@example.com' } } })
      .mockResolvedValueOnce({ data: { files: [{ id: filename, name: filename, mimeType: 'text/plain' }] } });
  }
  const first = await request(app).get('/api/source-access').query({ source: JSON.stringify(['admin', 'drive-id']) });
  const second = await request(app).get('/api/source-access').query({ source: JSON.stringify(['admin', 'drive-id']) });
  expect(first.body.items[0].name).toBe('Before permission change');
  expect(second.body.items[0].name).toBe('After permission change');
  expect(axios.post).not.toHaveBeenCalled();
});
test('expired Drive token refresh stays in memory and is bounded', async () => {
  const { getGoogleDriveConfig } = require('../config/integrations');
  getGoogleDriveConfig.mockResolvedValue({ clientId: 'client', clientSecret: 'secret' });
  (userDb.getUserById as jest.Mock).mockResolvedValue({ ...user, connected_accounts: [{ ...drive, config: { ...drive.config, token_expires_at: 1, refresh_token: 'refresh' } }] });
  (axios.post as jest.Mock).mockResolvedValue({ data: { access_token: 'fresh-token' } });
  (axios.get as jest.Mock).mockResolvedValueOnce({ data: { user: { emailAddress: 'drive@example.com' } } })
    .mockResolvedValueOnce({ data: { files: [] } });
  const response = await request(app).get('/api/source-access').query({ source: JSON.stringify(['admin', 'drive-id']) });
  expect(response.status).toBe(200);
  expect((axios.post as jest.Mock).mock.calls[0][2]).toMatchObject({ timeout: 5000, maxRedirects: 0 });
  expect((axios.get as jest.Mock).mock.calls[0][1].headers.Authorization).toBe('Bearer fresh-token');
  expect(JSON.stringify(response.body)).not.toContain('fresh-token');
});
