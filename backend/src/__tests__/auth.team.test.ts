// @ts-nocheck
import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';

// Mock teamService before importing auth
const mockGetTeamsForUser = jest.fn();
jest.mock('../services/teamService', () => ({
  teamService: {
    getTeamsForUser: mockGetTeamsForUser,
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getUserByEmail: jest.fn(),
    createUser: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock('../services/agencyService', () => ({
  agencyService: {
    isAgencyForClient: jest.fn(),
  },
}));

jest.mock('jsonwebtoken');
jest.mock('bcryptjs');

import { authenticateToken, getEffectiveOwnerId, AuthenticatedRequest, getUserFromToken } from '../middleware/auth';
import { userDb } from '../services/db';
import { login, register } from '../controllers/auth';

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockJwt = jwt as jest.Mocked<typeof jwt>;

const createReq = (headers: Record<string, string> = {}): any => ({
  headers,
});

const createRes = (): any => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const createNext = (): jest.Mock => jest.fn();

describe('Auth middleware — team support', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
  });

  // ─── Solo user (no team) ───────────────────────────────────────────

  describe('solo user (no team)', () => {
    it('should NOT set teamId on request when user has no team', async () => {
      const req = createReq({ authorization: 'Bearer valid-token' });
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'solo-user-1',
        email: 'solo@example.com',
        isAdmin: false,
        roles: ['customer'],
      });

      mockUserDb.getUserById.mockResolvedValue({
        userId: 'solo-user-1',
        email: 'solo@example.com',
        isAdmin: false,
        roles: ['customer'],
      } as any);

      mockGetTeamsForUser.mockResolvedValue([]);

      await authenticateToken(req, res, next);

      expect(next).toHaveBeenCalled();
      const authReq = req as AuthenticatedRequest;
      expect(authReq.user.userId).toBe('solo-user-1');
      expect(authReq.user.teamId).toBeUndefined();
    });

    it('getEffectiveOwnerId returns userId for solo user', () => {
      const req = createReq() as AuthenticatedRequest;
      req.user = {
        userId: 'solo-user-1',
        email: 'solo@example.com',
        isAdmin: false,
        roles: ['customer'],
      };

      const ownerId = getEffectiveOwnerId(req);
      expect(ownerId).toBe('solo-user-1');
    });
  });

  // ─── Team member ───────────────────────────────────────────────────

  describe('team member', () => {
    it('should set teamId on request when user belongs to a team', async () => {
      const req = createReq({ authorization: 'Bearer valid-token' });
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'team-user-1',
        email: 'team@example.com',
        isAdmin: false,
        roles: ['customer'],
        teamId: 'team-abc',
      });

      mockUserDb.getUserById.mockResolvedValue({
        userId: 'team-user-1',
        email: 'team@example.com',
        isAdmin: false,
        roles: ['customer'],
      } as any);

      // teamId is in JWT, so no extra lookup needed
      mockGetTeamsForUser.mockResolvedValue([
        { teamId: 'team-abc', userId: 'team-user-1', role: 'member', status: 'active' },
      ]);

      await authenticateToken(req, res, next);

      expect(next).toHaveBeenCalled();
      const authReq = req as AuthenticatedRequest;
      expect(authReq.user.teamId).toBe('team-abc');
    });

    it('getEffectiveOwnerId returns teamId for team member', () => {
      const req = createReq() as AuthenticatedRequest;
      req.user = {
        userId: 'team-user-1',
        email: 'team@example.com',
        isAdmin: false,
        roles: ['customer'],
        teamId: 'team-abc',
      };

      const ownerId = getEffectiveOwnerId(req);
      expect(ownerId).toBe('team-abc');
    });
  });

  // ─── Team owner ────────────────────────────────────────────────────

  describe('team owner', () => {
    it('should set teamId for team owner', async () => {
      const req = createReq({ authorization: 'Bearer valid-token' });
      const res = createRes();
      const next = createNext();

      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'owner-user-1',
        email: 'owner@example.com',
        isAdmin: false,
        roles: ['customer'],
        teamId: 'team-xyz',
      });

      mockUserDb.getUserById.mockResolvedValue({
        userId: 'owner-user-1',
        email: 'owner@example.com',
        isAdmin: false,
        roles: ['customer'],
      } as any);

      mockGetTeamsForUser.mockResolvedValue([
        { teamId: 'team-xyz', userId: 'owner-user-1', role: 'owner', status: 'active' },
      ]);

      await authenticateToken(req, res, next);

      expect(next).toHaveBeenCalled();
      const authReq = req as AuthenticatedRequest;
      expect(authReq.user.teamId).toBe('team-xyz');
    });
  });

  // ─── Backward compatibility ────────────────────────────────────────

  describe('backward compatibility', () => {
    it('should work with JWT that has no teamId field (old tokens)', async () => {
      const req = createReq({ authorization: 'Bearer old-token' });
      const res = createRes();
      const next = createNext();

      // Old JWT without teamId
      (mockJwt.verify as jest.Mock).mockReturnValue({
        userId: 'old-user-1',
        email: 'old@example.com',
        isAdmin: false,
        roles: ['customer'],
        // no teamId field
      });

      mockUserDb.getUserById.mockResolvedValue({
        userId: 'old-user-1',
        email: 'old@example.com',
        isAdmin: false,
        roles: ['customer'],
      } as any);

      // User may have joined a team since token was issued — middleware falls back to lookup
      mockGetTeamsForUser.mockResolvedValue([
        { teamId: 'team-new', userId: 'old-user-1', role: 'member', status: 'active' },
      ]);

      await authenticateToken(req, res, next);

      expect(next).toHaveBeenCalled();
      const authReq = req as AuthenticatedRequest;
      // Should still resolve teamId via fallback lookup
      expect(authReq.user.teamId).toBe('team-new');
    });

    it('agency access should still take priority over team', () => {
      const req = createReq() as AuthenticatedRequest;
      req.user = {
        userId: 'agency-user',
        email: 'agency@example.com',
        isAdmin: false,
        roles: ['partner'],
        teamId: 'my-team',
      };
      req.agencyAccess = {
        agencyTeamId: 'agency-team',
        clientTeamId: 'client-team',
        originalUserId: 'agency-user',
      };

      const ownerId = getEffectiveOwnerId(req);
      // Agency access should still win
      expect(ownerId).toBe('client-team');
    });
  });

  // ─── JWT generation includes teamId ─────────────────────────────────

  describe('login JWT includes teamId', () => {
    it('should include teamId in JWT when user belongs to a team', async () => {
      const req: any = {
        body: { email: 'team@example.com', password: 'password123' },
      };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue({
        userId: 'team-user-1',
        email: 'team@example.com',
        isAdmin: false,
        roles: ['customer'],
        password: 'hashed-password',
      } as any);

      const bcrypt = require('bcryptjs');
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (mockJwt.sign as jest.Mock).mockReturnValue('mock-jwt-with-team');
      mockUserDb.updateUser.mockResolvedValue({} as any);

      mockGetTeamsForUser.mockResolvedValue([
        { teamId: 'team-abc', userId: 'team-user-1', role: 'member', status: 'active' },
      ]);

      await login(req, res);

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'team-user-1',
          teamId: 'team-abc',
        }),
        expect.any(String),
        expect.objectContaining({ expiresIn: '90d' })
      );
    });

    it('should NOT include teamId in JWT when user has no team', async () => {
      const req: any = {
        body: { email: 'solo@example.com', password: 'password123' },
      };
      const res = createRes();

      mockUserDb.getUserByEmail.mockResolvedValue({
        userId: 'solo-user-1',
        email: 'solo@example.com',
        isAdmin: false,
        roles: ['customer'],
        password: 'hashed-password',
      } as any);

      const bcrypt = require('bcryptjs');
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      (mockJwt.sign as jest.Mock).mockReturnValue('mock-jwt-no-team');
      mockUserDb.updateUser.mockResolvedValue({} as any);

      mockGetTeamsForUser.mockResolvedValue([]);

      await login(req, res);

      expect(mockJwt.sign).toHaveBeenCalledWith(
        expect.not.objectContaining({
          teamId: expect.anything(),
        }),
        expect.any(String),
        expect.objectContaining({ expiresIn: '90d' })
      );
    });
  });
});
