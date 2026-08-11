import express from 'express';
import request from 'supertest';

const mockGetUserByEmail = jest.fn();
const mockGetUserById = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetOrgWithPendingInviteForEmail = jest.fn();
const mockGetOrgsWithAutoJoinDomain = jest.fn();
const mockAddPendingDomainJoinRequest = jest.fn();
const mockSyncNewUserToLeadList = jest.fn();
const mockOnUserRegistered = jest.fn();
const mockSendTeamIntroductionEmail = jest.fn();
const mockJwtSign = jest.fn();

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: (...args: unknown[]) => mockGetUserByEmail(...args),
    getUserById: (...args: unknown[]) => mockGetUserById(...args),
    createUser: (...args: unknown[]) => mockCreateUser(...args),
    updateUser: (...args: unknown[]) => mockUpdateUser(...args),
  },
  orgDb: {
    getOrgWithPendingInviteForEmail: (...args: unknown[]) =>
      mockGetOrgWithPendingInviteForEmail(...args),
    getOrgsWithAutoJoinDomain: (...args: unknown[]) => mockGetOrgsWithAutoJoinDomain(...args),
    addPendingDomainJoinRequest: (...args: unknown[]) => mockAddPendingDomainJoinRequest(...args),
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
    sendTeamIntroductionEmail: (...args: unknown[]) => mockSendTeamIntroductionEmail(...args),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getTierConfig: jest.fn().mockResolvedValue({ allowedPages: ['home'], allowedSkills: [] }),
  DEFAULT_PAGES: ['home'],
}));

jest.mock('../services/crmAutoSyncService', () => ({
  syncNewUserToLeadList: (...args: unknown[]) => mockSyncNewUserToLeadList(...args),
}));

jest.mock('../types/attribution', () => ({
  normalizeAttribution: jest.fn().mockReturnValue(null),
}));

jest.mock('../services/contactCaptureHooks', () => ({
  onUserRegistered: (...args: unknown[]) => mockOnUserRegistered(...args),
}));

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-password'),
  compare: jest.fn().mockResolvedValue(true),
}));

jest.mock('jsonwebtoken', () => ({
  sign: (...args: unknown[]) => mockJwtSign(...args),
}));

import { register } from '../controllers/auth';

const app = express();
app.use(express.json());
app.post('/register', register);

const registerRequest = (email = 'ghost@unresolvable.test') =>
  request(app)
    .post('/register')
    .send({ email, password: 'ValidPass123!' });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserByEmail.mockResolvedValue(null);
  mockGetUserById.mockResolvedValue({ email: 'owner@unresolvable.test' });
  mockCreateUser.mockResolvedValue({
    userId: 'persisted-user',
    email: 'ghost@unresolvable.test',
    roles: ['customer'],
    isAdmin: false,
  });
  mockUpdateUser.mockResolvedValue({ userId: 'persisted-user' });
  mockGetOrgWithPendingInviteForEmail.mockResolvedValue(null);
  mockGetOrgsWithAutoJoinDomain.mockResolvedValue([]);
  mockSyncNewUserToLeadList.mockResolvedValue(undefined);
  mockOnUserRegistered.mockResolvedValue(undefined);
  mockSendTeamIntroductionEmail.mockResolvedValue(undefined);
  mockJwtSign.mockReturnValue('signed.jwt');
});

describe('register persistence boundary', () => {
  it('returns an actionable non-2xx and no token when createUser reports no persisted user', async () => {
    mockCreateUser.mockResolvedValue(undefined);

    const response = await registerRequest();

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      message: 'We could not create your account. Please try again.',
      code: 'registration_persistence_failed',
    });
    expect(response.body.user).toBeUndefined();
    expect(mockJwtSign).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it('creates no pending organization request when persistence fails', async () => {
    mockCreateUser.mockResolvedValue(undefined);
    mockGetOrgsWithAutoJoinDomain.mockResolvedValue([{ orgId: 'org-1' }]);

    await registerRequest();

    expect(mockGetOrgWithPendingInviteForEmail).not.toHaveBeenCalled();
    expect(mockGetOrgsWithAutoJoinDomain).not.toHaveBeenCalled();
    expect(mockAddPendingDomainJoinRequest).not.toHaveBeenCalled();
  });

  it('starts no CRM, timeline, or introduction-email side effect when persistence fails', async () => {
    mockCreateUser.mockResolvedValue(undefined);

    await registerRequest();

    expect(mockSyncNewUserToLeadList).not.toHaveBeenCalled();
    expect(mockOnUserRegistered).not.toHaveBeenCalled();
    expect(mockSendTeamIntroductionEmail).not.toHaveBeenCalled();
  });

  it('preserves the persisted company-domain registration path', async () => {
    mockCreateUser.mockResolvedValue({
      userId: 'persisted-user',
      email: 'member@agentweb.pro',
      roles: ['customer'],
      isAdmin: false,
    });

    const response = await registerRequest('member@agentweb.pro');

    expect(response.status).toBe(201);
    expect(response.body.token).toBe('signed.jwt');
    expect(mockUpdateUser).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ subscriptionType: 'Free' }),
    );
    expect(mockSyncNewUserToLeadList).toHaveBeenCalledTimes(1);
    expect(mockOnUserRegistered).toHaveBeenCalledTimes(1);
  });
});
