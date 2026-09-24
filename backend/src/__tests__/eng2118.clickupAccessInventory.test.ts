import express from 'express';
import request from 'supertest';
import axios from 'axios';

jest.mock('axios');
const get = axios.get as jest.Mock;

const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrgById(...a) },
}));
jest.mock('../utils/crypto', () => ({
  decryptPassword: () => ({ password: 'tok' }),
  encryptPassword: () => 'enc',
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: req.headers['x-user'] }; next(); },
}));
jest.mock('../config/integrations', () => ({ getClickUpConfig: jest.fn() }));
jest.mock('../services/orgShareService', () => ({ canEditItem: jest.fn() }));
jest.mock('../config/jwt', () => ({ getJwtSecret: () => 's' }));

import router from '../routes/clickupAuth';
import { buildClickUpAccessInventory } from '../services/integrationAccessService';

const app = express();
app.use('/c', router);

// A token scoped to ONE folder, like agentwebintegration@xcures.ai.
function scopedClickUp(url: string) {
  if (url.endsWith('/v2/user')) return { data: { user: { username: 'AgentWeb Integration', email: 'agentwebintegration@xcures.ai' } } };
  if (url.endsWith('/v2/team')) return { data: { teams: [{ id: 't1', name: 'xCures' }] } };
  if (url.includes('/team/t1/space')) return { data: { spaces: [{ id: 's1', name: 'Marketing' }] } };
  if (url.includes('/space/s1/folder')) return { data: { folders: [{ id: 'f1', name: 'Emma Approved' }] } };
  if (url.includes('/folder/f1/list')) return { data: { lists: [{ id: 'l1', name: 'Campaign Briefs' }] } };
  if (url.includes('/space/s1/list')) return { data: { lists: [] } };
  if (url.includes('/v3/workspaces/t1/docs')) return { data: { docs: [] } };
  throw new Error('unexpected ' + url);
}

beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation(async (url: string) => scopedClickUp(url));
  mockGetOrgById.mockResolvedValue({ orgId: 'o1', ownerUserId: 'owner', secrets: { clickup_access_token: 'enc' } });
});

describe('ENG-2118 ClickUp access inventory', () => {
  it('admin sees exactly the single authorized folder and the connected identity', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'a', orgId: 'o1', orgRole: 'admin' });
    const res = await request(app).get('/c/access-inventory').set('x-user', 'a');
    expect(res.status).toBe(200);
    expect(res.body.identity.email).toBe('agentwebintegration@xcures.ai');
    const folders = res.body.workspaces[0].children[0].children.filter((n: any) => n.type === 'folder');
    expect(folders.map((f: any) => f.name)).toEqual(['Emma Approved']);
    expect(res.headers['cache-control']).toBe('no-store');
    // names only — never content endpoints
    for (const [url] of get.mock.calls) expect(url).not.toMatch(/\/page|\/task\b|\/task\//);
  });

  it('refresh reflects a widened scope (live re-fetch, no cache)', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'a', orgId: 'o1', orgRole: 'owner' });
    await request(app).get('/c/access-inventory').set('x-user', 'a');
    get.mockImplementation(async (url: string) =>
      url.includes('/space/s1/folder')
        ? { data: { folders: [{ id: 'f1', name: 'Emma Approved' }, { id: 'f2', name: 'Social' }] } }
        : url.includes('/folder/f2/list') ? { data: { lists: [] } } : scopedClickUp(url));
    const res = await request(app).get('/c/access-inventory').set('x-user', 'a');
    const folders = res.body.workspaces[0].children[0].children.filter((n: any) => n.type === 'folder');
    expect(folders.map((f: any) => f.name)).toEqual(['Emma Approved', 'Social']);
  });

  it('plain member is refused and no provider call is made', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'm', orgId: 'o1', orgRole: 'member' });
    const res = await request(app).get('/c/access-inventory').set('x-user', 'm');
    expect(res.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });

  it('user without an org is refused', async () => {
    mockGetUserById.mockResolvedValue({ userId: 'x' });
    const res = await request(app).get('/c/access-inventory').set('x-user', 'x');
    expect(res.status).toBe(403);
  });

  it('not connected yields connected:false', async () => {
    const inv = await buildClickUpAccessInventory(null);
    expect(inv.connected).toBe(false);
    expect(inv.workspaces).toEqual([]);
  });
});
