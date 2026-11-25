jest.mock('../middleware/auth', () => ({ authenticateToken: jest.fn() }));
import { createActivationReportRouter } from '../routes/adminZomaActivation';
import { isAdmin } from '../middleware/admin';
import { authenticateToken } from '../middleware/auth';
const user = { userId: 'u1', email: 'a@b.co', zomaActivationEvents: { signed_up: { userId: 'u1', timestamp: '2026-11-01T00:00:00Z' } } };
const store = () => ({ listZomaActivationUsers: jest.fn().mockResolvedValue({ users: [user], cursor: { email: 'a@b.co' } }), getUserById: jest.fn().mockResolvedValue(user) });
function response() {
  const res: any = { headers: {} };
  for (const method of ['status', 'json', 'type', 'attachment', 'send']) res[method] = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn((name, value) => { res.headers[name] = value; });
  return res;
}
function handler(db = store()) {
  const route = (createActivationReportRouter(db) as any).stack[0].route;
  expect(route.path).toBe('/zoma/activation-progress');
  expect(route.stack[0].handle).toBe(authenticateToken);
  expect(route.stack[1].handle).toBe(isAdmin);
  return { db, call: route.stack[2].handle };
}
it.each([{}, { user: { userId: 'u', isAdmin: false } }, { user: { userId: 'admin', isAdmin: true }, delegateInfo: { isDelegated: true } }])('denies unauthenticated/nonadmin/delegated requests before report', async req => {
  const res = response(); const next = jest.fn();
  await isAdmin(req as any, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith('user' in req ? 403 : 401);
});
it('admin passes existing security middleware', async () => {
  const next = jest.fn();
  await isAdmin({ user: { userId: 'admin', isAdmin: true } } as any, response(), next);
  expect(next).toHaveBeenCalledTimes(1);
});
it('JSON returns per-user progress and explicit page scope, never a false fleet total', async () => {
  const { db, call } = handler(); const res = response();
  await call({ query: {} }, res);
  expect(db.listZomaActivationUsers).toHaveBeenCalledWith(undefined);
  const result = res.json.mock.calls[0][0];
  expect(result).toMatchObject({ scope: 'page', hasMore: true, rows: [{ userId: 'u1', activated: false }] });
  expect(JSON.parse(Buffer.from(result.nextCursor, 'base64url').toString())).toEqual({ email: 'a@b.co' });
  expect(res.headers['Cache-Control']).toBe('no-store');
});
it('CSV exports page with next cursor, shared report semantics and timestamp columns', async () => {
  const { call } = handler(); const res = response();
  await call({ query: { format: 'csv' } }, res);
  expect(res.type).toHaveBeenCalledWith('text/csv');
  expect(res.send.mock.calls[0][0]).toContain('signed_up');
  expect(res.send.mock.calls[0][0]).toContain('2026-11-01T00:00:00Z');
  expect(res.headers['X-Next-Cursor']).toBeTruthy();
});
it('cursor is passed to exactly the next page', async () => {
  const { db, call } = handler(); const res = response();
  await call({ query: { cursor: Buffer.from(JSON.stringify({ email: 'last@b.co' })).toString('base64url') } }, res);
  expect(db.listZomaActivationUsers).toHaveBeenCalledWith({ email: 'last@b.co' });
});
it.each([{ format: 'xml' }, { stuckAfterHours: 'NaN' }, { stuckAfterHours: '0' }, { stuckAfterHours: ['24'] }, { stuckAfterHours: { toString: 'x' } }, { cursor: 'bad' }, { cursor: Buffer.from('{"email":"x","extra":"bad"}').toString('base64url') }, { userId: ['u1'] }])('rejects invalid query %p without storage access', async query => {
  const { db, call } = handler(); const res = response();
  await call({ query }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(db.listZomaActivationUsers).not.toHaveBeenCalled();
});
it('single user lookup avoids scan and exports only sanitized report fields', async () => {
  const { db, call } = handler(); const res = response();
  db.getUserById.mockResolvedValue({ ...user, password: 'secret' } as any);
  await call({ query: { userId: 'u1' } }, res);
  expect(db.getUserById).toHaveBeenCalledWith('u1');
  expect(db.listZomaActivationUsers).not.toHaveBeenCalled();
  expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret');
});
it('storage failure is unavailable, not empty success', async () => {
  const { db, call } = handler(); const res = response();
  db.listZomaActivationUsers.mockRejectedValue(new Error('offline'));
  await call({ query: {} }, res);
  expect(res.status).toHaveBeenCalledWith(503);
});
