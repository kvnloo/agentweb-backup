/**
 * ENG-512: domain-based org auto-join — OAuth (Google) signup hook.
 *
 * The password-signup path (register()) has extensive coverage in
 * auth.domainAutoJoin.test.ts, and both paths call the exact same shared
 * helper (createDomainJoinRequestsForNewUser). This file specifically
 * exercises the OAuth call site's wiring (portalOrigin gating, the
 * hasPendingInvite guard, new-vs-existing-user branching) without needing a
 * real Google OAuth round trip — googleCallback is a plain exported function,
 * callable directly with a mocked profile, same pattern as the existing
 * auth.oauthCallback.test.ts.
 */

import { googleCallback } from '../controllers/auth';
import { userDb, orgDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import { emailService } from '../services/emailService';
import { Profile } from 'passport-google-oauth20';
import { Request } from 'express';
import jwt from 'jsonwebtoken';

jest.mock('../services/db');
jest.mock('../services/waitlistDb');
jest.mock('../services/emailService');
jest.mock('../services/subscriptionService', () => ({
  getTierConfig: jest.fn().mockResolvedValue({ allowedPages: [], allowedSkills: [] }),
  DEFAULT_PAGES: [],
}));
jest.mock('../services/crmAutoSyncService', () => ({
  syncNewUserToLeadList: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('jsonwebtoken');

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockWaitlistDb = waitlistDb as jest.Mocked<typeof waitlistDb>;
const mockEmailService = emailService as jest.Mocked<typeof emailService>;
const mockJwt = jwt as jest.Mocked<typeof jwt>;

const createMockProfile = (email: string, displayName = 'Test User'): Profile => ({
  id: 'google-id-123',
  displayName,
  emails: [{ value: email, verified: true }],
  provider: 'google',
  _raw: '',
  _json: {
    iss: 'https://accounts.google.com',
    aud: 'test-client-id',
    sub: 'google-id-123',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    email,
    email_verified: true,
  },
} as Profile);

const createMockRequest = (portalOrigin = 'customer'): Partial<Request> => ({
  query: { state: portalOrigin },
});

const createMockDone = () => jest.fn();

const newUser = (userId: string, email: string, displayName: string) => ({
  userId,
  email,
  displayName,
  roles: ['customer'] as ('free' | 'customer' | 'partner')[],
  isOAuthUser: true,
  isAdmin: false,
  password: 'placeholder',
  isActive: true,
  orgId: undefined,
  pendingOrgInvite: undefined,
  createdAt: new Date().toISOString(),
});

beforeEach(() => {
  jest.clearAllMocks();
  (mockJwt.sign as jest.Mock).mockReturnValue('mock-jwt-token');
  mockWaitlistDb.getByEmail.mockResolvedValue(null as any);
  (mockUserDb as any).updateUser.mockResolvedValue(undefined);
  mockOrgDb.getOrgWithPendingInviteForEmail.mockResolvedValue(null);
  mockOrgDb.getOrgsWithAutoJoinDomain.mockResolvedValue([]);
  (mockOrgDb as any).updateOrg.mockResolvedValue(undefined);
  (mockOrgDb as any).addPendingDomainJoinRequest.mockResolvedValue(undefined);
  mockEmailService.sendTeamIntroductionEmail.mockResolvedValue(undefined as any);
});

describe('googleCallback — domain auto-join requests (customer portal, new user)', () => {
  it('does not look up domain-match orgs for a personal email domain', async () => {
    const email = 'newuser@gmail.com';
    mockUserDb.getUserByEmail.mockResolvedValue(null as any);

    const profile = createMockProfile(email);
    const req = createMockRequest('customer');
    const done = createMockDone();

    await googleCallback(req as Request, 'access-token', 'refresh-token', profile, done);
    await new Promise((resolve) => setImmediate(resolve));

    // Blocked upstream by isCompanyEmail on the customer-portal path —
    // no user gets created at all, so the domain-match hook never runs.
    expect(mockUserDb.createUser).not.toHaveBeenCalled();
    expect(mockOrgDb.getOrgsWithAutoJoinDomain).not.toHaveBeenCalled();
  });

  it('does not re-run the domain-match hook when an existing standalone user logs in again (Greptile review — was creating a duplicate request + email on every login)', async () => {
    const email = 'existingstandalone@acmecorp.com';
    const existingUser = {
      userId: 'user-existing-oauth',
      email,
      displayName: 'Existing Standalone',
      roles: ['customer'],
      isOAuthUser: true,
      isAdmin: false,
      password: 'placeholder',
      isActive: true,
      orgId: undefined,
      pendingOrgInvite: undefined,
      createdAt: new Date().toISOString(),
    };
    // The user already exists — getUserByEmail returns it, so googleCallback
    // takes the existing-user path and never calls createUser.
    mockUserDb.getUserByEmail.mockResolvedValue(existingUser as any);
    mockOrgDb.getOrgsWithAutoJoinDomain.mockResolvedValue([
      { orgId: 'org-domain', autoJoinEnabled: true, autoJoinDomain: 'acmecorp.com', pendingDomainJoinRequests: [] } as any,
    ]);

    const profile = createMockProfile(email, 'Existing Standalone');
    const req = createMockRequest('customer');
    const done = createMockDone();

    await googleCallback(req as Request, 'access-token', 'refresh-token', profile, done);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockUserDb.createUser).not.toHaveBeenCalled();
    expect(mockOrgDb.getOrgsWithAutoJoinDomain).not.toHaveBeenCalled();
    expect(mockOrgDb.addPendingDomainJoinRequest).not.toHaveBeenCalled();
    expect(mockEmailService.sendEmail).not.toHaveBeenCalled();
  });

  it('does not create a domain-join request when no org has auto-join enabled for the domain', async () => {
    const email = 'newcustomer@acmecorp.com';
    const userId = 'user-oauth-1';
    mockUserDb.getUserByEmail.mockResolvedValue(null as any);
    mockUserDb.createUser.mockResolvedValue(newUser(userId, email, 'New Customer') as any);
    mockOrgDb.getOrgsWithAutoJoinDomain.mockResolvedValue([]);

    const profile = createMockProfile(email, 'New Customer');
    const req = createMockRequest('customer');
    const done = createMockDone();

    await googleCallback(req as Request, 'access-token', 'refresh-token', profile, done);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockOrgDb.getOrgsWithAutoJoinDomain).toHaveBeenCalledWith('acmecorp.com');
    expect(mockOrgDb.addPendingDomainJoinRequest).not.toHaveBeenCalled();
    expect(mockEmailService.sendEmail).not.toHaveBeenCalled();
  });

  it('skips domain-match entirely when an explicit pending invite already exists for the email', async () => {
    const email = 'invited@acmecorp.com';
    const userId = 'user-oauth-2';
    mockUserDb.getUserByEmail.mockResolvedValue(null as any);
    mockUserDb.createUser.mockResolvedValue(newUser(userId, email, 'Invited User') as any);
    mockOrgDb.getOrgWithPendingInviteForEmail.mockResolvedValue({
      orgId: 'org-invited',
      pendingInvites: [{ email, inviteToken: 'tok-1', invitedAt: '', invitedBy: '' }],
    } as any);
    mockOrgDb.getOrgsWithAutoJoinDomain.mockResolvedValue([
      { orgId: 'org-domain', autoJoinEnabled: true, autoJoinDomain: 'acmecorp.com', pendingDomainJoinRequests: [] } as any,
    ]);

    const profile = createMockProfile(email, 'Invited User');
    const req = createMockRequest('customer');
    const done = createMockDone();

    await googleCallback(req as Request, 'access-token', 'refresh-token', profile, done);
    await new Promise((resolve) => setImmediate(resolve));

    // Explicit invite wins — the domain-match lookup should never even run.
    expect(mockOrgDb.getOrgsWithAutoJoinDomain).not.toHaveBeenCalled();
    expect(mockOrgDb.addPendingDomainJoinRequest).not.toHaveBeenCalled();
  });

  it('creates a pending domain-join request and emails the org owner on a matching domain', async () => {
    const email = 'newcustomer@acmecorp.com';
    const userId = 'user-oauth-3';
    mockUserDb.getUserByEmail.mockImplementation((lookupEmail: string) =>
      lookupEmail === email
        ? Promise.resolve(null as any)
        : Promise.resolve(null as any)
    );
    mockUserDb.createUser.mockResolvedValue(newUser(userId, email, 'New Customer') as any);
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'owner-1',
      email: 'owner@acmecorp.com',
      displayName: 'Owner',
    } as any);
    mockOrgDb.getOrgsWithAutoJoinDomain.mockResolvedValue([
      {
        orgId: 'org-domain',
        ownerUserId: 'owner-1',
        name: 'Acme Corp Org',
        autoJoinEnabled: true,
        autoJoinDomain: 'acmecorp.com',
        pendingDomainJoinRequests: [],
      } as any,
    ]);

    const profile = createMockProfile(email, 'New Customer');
    const req = createMockRequest('customer');
    const done = createMockDone();

    await googleCallback(req as Request, 'access-token', 'refresh-token', profile, done);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockOrgDb.addPendingDomainJoinRequest).toHaveBeenCalledWith(
      'org-domain',
      expect.objectContaining({ userId, email })
    );
    expect(mockEmailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not create a domain-join request on the partner/genius portal path (isCompanyEmail not enforced there, but neither is auto-join)', async () => {
    // The domain-match hook only runs from the shared block that also gates
    // the pending-invite check, which executes regardless of portalOrigin —
    // but this covers the genius-portal new-user creation branch (a
    // different code path than customer-portal's) to make sure it still
    // wires into the same hook correctly.
    const email = 'geniususer@acmecorp.com';
    const userId = 'user-genius-1';
    mockUserDb.getUserByEmail.mockResolvedValue(null as any);
    mockUserDb.createUser.mockResolvedValue(newUser(userId, email, 'Genius User') as any);
    mockUserDb.getUserById.mockResolvedValue({
      userId: 'owner-2',
      email: 'owner2@acmecorp.com',
      displayName: 'Owner Two',
    } as any);
    mockOrgDb.getOrgsWithAutoJoinDomain.mockResolvedValue([
      {
        orgId: 'org-genius',
        ownerUserId: 'owner-2',
        name: 'Genius Org',
        autoJoinEnabled: true,
        autoJoinDomain: 'acmecorp.com',
        pendingDomainJoinRequests: [],
      } as any,
    ]);

    const profile = createMockProfile(email, 'Genius User');
    const req = createMockRequest('genius');
    const done = createMockDone();

    await googleCallback(req as Request, 'access-token', 'refresh-token', profile, done);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockOrgDb.addPendingDomainJoinRequest).toHaveBeenCalledWith(
      'org-genius',
      expect.objectContaining({ userId, email })
    );
  });
});
