/**
 * ENG-1085 — the portal Settings page's `handleSavePreferences` was a
 * synchronous no-op: fired a success toast, made no API call at all.
 * `displayName` was actually just a local email-derived string, never read
 * from or written to the backend; there was no persistence path for it or
 * for a notification opt-in at all. These are the endpoints that path now
 * calls.
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

describe('GET /api/users/me/preferences', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns persisted displayName and emailNotificationsEnabled', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'user-1',
      email: 'test@example.com',
      displayName: 'Ada Lovelace',
      emailNotificationsEnabled: false,
    });
    const res = await request(app).get('/api/users/me/preferences');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayName: 'Ada Lovelace', emailNotificationsEnabled: false });
  });

  it('defaults emailNotificationsEnabled to true when never set (opt-out model)', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app).get('/api/users/me/preferences');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ displayName: null, emailNotificationsEnabled: true });
  });

  it('returns 404 when user not found', async () => {
    userDb.getUserById.mockResolvedValue(null);
    const res = await request(app).get('/api/users/me/preferences');
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected db error', async () => {
    userDb.getUserById.mockRejectedValue(new Error('db error'));
    const res = await request(app).get('/api/users/me/preferences');
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/users/me/preferences', () => {
  beforeEach(() => jest.clearAllMocks());

  it('saves displayName and emailNotificationsEnabled together', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/preferences')
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
      .patch('/api/users/me/preferences')
      .send({ displayName: 'Margaret Hamilton' });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { displayName: 'Margaret Hamilton' });
  });

  it('saves only emailNotificationsEnabled when displayName omitted', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/preferences')
      .send({ emailNotificationsEnabled: true });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', { emailNotificationsEnabled: true });
  });

  it('rejects an empty displayName — must not silently clear the field', async () => {
    const res = await request(app)
      .patch('/api/users/me/preferences')
      .send({ displayName: '' });
    expect(res.status).toBe(400);
    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('rejects a displayName that is not a string', async () => {
    const res = await request(app)
      .patch('/api/users/me/preferences')
      .send({ displayName: 42 });
    expect(res.status).toBe(400);
  });

  it('rejects a displayName over 100 characters', async () => {
    const res = await request(app)
      .patch('/api/users/me/preferences')
      .send({ displayName: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });

  it('rejects emailNotificationsEnabled that is not boolean', async () => {
    const res = await request(app)
      .patch('/api/users/me/preferences')
      .send({ emailNotificationsEnabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when no valid fields provided', async () => {
    const res = await request(app).patch('/api/users/me/preferences').send({});
    expect(res.status).toBe(400);
  });

  it('returns 500 on db error — the caller must see a real failure, not a false success toast', async () => {
    userDb.updateUser.mockRejectedValue(new Error('db error'));
    const res = await request(app)
      .patch('/api/users/me/preferences')
      .send({ displayName: 'Katherine Johnson' });
    expect(res.status).toBe(500);
  });
});
