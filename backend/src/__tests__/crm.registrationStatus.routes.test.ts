/**
 * Tests for POST /api/crm/registration-status — batch join of CRM lead emails
 * against AW-Users registration/premium status. Backs the "signup/premium data
 * not joined" funnel gap.
 *
 * Behaviour:
 *   (a) unauthenticated -> 401
 *   (b) missing/invalid emails array -> 400
 *   (c) too many emails -> 400
 *   (d) happy path -> 200 with per-email statuses + summary counts
 */

jest.mock('../server', () => ({
  io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() },
  app: {},
}));

jest.mock('../controllers/templates', () => ({
  createTemplate: jest.fn(),
  getTemplates: jest.fn(),
  getTemplate: jest.fn(),
  updateTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
  publishTemplate: jest.fn(),
}));

jest.mock('../config/aws', () => ({
  dynamodb: {
    get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    put: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  },
}));

const mockGetRegistrationStatusByEmails = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {},
  taskDb: {},
  subscriberDb: {},
  userDb: { getRegistrationStatusByEmails: (...args: any[]) => mockGetRegistrationStatusByEmails(...args) },
  orgDb: {},
}));

jest.mock('../services/dealDb', () => ({
  dealDb: {},
  DealAuthError: class extends Error {},
  DealNotFoundError: class extends Error {},
  DEAL_STAGES: [],
}));

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn(), setSetting: jest.fn() } }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));
jest.mock('../services/contactSyncService', () => ({ syncContact: jest.fn() }));
jest.mock('../services/internalEnrichmentService', () => ({ enrichContact: jest.fn(), defaultEnrichmentCache: {} }));
jest.mock('../services/contactDedupService', () => ({ dedupContactsForUser: jest.fn() }));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: {} }));
jest.mock('../services/externalCrmSyncService', () => ({ externalCrmSyncService: {} }));
jest.mock('../services/dripSequenceDb', () => ({ dripSequenceDb: {} }));

const mockUser: { userId: string; email: string; isAdmin?: boolean } = {
  userId: 'user-A',
  email: 'a@example.com',
  isAdmin: true,
};

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = mockUser.userId
      ? { userId: mockUser.userId, email: mockUser.email, isAdmin: mockUser.isAdmin }
      : undefined;
    next();
  },
  AuthenticatedRequest: {},
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/crm';

const app = express();
app.use(express.json());
app.use('/api/crm', router);

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.userId = 'user-A';
  mockUser.email = 'a@example.com';
  mockUser.isAdmin = true;
});

describe('POST /api/crm/registration-status', () => {
  it('returns 401 when unauthenticated', async () => {
    mockUser.userId = '';
    const res = await request(app)
      .post('/api/crm/registration-status')
      .send({ emails: ['a@x.com'] });
    expect(res.status).toBe(401);
    expect(mockGetRegistrationStatusByEmails).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin user (account-enumeration guard)', async () => {
    mockUser.isAdmin = false;
    const res = await request(app)
      .post('/api/crm/registration-status')
      .send({ emails: ['a@x.com'] });
    expect(res.status).toBe(403);
    expect(mockGetRegistrationStatusByEmails).not.toHaveBeenCalled();
  });

  it('returns 400 when emails is missing', async () => {
    const res = await request(app).post('/api/crm/registration-status').send({});
    expect(res.status).toBe(400);
    expect(mockGetRegistrationStatusByEmails).not.toHaveBeenCalled();
  });

  it('returns 400 when emails is not an array', async () => {
    const res = await request(app)
      .post('/api/crm/registration-status')
      .send({ emails: 'a@x.com' });
    expect(res.status).toBe(400);
    expect(mockGetRegistrationStatusByEmails).not.toHaveBeenCalled();
  });

  it('returns 400 when emails is empty', async () => {
    const res = await request(app)
      .post('/api/crm/registration-status')
      .send({ emails: [] });
    expect(res.status).toBe(400);
    expect(mockGetRegistrationStatusByEmails).not.toHaveBeenCalled();
  });

  it('returns 400 when emails exceeds the cap', async () => {
    const emails = Array.from({ length: 1001 }, (_, i) => `u${i}@x.com`);
    const res = await request(app)
      .post('/api/crm/registration-status')
      .send({ emails });
    expect(res.status).toBe(400);
    expect(mockGetRegistrationStatusByEmails).not.toHaveBeenCalled();
  });

  it('returns 200 with statuses and summary counts on the happy path', async () => {
    mockGetRegistrationStatusByEmails.mockResolvedValueOnce([
      { email: 'paid@x.com', registered: true, isPremium: true, userId: 'u-1', subscriptionStatus: 'active' },
      { email: 'free@x.com', registered: true, isPremium: false, userId: 'u-2' },
      { email: 'ghost@x.com', registered: false, isPremium: false },
    ]);

    const res = await request(app)
      .post('/api/crm/registration-status')
      .send({ emails: ['paid@x.com', 'free@x.com', 'ghost@x.com'] });

    expect(res.status).toBe(200);
    expect(mockGetRegistrationStatusByEmails).toHaveBeenCalledWith([
      'paid@x.com',
      'free@x.com',
      'ghost@x.com',
    ]);
    expect(res.body.summary).toEqual({ total: 3, registered: 2, premium: 1 });
    expect(res.body.statuses).toHaveLength(3);
  });

  it('returns 500 when the db lookup throws', async () => {
    mockGetRegistrationStatusByEmails.mockRejectedValueOnce(new Error('ddb down'));
    const res = await request(app)
      .post('/api/crm/registration-status')
      .send({ emails: ['a@x.com'] });
    expect(res.status).toBe(500);
  });
});
