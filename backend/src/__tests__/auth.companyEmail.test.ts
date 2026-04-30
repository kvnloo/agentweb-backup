/**
 * Tests for company-email-only restriction on sign-up.
 * The register controller must reject personal/free email domains
 * (gmail, yahoo, hotmail, outlook, etc.) with a 400 and a clear message.
 *
 * Also covers the isCompanyEmail utility directly.
 */

import express from 'express';
import request from 'supertest';

// ---- Mocks BEFORE controller import ----------------------------------------

const mockGetUserByEmail = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetOrgWithPendingInviteForEmail = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: (...args: any[]) => mockGetUserByEmail(...args),
    createUser: (...args: any[]) => mockCreateUser(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
  },
  orgDb: {
    getOrgWithPendingInviteForEmail: (...args: any[]) =>
      mockGetOrgWithPendingInviteForEmail(...args),
  },
  taskDb: {},
  subscriberDb: {},
}));

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: { getByEmail: jest.fn().mockResolvedValue(null) },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
    sendTeamIntroductionEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getTierConfig: jest
    .fn()
    .mockResolvedValue({ allowedPages: ['home'], allowedSkills: [] }),
  DEFAULT_PAGES: ['home'],
}));

jest.mock('../services/crmAutoSyncService', () => ({
  syncNewUserToLeadList: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../types/attribution', () => ({
  normalizeAttribution: jest.fn().mockReturnValue(null),
}));

jest.mock('../services/contactCaptureHooks', () => ({
  onUserRegistered: jest.fn().mockResolvedValue(null),
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test.jwt.token'),
}));

import { register } from '../controllers/auth';
import { isCompanyEmail } from '../utils/validation';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/register', register);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserByEmail.mockResolvedValue(null);
  mockGetOrgWithPendingInviteForEmail.mockResolvedValue(null);
  mockCreateUser.mockResolvedValue({
    userId: 'uuid-u1',
    email: 'alice@acmecorp.com',
    isAdmin: false,
    roles: ['customer'],
  });
  mockUpdateUser.mockResolvedValue({ userId: 'uuid-u1' });
});

// ---------------------------------------------------------------------------
// isCompanyEmail utility
// ---------------------------------------------------------------------------

describe('isCompanyEmail utility', () => {
  // Invalid inputs
  it('returns false for empty string', () => {
    expect(isCompanyEmail('')).toBe(false);
  });

  it('returns false for string without @', () => {
    expect(isCompanyEmail('notanemail')).toBe(false);
  });

  it('returns false for gmail.com', () => {
    expect(isCompanyEmail('user@gmail.com')).toBe(false);
  });

  it('returns false for yahoo.com', () => {
    expect(isCompanyEmail('user@yahoo.com')).toBe(false);
  });

  it('returns false for hotmail.com', () => {
    expect(isCompanyEmail('user@hotmail.com')).toBe(false);
  });

  it('returns false for outlook.com', () => {
    expect(isCompanyEmail('user@outlook.com')).toBe(false);
  });

  it('returns false for icloud.com', () => {
    expect(isCompanyEmail('user@icloud.com')).toBe(false);
  });

  it('returns false for aol.com', () => {
    expect(isCompanyEmail('user@aol.com')).toBe(false);
  });

  it('returns false for protonmail.com', () => {
    expect(isCompanyEmail('user@protonmail.com')).toBe(false);
  });

  // Valid company emails
  it('returns true for a custom company domain', () => {
    expect(isCompanyEmail('alice@acmecorp.com')).toBe(true);
  });

  it('returns true for a subdomain company email', () => {
    expect(isCompanyEmail('bob@us.enterprise.io')).toBe(true);
  });

  it('returns true for a .co domain', () => {
    expect(isCompanyEmail('carol@startup.co')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Register controller — personal email rejection
// ---------------------------------------------------------------------------

describe('register controller — company email enforcement', () => {
  it('rejects gmail.com with 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'user@gmail.com', password: 'pw123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/company email/i);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('rejects yahoo.com with 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'user@yahoo.com', password: 'pw123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/company email/i);
  });

  it('rejects hotmail.com with 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'user@hotmail.com', password: 'pw123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/company email/i);
  });

  it('rejects outlook.com with 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'user@outlook.com', password: 'pw123' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/company email/i);
  });

  it('allows a company domain email through (returns 201)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'alice@acmecorp.com', password: 'pw123' });

    expect(res.status).toBe(201);
    expect(mockCreateUser).toHaveBeenCalledTimes(1);
  });
});
