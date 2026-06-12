/**
 * Tests for the secure initial-password lifecycle at login and reset.
 *
 *  - A system-generated initial password expires after a short period (1 month).
 *    Login MUST be rejected once the temp password is past `tempPasswordExpires`,
 *    so the initial secret can never become a long-term password.
 *  - While valid, login succeeds but surfaces `mustChangePassword` so the client
 *    can force a password change.
 *  - Resetting the password clears both temp-password fields.
 */

import express from 'express';
import request from 'supertest';

const mockGetUserByEmail = jest.fn();
const mockGetUserByResetToken = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: (...args: any[]) => mockGetUserByEmail(...args),
    getUserByResetToken: (...args: any[]) => mockGetUserByResetToken(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
  },
  orgDb: {},
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
  getTierConfig: jest.fn().mockResolvedValue({ allowedPages: [], allowedSkills: [] }),
  DEFAULT_PAGES: [],
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
  hash: jest.fn().mockResolvedValue('hashed-new-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn().mockReturnValue('test.jwt.token'),
}));

import { login, resetPassword } from '../controllers/auth';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/login', login);
  app.post('/reset-password', resetPassword);
  return app;
}

const baseUser = {
  userId: 'u1',
  email: 'alice@acmecorp.com',
  password: 'hashed-temp-password',
  isActive: true,
  roles: ['customer'],
  isAdmin: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateUser.mockResolvedValue({ userId: 'u1' });
});

// ---------------------------------------------------------------------------
// Login — initial-password expiry enforcement
// ---------------------------------------------------------------------------

describe('login — expired initial password', () => {
  it('rejects login when the temp password has expired (past tempPasswordExpires)', async () => {
    mockGetUserByEmail.mockResolvedValue({
      ...baseUser,
      mustChangePassword: true,
      tempPasswordExpires: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await request(makeApp())
      .post('/login')
      .send({ email: 'alice@acmecorp.com', password: 'TempPass123' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('temp_password_expired');
    // Must not issue a token for an expired temp password.
    expect(res.body.token).toBeUndefined();
  });

  it('allows login when the temp password is still valid, surfacing mustChangePassword', async () => {
    mockGetUserByEmail.mockResolvedValue({
      ...baseUser,
      mustChangePassword: true,
      tempPasswordExpires: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await request(makeApp())
      .post('/login')
      .send({ email: 'alice@acmecorp.com', password: 'TempPass123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('test.jwt.token');
    expect(res.body.user.mustChangePassword).toBe(true);
  });

  it('allows normal login for a user with no temp password (fields absent)', async () => {
    mockGetUserByEmail.mockResolvedValue({ ...baseUser });

    const res = await request(makeApp())
      .post('/login')
      .send({ email: 'alice@acmecorp.com', password: 'RealPass123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('test.jwt.token');
  });
});

// ---------------------------------------------------------------------------
// Reset — clears the temp-password lifecycle fields
// ---------------------------------------------------------------------------

describe('resetPassword — clears initial-password flags', () => {
  it('clears mustChangePassword and tempPasswordExpires on successful reset', async () => {
    mockGetUserByResetToken.mockResolvedValue({
      ...baseUser,
      resetPasswordToken: 'tok',
      resetPasswordExpires: new Date(Date.now() + 3_600_000).toISOString(),
      mustChangePassword: true,
      tempPasswordExpires: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await request(makeApp())
      .post('/reset-password')
      .send({ token: 'tok', password: 'BrandNewPass1' });

    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        password: 'hashed-new-password',
        resetPasswordToken: undefined,
        resetPasswordExpires: undefined,
        mustChangePassword: false,
        tempPasswordExpires: undefined,
      })
    );
  });
});
