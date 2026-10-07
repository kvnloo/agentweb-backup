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
  crmDb: { createLeadList: jest.fn(), getLeadListById: jest.fn(), updateLeadList: jest.fn(), getLeadListsByUserId: jest.fn() },
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

describe('PUT /api/tracking/session-lists/:listId/config: routing (ENG-2316)', () => {
  const CHILD = { listId: 'list_child_0001', userId: 'user-1', listType: 'session', trackingConfig: { allowedOrigins: [] } };
  const rule = (over: Record<string, any> = {}) => ({ id: 'organic', match: { trafficType: 'organic' }, childListId: CHILD.listId, ...over });
  const lists: Record<string, any> = {};

  beforeEach(() => {
    for (const k of Object.keys(lists)) delete lists[k];
    Object.assign(lists, { [LIST.listId]: LIST, [CHILD.listId]: CHILD });
    (crmDb.getLeadListById as jest.Mock).mockImplementation(async (id: string) => lists[id] ?? null);
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([LIST, CHILD]);
  });

  it('saves a valid rule set next to the existing origins and label', async () => {
    const res = await put(LIST.listId, { routing: [rule()] });
    expect(res.status).toBe(200);
    expect((crmDb.updateLeadList as jest.Mock).mock.calls[0][1].trackingConfig).toEqual({
      allowedOrigins: ['https://a.example.com'], pageLabel: 'Old', routing: [rule()],
    });
  });

  it('routing: null / [] clears the rules and keeps everything else', async () => {
    lists[LIST.listId] = { ...LIST, trackingConfig: { ...LIST.trackingConfig, routing: [rule()] } };
    for (const routing of [null, []]) {
      (crmDb.updateLeadList as jest.Mock).mockClear();
      expect((await put(LIST.listId, { routing })).status).toBe(200);
      expect((crmDb.updateLeadList as jest.Mock).mock.calls[0][1].trackingConfig).toEqual({ allowedOrigins: ['https://a.example.com'], pageLabel: 'Old' });
    }
  });

  it('an update that does not mention routing leaves stored rules untouched', async () => {
    lists[LIST.listId] = { ...LIST, trackingConfig: { ...LIST.trackingConfig, routing: [rule()] } };
    await put(LIST.listId, { pageLabel: 'New' });
    expect((crmDb.updateLeadList as jest.Mock).mock.calls[0][1].trackingConfig.routing).toEqual([rule()]);
  });

  it.each([
    ['a rule with no condition', () => [rule({ match: {} })], 'invalid_rule'],
    ['6 rules', () => Array.from({ length: 6 }, (_, i) => rule({ id: `r${i}`, childListId: `list_child_${i}0000` })), 'too_many_rules'],
    ['a self loop', () => [rule({ childListId: LIST.listId })], 'routing_self'],
    ['a child that does not exist', () => [rule({ childListId: 'list_missing_01' })], 'routing_child_not_found'],
  ])('400 %s, nothing written', async (_l, mk, code) => {
    const res = await put(LIST.listId, { routing: mk() });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(crmDb.updateLeadList).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-session child', { listType: 'sales' }, 'routing_child_not_session'],
    ['a child owned by someone else', { userId: 'someone-else' }, 'routing_child_other_owner'],
    ['a child that already has routing (chain)', { trackingConfig: { allowedOrigins: [], routing: [{ id: 'x', match: { trafficType: 'paid' }, childListId: 'list_zzz_00001' }] } }, 'routing_chain'],
  ])('400 for %s', async (_l, over, code) => {
    lists[CHILD.listId] = { ...CHILD, ...over };
    const res = await put(LIST.listId, { routing: [rule()] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(crmDb.updateLeadList).not.toHaveBeenCalled();
  });

  it('400 when THIS list is already some other list\'s routing target (no chains, other direction)', async () => {
    const other = { listId: 'list_other_0001', userId: 'user-1', listType: 'session', trackingConfig: { allowedOrigins: [], routing: [rule({ childListId: LIST.listId })] } };
    (crmDb.getLeadListsByUserId as jest.Mock).mockResolvedValue([LIST, CHILD, other]);
    const res = await put(LIST.listId, { routing: [rule()] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('routing_is_child');
    expect(crmDb.updateLeadList).not.toHaveBeenCalled();
  });

  it('403 when the caller can edit the parent but not a child (they could otherwise fill a list they cannot touch)', async () => {
    (canDestructiveCrmList as jest.Mock).mockImplementation(async (_u: string, l: any) => l.listId !== CHILD.listId);
    const res = await put(LIST.listId, { routing: [rule()] });
    expect(res.status).toBe(403);
    expect(res.body.childListId).toBe(CHILD.listId);
    expect(crmDb.updateLeadList).not.toHaveBeenCalled();
  });

  it('clearing routing needs no child reads and no child permission', async () => {
    (canDestructiveCrmList as jest.Mock).mockImplementation(async (_u: string, l: any) => l.listId !== CHILD.listId);
    expect((await put(LIST.listId, { routing: [] })).status).toBe(200);
    expect(crmDb.getLeadListsByUserId).not.toHaveBeenCalled();
  });
});
