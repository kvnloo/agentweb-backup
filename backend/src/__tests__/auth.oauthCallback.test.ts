import { googleCallback } from '../controllers/auth';
import { userDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import { emailService } from '../services/emailService';
import { Profile } from 'passport-google-oauth20';
import { Request } from 'express';
import jwt from 'jsonwebtoken';

// Mock the dependencies
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
const mockWaitlistDb = waitlistDb as jest.Mocked<typeof waitlistDb>;
const mockEmailService = emailService as jest.Mocked<typeof emailService>;
const mockJwt = jwt as jest.Mocked<typeof jwt>;

describe('OAuth Callback - Customer Role Addition for Invited Users', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock JWT sign to return a token
    (mockJwt.sign as jest.Mock).mockReturnValue('mock-jwt-token');
  });

  const createMockProfile = (email: string, displayName?: string): Profile => ({
    id: 'google-id-123',
    displayName: displayName || 'Test User',
    emails: [{ value: email, verified: true }],
    provider: 'google',
    _raw: '',
    _json: {
      iss: 'https://accounts.google.com',
      aud: 'test-client-id',
      sub: 'google-id-123',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      email: email,
      email_verified: true
    }
  } as Profile);

  const createMockRequest = (portalOrigin: string = 'customer'): Partial<Request> => ({
    query: { state: portalOrigin }
  });

  const createMockDone = () => {
    const doneFn = jest.fn();
    return doneFn;
  };

  it('should sign OAuth token with 90d expiration', async () => {
    const email = 'partner@example.com';
    const existingUser = {
      userId: 'user-000',
      email,
      roles: ['partner'],
      isOAuthUser: true,
      isAdmin: false,
      password: 'placeholder',
      isActive: true,
      createdAt: new Date().toISOString()
    };

    mockUserDb.getUserByEmail.mockResolvedValue(existingUser);
    mockWaitlistDb.getByEmail.mockResolvedValue(null as any);
    (mockUserDb as any).updateUser.mockResolvedValue(undefined);

    const profile = createMockProfile(email);
    const req = createMockRequest('partner');
    const done = createMockDone();

    await googleCallback(
      req as Request,
      'access-token',
      'refresh-token',
      profile,
      done
    );

    expect(mockJwt.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        email,
        roles: ['partner'],
        isAdmin: false
      }),
      expect.any(String),
      { expiresIn: '90d' }
    );
  });

  describe('Existing user with invited waitlist entry', () => {
    it('should add customer role to existing free user when they have invited waitlist entry', async () => {
      const email = 'freeuser@example.com';
      const userId = 'user-123';
      const existingUser = {
        userId,
        email,
        roles: ['free'],
        isOAuthUser: true,
        isAdmin: false,
        password: 'placeholder',
        isActive: true,
        createdAt: new Date().toISOString()
      };

      const waitlistEntry = {
        email,
        status: 'invited',
        joinedAt: new Date().toISOString(),
        invitedAt: new Date().toISOString()
      };

      mockUserDb.getUserByEmail.mockResolvedValue(existingUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(waitlistEntry);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const profile = createMockProfile(email);
      const req = createMockRequest('customer');
      const done = createMockDone();

      await googleCallback(
        req as Request,
        'access-token',
        'refresh-token',
        profile,
        done
      );

      // Verify that updateUser was called to add customer role
      expect(mockUserDb.getUserByEmail).toHaveBeenCalledWith(email);
      expect(mockWaitlistDb.getByEmail).toHaveBeenCalledWith(email);
      // Check that updateUser was called with roles update (may be called multiple times)
      expect((mockUserDb as any).updateUser).toHaveBeenCalledWith(userId, {
        roles: ['free', 'customer']
      });

      // Verify done was called successfully (no error)
      expect(done).toHaveBeenCalled();
      const doneCall = done.mock.calls[0];
      expect(doneCall[0]).toBeNull(); // No error
      expect(doneCall[1]).toBeDefined(); // User object returned
      expect(doneCall[1]?.roles).toContain('customer');
    });

    it('should add customer role to user with no roles when they have invited waitlist entry', async () => {
      const email = 'noroles@example.com';
      const userId = 'user-456';
      const existingUser = {
        userId,
        email,
        roles: [],
        isOAuthUser: true,
        isAdmin: false,
        password: 'placeholder',
        isActive: true,
        createdAt: new Date().toISOString()
      };

      const waitlistEntry = {
        email,
        status: 'invited',
        joinedAt: new Date().toISOString(),
        invitedAt: new Date().toISOString()
      };

      mockUserDb.getUserByEmail.mockResolvedValue(existingUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(waitlistEntry);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const profile = createMockProfile(email);
      const req = createMockRequest('customer');
      const done = createMockDone();

      await googleCallback(
        req as Request,
        'access-token',
        'refresh-token',
        profile,
        done
      );

      // Verify that updateUser was called to add customer role
      // Check that updateUser was called with roles update (may be called multiple times)
      expect((mockUserDb as any).updateUser).toHaveBeenCalledWith(userId, {
        roles: ['customer']
      });

      // Verify done was called successfully
      expect(done).toHaveBeenCalled();
      const doneCall = done.mock.calls[0];
      expect(doneCall[0]).toBeNull();
      expect(doneCall[1]?.roles).toContain('customer');
    });

    it('should not add customer role if user already has customer role', async () => {
      const email = 'customer@example.com';
      const userId = 'user-789';
      const existingUser = {
        userId,
        email,
        roles: ['free', 'customer'],
        isOAuthUser: true,
        isAdmin: false,
        password: 'placeholder',
        isActive: true,
        createdAt: new Date().toISOString()
      };

      const waitlistEntry = {
        email,
        status: 'invited',
        joinedAt: new Date().toISOString(),
        invitedAt: new Date().toISOString()
      };

      mockUserDb.getUserByEmail.mockResolvedValue(existingUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(waitlistEntry);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const profile = createMockProfile(email);
      const req = createMockRequest('customer');
      const done = createMockDone();

      await googleCallback(
        req as Request,
        'access-token',
        'refresh-token',
        profile,
        done
      );

      // Verify that updateUser was NOT called with roles (user already has customer role)
      // But it may be called for lastLoginTime update
      expect(mockUserDb.getUserByEmail).toHaveBeenCalledWith(email);
      expect(mockWaitlistDb.getByEmail).toHaveBeenCalledWith(email);
      // Check that updateUser was NOT called with roles update
      const updateUserCalls = (mockUserDb as any).updateUser.mock.calls;
      const rolesUpdateCall = updateUserCalls.find((call: any[]) => 
        call[1] && call[1].roles !== undefined
      );
      expect(rolesUpdateCall).toBeUndefined();

      // Verify done was called successfully
      expect(done).toHaveBeenCalled();
      const doneCall = done.mock.calls[0];
      expect(doneCall[0]).toBeNull();
    });

    it('should not add customer role if waitlist entry status is not invited', async () => {
      const email = 'pending@example.com';
      const userId = 'user-999';
      const existingUser = {
        userId,
        email,
        roles: ['free'],
        isOAuthUser: true,
        isAdmin: false,
        password: 'placeholder',
        isActive: true,
        createdAt: new Date().toISOString()
      };

      const waitlistEntry = {
        email,
        status: 'pending', // Not invited
        joinedAt: new Date().toISOString(),
        invitedAt: undefined
      };

      mockUserDb.getUserByEmail.mockResolvedValue(existingUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(waitlistEntry);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const profile = createMockProfile(email);
      const req = createMockRequest('customer');
      const done = createMockDone();

      await googleCallback(
        req as Request,
        'access-token',
        'refresh-token',
        profile,
        done
      );

      // Verify that updateUser was NOT called with roles (waitlist status is not invited)
      // But it may be called for lastLoginTime update
      expect(mockUserDb.getUserByEmail).toHaveBeenCalledWith(email);
      expect(mockWaitlistDb.getByEmail).toHaveBeenCalledWith(email);
      // Check that updateUser was NOT called with roles update
      const updateUserCalls = (mockUserDb as any).updateUser.mock.calls;
      const rolesUpdateCall = updateUserCalls.find((call: any[]) => 
        call[1] && call[1].roles !== undefined
      );
      expect(rolesUpdateCall).toBeUndefined();
    });

    it('should not add customer role if user has no waitlist entry', async () => {
      const email = 'nowaitlist@example.com';
      const userId = 'user-888';
      const existingUser = {
        userId,
        email,
        roles: ['free'],
        isOAuthUser: true,
        isAdmin: false,
        password: 'placeholder',
        isActive: true,
        createdAt: new Date().toISOString()
      };

      mockUserDb.getUserByEmail.mockResolvedValue(existingUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(undefined); // No waitlist entry
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const profile = createMockProfile(email);
      const req = createMockRequest('customer');
      const done = createMockDone();

      await googleCallback(
        req as Request,
        'access-token',
        'refresh-token',
        profile,
        done
      );

      // Verify that updateUser was NOT called with roles (no waitlist entry)
      // But it may be called for lastLoginTime update
      expect(mockUserDb.getUserByEmail).toHaveBeenCalledWith(email);
      expect(mockWaitlistDb.getByEmail).toHaveBeenCalledWith(email);
      // Check that updateUser was NOT called with roles update
      const updateUserCalls = (mockUserDb as any).updateUser.mock.calls;
      const rolesUpdateCall = updateUserCalls.find((call: any[]) => 
        call[1] && call[1].roles !== undefined
      );
      expect(rolesUpdateCall).toBeUndefined();
    });

    it('should preserve existing roles when adding customer role', async () => {
      const email = 'multirole@example.com';
      const userId = 'user-777';
      const existingUser = {
        userId,
        email,
        roles: ['free', 'partner'],
        isOAuthUser: true,
        isAdmin: false,
        password: 'placeholder',
        isActive: true,
        createdAt: new Date().toISOString()
      };

      const waitlistEntry = {
        email,
        status: 'invited',
        joinedAt: new Date().toISOString(),
        invitedAt: new Date().toISOString()
      };

      mockUserDb.getUserByEmail.mockResolvedValue(existingUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(waitlistEntry);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const profile = createMockProfile(email);
      const req = createMockRequest('customer');
      const done = createMockDone();

      await googleCallback(
        req as Request,
        'access-token',
        'refresh-token',
        profile,
        done
      );

      // Verify that updateUser was called with all existing roles plus customer
      // Check that updateUser was called with roles update (may be called multiple times)
      expect((mockUserDb as any).updateUser).toHaveBeenCalledWith(userId, {
        roles: ['free', 'partner', 'customer']
      });

      // Verify done was called successfully
      expect(done).toHaveBeenCalled();
      const doneCall = done.mock.calls[0];
      expect(doneCall[0]).toBeNull();
      expect(doneCall[1]?.roles).toContain('customer');
      expect(doneCall[1]?.roles).toContain('free');
      expect(doneCall[1]?.roles).toContain('partner');
    });

    it('should allow access to customer portal after adding customer role', async () => {
      const email = 'freeuser@example.com';
      const userId = 'user-123';
      const existingUser = {
        userId,
        email,
        roles: ['free'],
        isOAuthUser: true,
        isAdmin: false,
        password: 'placeholder',
        isActive: true,
        createdAt: new Date().toISOString()
      };

      const waitlistEntry = {
        email,
        status: 'invited',
        joinedAt: new Date().toISOString(),
        invitedAt: new Date().toISOString()
      };

      mockUserDb.getUserByEmail.mockResolvedValue(existingUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(waitlistEntry);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const profile = createMockProfile(email);
      const req = createMockRequest('customer');
      const done = createMockDone();

      await googleCallback(
        req as Request,
        'access-token',
        'refresh-token',
        profile,
        done
      );

      // Verify that updateUser was called to add customer role
      // Check that updateUser was called with roles update (may be called multiple times)
      expect((mockUserDb as any).updateUser).toHaveBeenCalledWith(userId, {
        roles: ['free', 'customer']
      });

      // Verify done was called successfully (no error, meaning access granted)
      expect(done).toHaveBeenCalled();
      const doneCall = done.mock.calls[0];
      expect(doneCall[0]).toBeNull(); // No error = access granted
      expect(doneCall[1]).toBeDefined(); // User object returned
      expect(doneCall[1]?.roles).toContain('customer');
    });
  });

  describe('Introduction email auto-send for new OAuth users', () => {
    const newUser = (userId: string, email: string, displayName: string) => ({
      userId,
      email,
      displayName,
      roles: ['free'] as ('free' | 'customer' | 'partner')[],
      isOAuthUser: true,
      isAdmin: false,
      password: 'placeholder',
      isActive: true,
      createdAt: new Date().toISOString()
    });

    beforeEach(() => {
      mockEmailService.sendTeamIntroductionEmail.mockResolvedValue(undefined as any);
    });

    it('should send intro email to new user signing up via genius portal (NODE_ENV=test)', async () => {
      const email = 'newgenius@example.com';
      const userId = 'user-genius-1';
      const displayName = 'Genius User';

      mockUserDb.getUserByEmail.mockResolvedValue(null as any);
      mockUserDb.createUser.mockResolvedValue(newUser(userId, email, displayName) as any);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);
      mockWaitlistDb.getByEmail.mockResolvedValue(null as any);

      const profile = createMockProfile(email, displayName);
      const req = createMockRequest('genius');
      const done = createMockDone();

      await googleCallback(req as Request, 'access-token', 'refresh-token', profile, done);

      await new Promise(resolve => setImmediate(resolve));

      expect(mockEmailService.sendTeamIntroductionEmail).toHaveBeenCalledWith(email, displayName);
    });

    it('should send intro email to new user signing up via customer portal (NODE_ENV=test)', async () => {
      const email = 'newcustomer@example.com';
      const userId = 'user-customer-1';
      const displayName = 'Customer User';

      mockUserDb.getUserByEmail.mockResolvedValue(null as any);
      mockUserDb.createUser.mockResolvedValue(newUser(userId, email, displayName) as any);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);
      mockWaitlistDb.getByEmail.mockResolvedValue(null as any);

      const profile = createMockProfile(email, displayName);
      const req = createMockRequest('customer');
      const done = createMockDone();

      await googleCallback(req as Request, 'access-token', 'refresh-token', profile, done);

      await new Promise(resolve => setImmediate(resolve));

      expect(mockEmailService.sendTeamIntroductionEmail).toHaveBeenCalledWith(email, displayName);
    });

    it('should update introductionEmailSent timestamp after sending intro email', async () => {
      const email = 'newtimestamp@example.com';
      const userId = 'user-ts-1';
      const displayName = 'Timestamp User';

      mockUserDb.getUserByEmail.mockResolvedValue(null as any);
      mockUserDb.createUser.mockResolvedValue(newUser(userId, email, displayName) as any);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);
      mockWaitlistDb.getByEmail.mockResolvedValue(null as any);

      const profile = createMockProfile(email, displayName);
      const req = createMockRequest('customer');
      const done = createMockDone();

      await googleCallback(req as Request, 'access-token', 'refresh-token', profile, done);

      await new Promise(resolve => setImmediate(resolve));

      const updateCalls = (mockUserDb as any).updateUser.mock.calls;
      const introEmailUpdate = updateCalls.find((call: any[]) =>
        call[1] && call[1].introductionEmailSent !== undefined
      );
      expect(introEmailUpdate).toBeDefined();
      expect(introEmailUpdate[0]).toBe(userId);
      expect(introEmailUpdate[1].introductionEmailSent).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should not send intro email to existing OAuth users who log in again', async () => {
      const email = 'existing@example.com';
      const existingUser = {
        userId: 'user-existing-1',
        email,
        roles: ['free'],
        isOAuthUser: true,
        isAdmin: false,
        password: 'placeholder',
        isActive: true,
        createdAt: new Date().toISOString()
      };

      mockUserDb.getUserByEmail.mockResolvedValue(existingUser);
      mockWaitlistDb.getByEmail.mockResolvedValue(null as any);
      (mockUserDb as any).updateUser.mockResolvedValue(undefined);

      const profile = createMockProfile(email);
      const req = createMockRequest('customer');
      const done = createMockDone();

      await googleCallback(req as Request, 'access-token', 'refresh-token', profile, done);

      await new Promise(resolve => setImmediate(resolve));

      expect(mockEmailService.sendTeamIntroductionEmail).not.toHaveBeenCalled();
    });
  });
});
