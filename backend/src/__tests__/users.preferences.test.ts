/**
 * ENG-1085 — the portal Settings page's `handleSavePreferences` was a
 * synchronous no-op: fired a success toast, made no API call at all.
 * `displayName` was actually just a local email-derived string, never read
 * from or written to the backend. ENG-1124 fixed the display-name slice.
 * ENG-1316 closes the remaining gap: emailNotificationsEnabled is now a
 * real persisted field on PATCH /api/users/me/profile.
 * ENG-188 adds emmaTipsEnabled to the same endpoint — the opt-out backing
 * both the Settings toggle and the tip card's "don't show again" control.
 * ENG-113 adds showModelCompare — the Settings toggle that hides the chat
 * Compare button. Display-only; /compare enforcement never reads it.
 * ENG-2118 adds showIntegrationAccess — the Settings toggle that hides the
 * Integration access card in Connected Accounts. Display-only; the
 * access-inventory routes keep their org-admin check.
 */
import request from 'supertest';
import express from 'express';
import usersRoutes from '../routes/users';

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

const { userDb } = require('../services/db');

const app = express();
app.use(express.json());
app.use('/api/users', usersRoutes);

describe('PATCH /api/users/me/profile', () => {
  beforeEach(() => jest.clearAllMocks());

  it('persists emailNotificationsEnabled alongside displayName', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: 'Grace Hopper', emailNotificationsEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', {
      displayName: 'Grace Hopper',
      emailNotificationsEnabled: false,
    });
  });

  it('saves only displayName when emailNotificationsEnabled omitted', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: 'Margaret Hamilton' });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { displayName: 'Margaret Hamilton' });
  });

  it('persists emailNotificationsEnabled alone when displayName omitted', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ emailNotificationsEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { emailNotificationsEnabled: true });
  });

  it('rejects a non-boolean emailNotificationsEnabled without writing', async () => {
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ emailNotificationsEnabled: 'yes' });
    expect(res.status).toBe(400);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('persists emmaTipsEnabled alone — the tip card\'s "don\'t show again" sends only this field', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ emmaTipsEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { emmaTipsEnabled: false });
  });

  it('persists emmaTipsEnabled alongside the other preference fields', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: 'Ada Lovelace', emailNotificationsEnabled: true, emmaTipsEnabled: false });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', {
      displayName: 'Ada Lovelace',
      emailNotificationsEnabled: true,
      emmaTipsEnabled: false,
    });
  });

  it('re-enabling tips writes true, not a delete — absent must stay the enabled default', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ emmaTipsEnabled: true });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { emmaTipsEnabled: true });
  });

  it('rejects a non-boolean emmaTipsEnabled without writing', async () => {
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ emmaTipsEnabled: 'off' });
    expect(res.status).toBe(400);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('persists showModelCompare alone — the Compare preference saves without touching other fields', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ showModelCompare: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { showModelCompare: false });
  });

  it('persists showModelCompare alongside the other preference fields', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: 'Ada Lovelace', emailNotificationsEnabled: true, emmaTipsEnabled: true, showModelCompare: false });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', {
      displayName: 'Ada Lovelace',
      emailNotificationsEnabled: true,
      emmaTipsEnabled: true,
      showModelCompare: false,
    });
  });

  it('turning Compare back on writes true, not a delete — absent must stay the shown default', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ showModelCompare: true });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { showModelCompare: true });
  });

  it.each([['off'], [0], [null], [{}]])('rejects a non-boolean showModelCompare (%p) without writing', async (value) => {
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: 'Grace Hopper', showModelCompare: value });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'showModelCompare must be a boolean' });
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('persists showIntegrationAccess alone, without touching other fields (ENG-2118)', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ showIntegrationAccess: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { showIntegrationAccess: false });
  });

  it('persists showIntegrationAccess alongside the other preference fields', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: 'Ada Lovelace', emailNotificationsEnabled: true, emmaTipsEnabled: true, showIntegrationAccess: false });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', {
      displayName: 'Ada Lovelace',
      emailNotificationsEnabled: true,
      emmaTipsEnabled: true,
      showIntegrationAccess: false,
    });
  });

  it('turning the panel back on writes true, not a delete — absent must stay the shown default', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ showIntegrationAccess: true });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { showIntegrationAccess: true });
  });

  it.each([['off'], [0], [null], [{}]])('rejects a non-boolean showIntegrationAccess (%p) without writing', async (value) => {
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: 'Grace Hopper', showIntegrationAccess: value });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ message: 'showIntegrationAccess must be a boolean' });
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('rejects an empty displayName — must not silently clear the field', async () => {
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: '' });
    expect(res.status).toBe(400);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('rejects a displayName that is not a string', async () => {
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: 42 });
    expect(res.status).toBe(400);
  });

  it('rejects a displayName over 100 characters', async () => {
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });

  it('accepts a 100-char displayName padded with surrounding whitespace, persisting the trimmed value', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: `  ${'x'.repeat(100)}  ` });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { displayName: 'x'.repeat(100) });
  });

  it('returns 400 when no valid fields provided', async () => {
    const res = await request(app).patch('/api/users/me/profile').send({});
    expect(res.status).toBe(400);
  });

  it('returns 500 on db error — the caller must see a real failure, not a false success toast', async () => {
    userDb.updateUser.mockRejectedValue(new Error('db error'));
    const res = await request(app)
      .patch('/api/users/me/profile')
      .send({ displayName: 'Katherine Johnson' });
    expect(res.status).toBe(500);
  });
});
