/**
 * Tests for the secure initial-password lifecycle at login, reset, and change.
 *
 *  - A system-generated initial password expires after a short period (1 month).
 *    Login MUST be rejected once the temp password is past `tempPasswordExpires`,
 *    so the initial secret can never become a long-term password.
 *  - While valid, login succeeds but surfaces `mustChangePassword` so the client
 *    can force a password change.
 *  - resetPassword and changePassword both clear the temp-password fields.
 */

import express from 'express';
import request from 'supertest';

const mockGetUserByEmail = jest.fn();
const mockGetUserByResetToken = jest.fn();
const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: (...args: any[]) => mockGetUserByEmail(...args),
    getUserByResetToken: (...args: any[]) => mockGetUserByResetToken(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
    // resetPassword and changePassword now terminate other sessions by bumping
    // sessionVersion after persisting the new password.
    incrementSessionVersion: jest.fn().mockResolvedValue(1),
  },
  orgDb: {},
  taskDb: {},
  subscriberDb: {},
}));

// Both flows sweep the user's live sockets after the bump.
jest.mock('../services/sessionSockets', () => ({
  disconnectStaleUserSockets: jest.fn().mockResolvedValue(0),
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

import bcrypt from 'bcryptjs';
import { login, resetPassword, changePassword } from '../controllers/auth';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/login', login);
  app.post('/reset-password', resetPassword);
  // Inject an authenticated user (as authenticateToken would) for change-password.
  app.put('/change-password', (req, _res, next) => {
    (req as any).user = { userId: 'u1', email: 'alice@acmecorp.com', isAdmin: false };
    next();
  }, changePassword);
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
  (bcrypt.compare as jest.Mock).mockResolvedValue(true);
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
      .send({ email: 'alice@acmecorp.com', password: 'TempPass123456' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('temp_password_expired');
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
      .send({ email: 'alice@acmecorp.com', password: 'TempPass123456' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('test.jwt.token');
    expect(res.body.user.mustChangePassword).toBe(true);
  });

  it('allows normal login for a user with no temp password (fields absent)', async () => {
    mockGetUserByEmail.mockResolvedValue({ ...baseUser });

    const res = await request(makeApp())
      .post('/login')
      .send({ email: 'alice@acmecorp.com', password: 'RealPass123456' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('test.jwt.token');
  });
});

// ---------------------------------------------------------------------------
// Reset — clears the temp-password lifecycle fields
// ---------------------------------------------------------------------------

describe('resetPassword — clears initial-password flags', () => {
  it('clears mustChangePassword and tempPasswordExpires (with null) on successful reset', async () => {
    mockGetUserByResetToken.mockResolvedValue({
      ...baseUser,
      resetPasswordToken: 'tok',
      resetPasswordExpires: new Date(Date.now() + 3_600_000).toISOString(),
      mustChangePassword: true,
      tempPasswordExpires: new Date(Date.now() + 60_000).toISOString(),
    });

    const res = await request(makeApp())
      .post('/reset-password')
      .send({ token: 'tok', password: 'BrandNewPass1234' });

    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        password: 'hashed-new-password',
        resetPasswordToken: undefined,
        resetPasswordExpires: undefined,
        mustChangePassword: false,
        tempPasswordExpires: null,
      })
    );
  });
});

// ---------------------------------------------------------------------------
// changePassword — authenticated self-service in-app password change
// ---------------------------------------------------------------------------

describe('changePassword', () => {
  it('rejects when currentPassword or newPassword is missing', async () => {
    const res = await request(makeApp())
      .put('/change-password')
      .send({ currentPassword: 'TempPass123456' });

    expect(res.status).toBe(400);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('rejects a new password shorter than 12 characters', async () => {
    const res = await request(makeApp())
      .put('/change-password')
      .send({ currentPassword: 'TempPass123456', newPassword: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least 12/i);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('rejects when the new password equals the current password', async () => {
    const res = await request(makeApp())
      .put('/change-password')
      .send({ currentPassword: 'SamePass12345', newPassword: 'SamePass12345' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/different/i);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('rejects when the current password is incorrect (401)', async () => {
    mockGetUserById.mockResolvedValue({ ...baseUser });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    const res = await request(makeApp())
      .put('/change-password')
      .send({ currentPassword: 'WrongPass1234', newPassword: 'BrandNewPass1234' });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/incorrect/i);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('rejects OAuth (Google) accounts', async () => {
    mockGetUserById.mockResolvedValue({ ...baseUser, isOAuthUser: true, googleId: 'g1' });

    const res = await request(makeApp())
      .put('/change-password')
      .send({ currentPassword: 'whatever12345', newPassword: 'BrandNewPass1234' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/google/i);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('returns 404 when the user does not exist', async () => {
    mockGetUserById.mockResolvedValue(undefined);

    const res = await request(makeApp())
      .put('/change-password')
      .send({ currentPassword: 'TempPass123456', newPassword: 'BrandNewPass1234' });

    expect(res.status).toBe(404);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('changes the password and clears temp-password flags (with null) on success', async () => {
    mockGetUserById.mockResolvedValue({
      ...baseUser,
      mustChangePassword: true,
      tempPasswordExpires: new Date(Date.now() + 60_000).toISOString(),
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const res = await request(makeApp())
      .put('/change-password')
      .send({ currentPassword: 'TempPass123456', newPassword: 'BrandNewPass1234' });

    expect(res.status).toBe(200);
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        password: 'hashed-new-password',
        mustChangePassword: false,
        tempPasswordExpires: null,
      })
    );
  });
});
