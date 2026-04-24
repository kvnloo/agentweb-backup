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

describe('GET /api/users/me/onboarding', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns defaults when user has no onboarding fields', async () => {
    userDb.getUserById.mockResolvedValue({ userId: 'user-1', email: 'test@example.com' });
    const res = await request(app).get('/api/users/me/onboarding');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ onboardingProgress: {}, onboardingDismissed: false });
  });

  it('returns persisted onboarding state', async () => {
    userDb.getUserById.mockResolvedValue({
      userId: 'user-1',
      email: 'test@example.com',
      onboardingProgress: { 'brand-setup': true },
      onboardingDismissed: true,
    });
    const res = await request(app).get('/api/users/me/onboarding');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ onboardingProgress: { 'brand-setup': true }, onboardingDismissed: true });
  });

  it('returns 404 when user not found', async () => {
    userDb.getUserById.mockResolvedValue(null);
    const res = await request(app).get('/api/users/me/onboarding');
    expect(res.status).toBe(404);
  });

  it('returns 500 on unexpected db error', async () => {
    userDb.getUserById.mockRejectedValue(new Error('db error'));
    const res = await request(app).get('/api/users/me/onboarding');
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/users/me/onboarding', () => {
  beforeEach(() => jest.clearAllMocks());

  it('saves onboardingProgress and onboardingDismissed', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/onboarding')
      .send({ onboardingProgress: { 'brand-setup': true }, onboardingDismissed: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', {
      onboardingProgress: { 'brand-setup': true },
      onboardingDismissed: false,
    });
  });

  it('saves only onboardingProgress when onboardingDismissed omitted', async () => {
    userDb.updateUser.mockResolvedValue({});
    const res = await request(app)
      .patch('/api/users/me/onboarding')
      .send({ onboardingProgress: { 'first-conversation': true } });
    expect(res.status).toBe(200);
    expect(userDb.updateUser).toHaveBeenCalledWith('user-1', {
      onboardingProgress: { 'first-conversation': true },
    });
  });

  it('returns 400 when onboardingProgress is not an object', async () => {
    const res = await request(app)
      .patch('/api/users/me/onboarding')
      .send({ onboardingProgress: 'invalid' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when onboardingProgress is an array', async () => {
    const res = await request(app)
      .patch('/api/users/me/onboarding')
      .send({ onboardingProgress: [] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when onboardingDismissed is not boolean', async () => {
    const res = await request(app)
      .patch('/api/users/me/onboarding')
      .send({ onboardingDismissed: 'yes' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when no valid fields provided', async () => {
    const res = await request(app)
      .patch('/api/users/me/onboarding')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 500 on db error', async () => {
    userDb.updateUser.mockRejectedValue(new Error('db error'));
    const res = await request(app)
      .patch('/api/users/me/onboarding')
      .send({ onboardingDismissed: true });
    expect(res.status).toBe(500);
  });
});
