/**
 * ENG-512: Domain-based org auto-join (owner-approved) — signup-time hooks.
 *
 * On password signup (register) and Google OAuth signup (customer-portal
 * path), a new user whose email domain matches an org with autoJoinEnabled
 * should get a pending domain-join request created + the org owner emailed —
 * never a silent join. An explicit pending invite always wins if both exist.
 */

import express from 'express';
import request from 'supertest';

const mockGetUserByEmail = jest.fn();
const mockGetUserById = jest.fn();
const mockCreateUser = jest.fn();
const mockUpdateUser = jest.fn();
const mockGetOrgWithPendingInviteForEmail = jest.fn();
const mockGetOrgsWithAutoJoinDomain = jest.fn();
const mockUpdateOrg = jest.fn();
const mockAddPendingDomainJoinRequest = jest.fn();
const mockSendEmail = jest.fn().mockResolvedValue(undefined);

jest.mock('../services/db', () => ({
  userDb: {
    getUserByEmail: (...args: any[]) => mockGetUserByEmail(...args),
    getUserById: (...args: any[]) => mockGetUserById(...args),
    createUser: (...args: any[]) => mockCreateUser(...args),
    updateUser: (...args: any[]) => mockUpdateUser(...args),
  },
  orgDb: {
    getOrgWithPendingInviteForEmail: (...args: any[]) => mockGetOrgWithPendingInviteForEmail(...args),
    getOrgsWithAutoJoinDomain: (...args: any[]) => mockGetOrgsWithAutoJoinDomain(...args),
    updateOrg: (...args: any[]) => mockUpdateOrg(...args),
    addPendingDomainJoinRequest: (...args: any[]) => mockAddPendingDomainJoinRequest(...args),
  },
  taskDb: {},
  subscriberDb: {},
}));

jest.mock('../services/waitlistDb', () => ({
  waitlistDb: { getByEmail: jest.fn().mockResolvedValue(null) },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: (...args: any[]) => mockSendEmail(...args),
    sendTeamIntroductionEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getTierConfig: jest.fn().mockResolvedValue({ allowedPages: ['home'], allowedSkills: [] }),
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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.post('/register', register);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserByEmail.mockResolvedValue(null);
  mockGetUserById.mockResolvedValue(null);
  mockGetOrgWithPendingInviteForEmail.mockResolvedValue(null);
  mockGetOrgsWithAutoJoinDomain.mockResolvedValue([]);
  mockCreateUser.mockResolvedValue({
    userId: 'uuid-u1',
    email: 'alice@acmecorp.com',
    isAdmin: false,
    roles: ['customer'],
  });
  mockUpdateUser.mockResolvedValue({ userId: 'uuid-u1' });
  mockUpdateOrg.mockResolvedValue(undefined);
  mockAddPendingDomainJoinRequest.mockResolvedValue(undefined);
});

describe('register controller — domain auto-join requests', () => {
  // === FAIL / no-op cases ===

  it('does not look up domain-match orgs for a personal email domain (blocked upstream)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'user@gmail.com', password: 'ValidPass123!' });

    expect(res.status).toBe(400);
    expect(mockGetOrgsWithAutoJoinDomain).not.toHaveBeenCalled();
  });

  it('does not create a domain-join request when no org has auto-join enabled for the domain', async () => {
    mockGetOrgsWithAutoJoinDomain.mockResolvedValue([]);
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'alice@acmecorp.com', password: 'ValidPass123!' });

    expect(res.status).toBe(201);
    expect(mockGetOrgsWithAutoJoinDomain).toHaveBeenCalledWith('acmecorp.com');
    expect(mockAddPendingDomainJoinRequest).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('skips domain-match entirely when an explicit pending invite already exists for the email', async () => {
    mockGetOrgWithPendingInviteForEmail.mockResolvedValue({
      orgId: 'org-invited',
      pendingInvites: [{ email: 'alice@acmecorp.com', inviteToken: 'tok-1', invitedAt: '', invitedBy: '' }],
    });
    mockGetOrgsWithAutoJoinDomain.mockResolvedValue([
      { orgId: 'org-domain', autoJoinEnabled: true, autoJoinDomain: 'acmecorp.com', pendingDomainJoinRequests: [] },
    ]);

    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'alice@acmecorp.com', password: 'ValidPass123!' });

    expect(res.status).toBe(201);
    // Explicit invite wins — no domain-join request should be created.
    expect(mockGetOrgsWithAutoJoinDomain).not.toHaveBeenCalled();
    expect(mockAddPendingDomainJoinRequest).not.toHaveBeenCalled();
  });

  // === SUCCESS cases ===

  it('creates a pending domain-join request and emails the org owner on a matching domain', async () => {
    mockGetOrgsWithAutoJoinDomain.mockResolvedValue([
      {
        orgId: 'org-domain',
        ownerUserId: 'owner-1',
        name: 'Acme Corp Org',
        autoJoinEnabled: true,
        autoJoinDomain: 'acmecorp.com',
        pendingDomainJoinRequests: [],
      },
    ]);
    mockGetUserById.mockImplementation((userId: string) =>
      userId === 'owner-1'
        ? Promise.resolve({ userId: 'owner-1', email: 'owner@acmecorp.com', displayName: 'Owner' })
        : Promise.resolve(null)
    );

    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'alice@acmecorp.com', password: 'ValidPass123!' });

    expect(res.status).toBe(201);
    expect(mockAddPendingDomainJoinRequest).toHaveBeenCalledWith(
      'org-domain',
      expect.objectContaining({ email: 'alice@acmecorp.com' })
    );
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it('creates a request for every matching org when multiple orgs share the domain (tie-break: notify all, first-approve-wins)', async () => {
    mockGetOrgsWithAutoJoinDomain.mockResolvedValue([
      { orgId: 'org-a', ownerUserId: 'owner-a', name: 'Org A', autoJoinEnabled: true, autoJoinDomain: 'acmecorp.com', pendingDomainJoinRequests: [] },
      { orgId: 'org-b', ownerUserId: 'owner-b', name: 'Org B', autoJoinEnabled: true, autoJoinDomain: 'acmecorp.com', pendingDomainJoinRequests: [] },
    ]);
    mockGetUserById.mockImplementation((userId: string) =>
      Promise.resolve({ userId, email: `${userId}@acmecorp.com`, displayName: userId })
    );

    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'alice@acmecorp.com', password: 'ValidPass123!' });

    expect(res.status).toBe(201);
    expect(mockAddPendingDomainJoinRequest).toHaveBeenCalledTimes(2);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  it('does not fail registration if the domain-match lookup throws (non-fatal, matches invite-check behavior)', async () => {
    mockGetOrgsWithAutoJoinDomain.mockRejectedValue(new Error('ddb down'));
    const app = makeApp();
    const res = await request(app)
      .post('/register')
      .send({ email: 'alice@acmecorp.com', password: 'ValidPass123!' });

    expect(res.status).toBe(201);
  });
});
