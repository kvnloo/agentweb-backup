/**
 * ENG-2315 — the owner-facing "enable tracking" API. Contract: it can only create/configure a
 * SESSION list, only an owner/editor may change what origins can write into it, and nothing
 * unvalidated is persisted.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: Request & { user?: unknown }, res: Response, next: NextFunction) => {
    if (!req.header('x-test-user')) { res.status(401).json({ message: 'Access token required' }); return; }
    req.user = JSON.parse(req.header('x-test-user') as string);
    next();
  },
}));
jest.mock('../../services/db', () => ({
  crmDb: { createLeadList: jest.fn(), getLeadListById: jest.fn(), updateLeadList: jest.fn() },
}));
jest.mock('../../services/crmAccessControl', () => ({
  canDestructiveCrmList: jest.fn(),
  CRM_EDITOR_REQUIRED_MESSAGE: 'editor required',
}));

import trackingRoutes from '../tracking';
import { crmDb } from '../../services/db';
import { canDestructiveCrmList } from '../../services/crmAccessControl';

const USER = JSON.stringify({ userId: 'user-1', email: 'u@example.com', isAdmin: false });
const app = express();
app.use(express.json());
app.use('/api/tracking', trackingRoutes);

const LIST = { listId: 'list_111111_aaaa', userId: 'user-1', listType: 'session', publicAccessEnabled: true, trackingConfig: { allowedOrigins: ['https://a.example.com'], pageLabel: 'Old' } };
const post = (body: unknown) => request(app).post('/api/tracking/session-lists').set('x-test-user', USER).send(body as any);
const put = (id: string, body: unknown) => request(app).put(`/api/tracking/session-lists/${id}/config`).set('x-test-user', USER).send(body as any);

beforeEach(() => {
  jest.clearAllMocks();
  (crmDb.createLeadList as jest.Mock).mockImplementation(async (userId: string, name: string, _d: any, alertEvents: any, _s: any, _a: any, _b: any, _c: any, _e: any, listType: any, isSystemManaged: any, _x: any, initial: any) => ({
    listId: 'list_999999_new', userId, name, listType, isSystemManaged, alertEvents, ...initial,
  }));
  (crmDb.getLeadListById as jest.Mock).mockResolvedValue(LIST);
  (crmDb.updateLeadList as jest.Mock).mockImplementation(async (_id: string, u: any) => ({ ...LIST, ...u }));
  (canDestructiveCrmList as jest.Mock).mockResolvedValue(true);
});

describe('POST /api/tracking/session-lists', () => {
  it('needs a user token', async () => {
    expect((await request(app).post('/api/tracking/session-lists').send({})).status).toBe(401);
  });

  it('creates a public, system-managed, alert-free session list in ONE write and returns the embed tag', async () => {
    const res = await post({ name: ' Guilty v2 ', allowedOrigins: ['https://go.example.com/'], pageLabel: 'Guilty v2' });
    expect(res.status).toBe(201);
    const args = (crmDb.createLeadList as jest.Mock).mock.calls[0];
    expect(args[0]).toBe('user-1');
    expect(args[1]).toBe('Guilty v2');
    expect(args[3]).toEqual([]);          // alertEvents
    expect(args[9]).toBe('session');      // listType
    expect(args[10]).toBe(true);          // isSystemManaged
    expect(args[12]).toMatchObject({
      publicAccessEnabled: true,
      trackingConfig: { allowedOrigins: ['https://go.example.com'], pageLabel: 'Guilty v2' },
      displayFields: ['channel', 'trafficType', 'channelGroup', 'sourceDetail', 'dwellSec', 'lastEvent', 'furthestStage', 'visitNo'],
    });
    expect(crmDb.updateLeadList).not.toHaveBeenCalled(); // no window where the list is public but unconfigured
    expect(res.body.embedSnippet).toBe('<script src="https://api.agentweb.pro/sdk/v1/aw.js" data-aw-list="list_999999_new" async></script>');
  });

  it.each([
    ['no name', { allowedOrigins: ['https://a.com'] }],
    ['blank name', { name: '  ', allowedOrigins: ['https://a.com'] }],
    ['no origins', { name: 'x' }],
    ['empty origins', { name: 'x', allowedOrigins: [] }],
    ['wildcard origin', { name: 'x', allowedOrigins: ['https://*.a.com'] }],
    ['11 origins', { name: 'x', allowedOrigins: Array.from({ length: 11 }, (_, i) => `https://s${i}.a.com`) }],
    ['unknown field (typo)', { name: 'x', allowedOrigins: ['https://a.com'], allowedOrigin: 'https://b.com' }],
    ['routing at creation', { name: 'x', allowedOrigins: ['https://a.com'], routing: [] }],
    ['listType smuggled in', { name: 'x', allowedOrigins: ['https://a.com'], listType: 'sales' }],
    ['long label', { name: 'x', allowedOrigins: ['https://a.com'], pageLabel: 'p'.repeat(61) }],
  ])('400 on %s, nothing written', async (_l, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(crmDb.createLeadList).not.toHaveBeenCalled();
  });
});

describe('PUT /api/tracking/session-lists/:listId/config', () => {
  it('updates origins and label for an owner/editor; merges with what is stored', async () => {
    const res = await put(LIST.listId, { allowedOrigins: ['https://b.example.com'] });
    expect(res.status).toBe(200);
    expect((crmDb.updateLeadList as jest.Mock).mock.calls[0]).toEqual([LIST.listId, { trackingConfig: { allowedOrigins: ['https://b.example.com'], pageLabel: 'Old' } }]);
    await put(LIST.listId, { pageLabel: '' });
    expect((crmDb.updateLeadList as jest.Mock).mock.calls[1][1].trackingConfig).toEqual({ allowedOrigins: ['https://a.example.com'] });
  });

  it('allowedOrigins: [] is accepted (the kill switch for browsers)', async () => {
    expect((await put(LIST.listId, { allowedOrigins: [] })).status).toBe(200);
  });

  it('uses the edit-level CRM gate and refuses a non-editor (403) before reading the body', async () => {
    (canDestructiveCrmList as jest.Mock).mockResolvedValue(false);
    const res = await put(LIST.listId, { allowedOrigins: ['https://evil.example.com'] });
    expect(res.status).toBe(403);
    expect(canDestructiveCrmList).toHaveBeenCalledWith('user-1', LIST);
    expect(crmDb.updateLeadList).not.toHaveBeenCalled();
  });

  it('404 for an unknown list; 400 for a non-session list', async () => {
    (crmDb.getLeadListById as jest.Mock).mockResolvedValueOnce(null);
    expect((await put('list_nope_000', { allowedOrigins: [] })).status).toBe(404);
    (crmDb.getLeadListById as jest.Mock).mockResolvedValueOnce({ ...LIST, listType: 'sales' });
    const res = await put(LIST.listId, { allowedOrigins: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_session_list');
    expect(crmDb.updateLeadList).not.toHaveBeenCalled();
  });

  it.each([
    ['empty body', {}],
    ['unknown field', { allowedOrigin: ['https://a.com'] }],
    ['bad origin', { allowedOrigins: ['a.com'] }],
    ['origins not an array', { allowedOrigins: 'https://a.com' }],
    ['label with markup', { pageLabel: '<b>' }],
    ['a trackingConfig blob', { trackingConfig: { allowedOrigins: ['https://a.com'] } }],
  ])('400 on %s, nothing written', async (_l, body) => {
    expect((await put(LIST.listId, body)).status).toBe(400);
    expect(crmDb.updateLeadList).not.toHaveBeenCalled();
  });
});
