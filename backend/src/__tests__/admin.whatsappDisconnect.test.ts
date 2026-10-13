/**
 * Admin disconnect of a customer's WhatsApp number (ENG-273).
 */
import express from 'express';
import request from 'supertest';

jest.mock('../services/whatsappVerificationService', () => ({
  disconnectWhatsApp: jest.fn(),
}));
jest.mock('../services/customerChannelPolicy', () => ({
  getPlatformSummary: jest.fn(),
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/whatsappService', () => ({
  redactPhone: jest.requireActual('../services/whatsappService').redactPhone,
  sendText: jest.fn(),
}));

const { disconnectWhatsApp } = require('../services/whatsappVerificationService');
const whatsapp = require('../services/whatsappService');
const { getPlatformSummary } = require('../services/customerChannelPolicy');
const { userDb } = require('../services/db');

// The admin router is ~5k lines with dozens of unrelated imports; this test mounts just
// the one handler by pulling it off the real router, behind a stand-in for the
// router-level authenticateToken + isAdmin gate (covered by the admin suites).
let app: express.Express;
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const adminRouter = require('../routes/admin').default;
  const layer = adminRouter.stack.find(
    (l: any) => l.route?.path === '/users/:userId/whatsapp' && l.route.methods.delete,
  );
  if (!layer) throw new Error('DELETE /users/:userId/whatsapp is not registered on the admin router');
  app = express();
  app.use((req: any, _res, next) => {
    req.user = { userId: 'admin-1' };
    next();
  });
  app.delete('/users/:userId/whatsapp', ...layer.route.stack.map((s: any) => s.handle));
});

beforeEach(() => {
  disconnectWhatsApp.mockReset();
  whatsapp.sendText.mockReset();
  disconnectWhatsApp.mockResolvedValue({ removed: '+918005326946', channels: [] });
  whatsapp.sendText.mockResolvedValue({ messageId: 'x' });
  userDb.getUserById.mockResolvedValue({ userId: 'user-1' });
  getPlatformSummary.mockReset();
  getPlatformSummary.mockResolvedValue({ platform: null, source: null, whatsappNumberMasked: null });
});

it('disconnects the number and tells the customer', async () => {
  const res = await request(app).delete('/users/user-1/whatsapp');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ success: true, customerNotified: true });
  expect(disconnectWhatsApp).toHaveBeenCalledWith('user-1', 'admin');
  expect(whatsapp.sendText).toHaveBeenCalledWith(
    '+918005326946',
    expect.stringMatching(/disconnected from AgentWeb by our support team/),
  );
});

it('still succeeds when the customer cannot be told (window closed)', async () => {
  whatsapp.sendText.mockRejectedValue(new Error('outside the 24-hour service window'));
  const res = await request(app).delete('/users/user-1/whatsapp');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ success: true, customerNotified: false });
});

it('records which admin did it, without the phone number', async () => {
  await request(app).delete('/users/user-1/whatsapp');
  const logged = (console.log as jest.Mock).mock.calls.flat().join(' ');
  expect(logged).toContain('admin-1');
  expect(logged).toContain('user-1');
  expect(logged).not.toContain('918005326946');
});

it('answers 409 when there is no number to disconnect', async () => {
  disconnectWhatsApp.mockResolvedValue({ removed: null, channels: [] });
  const res = await request(app).delete('/users/user-1/whatsapp');
  expect(res.status).toBe(409);
  expect(whatsapp.sendText).not.toHaveBeenCalled();
});

it('answers 404 for an unknown user', async () => {
  disconnectWhatsApp.mockResolvedValue(null);
  const res = await request(app).delete('/users/nope/whatsapp');
  expect(res.status).toBe(404);
});

it('is registered behind the admin gate', () => {
  // authenticateToken and isAdmin are applied with router.use() ahead of every route.
  const adminRouter = require('../routes/admin').default;
  const names = adminRouter.stack.filter((l: any) => !l.route).map((l: any) => l.name);
  expect(names).toEqual(expect.arrayContaining(['authenticateToken', 'isAdmin']));
});

it('returns the platform the account is on AFTER the disconnect', async () => {
  // An organisation member falls back to the organisation's Slack channel, so "not
  // connected" would be wrong.
  getPlatformSummary.mockResolvedValue({ platform: 'slack', source: 'organisation', whatsappNumberMasked: null });
  const res = await request(app).delete('/users/user-1/whatsapp');
  expect(res.body).toMatchObject({
    messagingPlatform: 'slack',
    messagingPlatformSource: 'organisation',
    whatsappNumberMasked: null,
  });
});

it('still succeeds when the platform cannot be recalculated', async () => {
  getPlatformSummary.mockRejectedValue(new Error('dynamo down'));
  const res = await request(app).delete('/users/user-1/whatsapp');
  expect(res.status).toBe(200);
  expect(res.body.messagingPlatform).toBeNull();
});

it.each(['a b', 'x'.repeat(200), '../etc', 'user;drop', 'a/b'])(
  'rejects a malformed user id (%s) as bad input, without touching the database',
  async (bad) => {
    const res = await request(app).delete(`/users/${encodeURIComponent(bad)}/whatsapp`);
    expect(res.status).toBe(400);
    expect(disconnectWhatsApp).not.toHaveBeenCalled();
  },
);

it.each(['58ad8518-d33f-4347-a024-59a3f0ab216b', '1738251317419', 'user_1'])(
  'accepts a real user id shape (%s)',
  async (good) => {
    const res = await request(app).delete(`/users/${good}/whatsapp`);
    expect(res.status).toBe(200);
  },
);
