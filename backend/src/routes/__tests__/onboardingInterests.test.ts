import express from 'express';
import request from 'supertest';

// Hoisted mocks — must be before router import
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  }),
}));

const mockUpdateUser = jest.fn();
const mockGetUserById = jest.fn();
jest.mock('../../services/db', () => ({
  userDb: {
    updateUser: (...args: any[]) => mockUpdateUser(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
  },
  taskDb: {},
  subscriberDb: {},
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

// Controllers only used by other routes in auth.ts — stub
jest.mock('../../controllers/auth', () => ({
  register: jest.fn((_req: any, res: any) => res.status(200).json({})),
  login: jest.fn((_req: any, res: any) => res.status(200).json({})),
  googleCallback: jest.fn(),
  forgotPassword: jest.fn((_req: any, res: any) => res.status(200).json({})),
  resetPassword: jest.fn((_req: any, res: any) => res.status(200).json({})),
  changePassword: jest.fn((_req: any, res: any) => res.status(200).json({})),
}));

// Passport + google strategy stub (auth.ts imports but doesn't execute)
jest.mock('passport', () => ({
  authenticate: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  use: jest.fn(),
  initialize: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));
jest.mock('passport-google-oauth20', () => ({
  Strategy: jest.fn(),
}));

jest.mock('../../services/chatbotService', () => ({
  ChatbotDB: jest.fn().mockImplementation(() => ({
    getUserSessions: jest.fn().mockResolvedValue([]),
  })),
}));

import authRouter from '../auth';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

describe('PATCH /api/auth/onboarding-interests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateUser.mockResolvedValue({
      userId: 'user-123',
      email: 'user@example.com',
      emmaHelpInterests: [],
      emmaHelpInterestsSetAt: '2026-04-14T00:00:00.000Z',
    });
  });

  it('saves a valid set of interests', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/api/auth/onboarding-interests')
      .send({ interests: ['brand', 'paid_ads', 'founder_led_sales'] });

    expect(res.status).toBe(200);
    expect(res.body.emmaHelpInterests).toEqual(['brand', 'paid_ads', 'founder_led_sales']);
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        emmaHelpInterests: ['brand', 'paid_ads', 'founder_led_sales'],
      })
    );
    expect(mockUpdateUser.mock.calls[0][1].emmaHelpInterestsSetAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('persists company name and website from the first brand submit', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/api/auth/onboarding-interests')
      .send({
        interests: ['brand'],
        companyName: 'Acme Labs',
        companyUrl: 'https://acme.example',
      });

    expect(res.status).toBe(200);
    expect(res.body.companyName).toBe('Acme Labs');
    expect(res.body.productDomain).toBe('https://acme.example');
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        emmaHelpInterests: ['brand'],
        companyName: 'Acme Labs',
        productDomain: 'https://acme.example',
      })
    );
  });

  it('accepts an empty array (user skipped)', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/api/auth/onboarding-interests')
      .send({ interests: [] });

    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalled();
  });

  it('rejects a non-array body', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/api/auth/onboarding-interests')
      .send({ interests: 'brand' });

    expect(res.status).toBe(400);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('rejects unknown interest values', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/api/auth/onboarding-interests')
      .send({ interests: ['brand', 'totally_made_up'] });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('totally_made_up');
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('dedupes repeated interests before saving', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch('/api/auth/onboarding-interests')
      .send({ interests: ['brand', 'brand', 'paid_ads'] });

    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user-123',
      expect.objectContaining({
        emmaHelpInterests: ['brand', 'paid_ads'],
      })
    );
  });
});
