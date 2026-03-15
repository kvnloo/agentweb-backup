/**
 * Tests for agency client switching — scoped JWT generation and auth middleware handling.
 *
 * Verifies:
 * - POST /api/agencies/:agencyTeamId/clients/:clientTeamId/switch generates a scoped JWT
 * - Auth middleware correctly extracts agencyAccess from scoped tokens
 * - getEffectiveOwnerId() returns clientTeamId when in agency-switch mode
 * - Non-linked agencies cannot switch into client workspaces
 * - Switch back uses original token (no endpoint needed)
 */

const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  delete: jest.fn(),
  update: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => mockDocumentClientMethods),
  },
  S3: jest.fn(() => ({})),
}));

import jwt from 'jsonwebtoken';
import express from 'express';
import request from 'supertest';
import agencyRoutes from '../routes/agencies';
import { authenticateToken, getUserFromToken, getEffectiveOwnerId } from '../middleware/auth';
import type { AuthenticatedRequest } from '../middleware/auth';

// Set up JWT secret for tests
process.env.JWT_SECRET = 'test-jwt-secret';

// Mock userDb to return a user for token verification
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((userId: string) => {
      if (userId === 'agency-user-1') {
        return Promise.resolve({
          userId: 'agency-user-1',
          email: 'agency@test.com',
          isAdmin: false,
          roles: ['customer'],
        });
      }
      if (userId === 'client-user-1') {
        return Promise.resolve({
          userId: 'client-user-1',
          email: 'client@test.com',
          isAdmin: false,
          roles: ['customer'],
        });
      }
      return Promise.resolve(null);
    }),
  },
}));

describe('Agency Client Switching', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: DynamoDB calls return empty
    Object.keys(mockDocumentClientMethods).forEach((method) => {
      (mockDocumentClientMethods as any)[method].mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });
    });

    app = express();
    app.use(express.json());
    app.use('/api/agencies', authenticateToken, agencyRoutes);
  });

  // Helper to generate a valid JWT for tests
  function generateToken(payload: Record<string, any>): string {
    return jwt.sign(payload, process.env.JWT_SECRET || 'test-jwt-secret', {
      expiresIn: '1h',
    });
  }

  // ─── Switch Endpoint ───────────────────────────────────────────

  describe('POST /api/agencies/:agencyTeamId/clients/:clientTeamId/switch', () => {
    // FAIL test 1: should reject when agency is not linked to client
    it('should return 403 when agency is not linked to client', async () => {
      // Mock: no link found
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ Item: undefined }),
      });

      const token = generateToken({
        userId: 'agency-user-1',
        email: 'agency@test.com',
        roles: ['customer'],
        isAdmin: false,
      });

      const res = await request(app)
        .post('/api/agencies/agency-team-1/clients/client-team-1/switch')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/not authorized|not linked/i);
    });

    // FAIL test 2: should reject when link is revoked
    it('should return 403 when agency link is revoked', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            agencyTeamId: 'agency-team-1',
            clientTeamId: 'client-team-1',
            status: 'revoked',
          },
        }),
      });

      const token = generateToken({
        userId: 'agency-user-1',
        email: 'agency@test.com',
        roles: ['customer'],
        isAdmin: false,
      });

      const res = await request(app)
        .post('/api/agencies/agency-team-1/clients/client-team-1/switch')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    // FAIL test 3: should reject unauthenticated requests
    it('should return 401 when no token provided', async () => {
      const res = await request(app)
        .post('/api/agencies/agency-team-1/clients/client-team-1/switch');

      expect(res.status).toBe(401);
    });

    // SUCCESS test: should generate scoped JWT with agency access fields
    it('should generate a scoped JWT when agency is linked to client', async () => {
      // Mock: active link found
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            agencyTeamId: 'agency-team-1',
            clientTeamId: 'client-team-1',
            status: 'active',
            linkedAt: '2026-01-01T00:00:00.000Z',
            linkedBy: 'agency-user-1',
          },
        }),
      });

      const token = generateToken({
        userId: 'agency-user-1',
        email: 'agency@test.com',
        roles: ['customer'],
        isAdmin: false,
      });

      const res = await request(app)
        .post('/api/agencies/agency-team-1/clients/client-team-1/switch')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.scopedToken).toBeDefined();

      // Verify the scoped token contents
      const decoded = jwt.verify(
        res.body.data.scopedToken,
        process.env.JWT_SECRET || 'test-jwt-secret'
      ) as any;

      expect(decoded.userId).toBe('agency-user-1');
      expect(decoded.agencyAccess).toBeDefined();
      expect(decoded.agencyAccess.agencyTeamId).toBe('agency-team-1');
      expect(decoded.agencyAccess.clientTeamId).toBe('client-team-1');
      expect(decoded.agencyAccess.originalUserId).toBe('agency-user-1');
    });
  });

  // ─── Auth Middleware — Agency Scoped Tokens ────────────────────

  describe('Auth middleware with agency-scoped tokens', () => {
    // FAIL test 1: should reject scoped token with invalid agency link
    it('should reject scoped token when agency link no longer active', async () => {
      // Mock: link has been revoked since token was issued
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            agencyTeamId: 'agency-team-1',
            clientTeamId: 'client-team-1',
            status: 'revoked',
          },
        }),
      });

      const scopedToken = generateToken({
        userId: 'agency-user-1',
        email: 'agency@test.com',
        roles: ['customer'],
        isAdmin: false,
        agencyAccess: {
          agencyTeamId: 'agency-team-1',
          clientTeamId: 'client-team-1',
          originalUserId: 'agency-user-1',
        },
      });

      const mockReq = {
        headers: { authorization: `Bearer ${scopedToken}` },
      } as any;

      const result = await getUserFromToken(mockReq);
      // Should return null user when link is no longer active
      expect(result.user).toBeNull();
    });

    // SUCCESS test: should set agencyAccess on request when valid scoped token
    it('should set agencyAccess on request for valid scoped token', async () => {
      // Mock: active link
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            agencyTeamId: 'agency-team-1',
            clientTeamId: 'client-team-1',
            status: 'active',
          },
        }),
      });

      const scopedToken = generateToken({
        userId: 'agency-user-1',
        email: 'agency@test.com',
        roles: ['customer'],
        isAdmin: false,
        agencyAccess: {
          agencyTeamId: 'agency-team-1',
          clientTeamId: 'client-team-1',
          originalUserId: 'agency-user-1',
        },
      });

      const mockReq = {
        headers: { authorization: `Bearer ${scopedToken}` },
      } as any;

      const result = await getUserFromToken(mockReq);

      expect(result.user).toBeDefined();
      expect(result.user!.userId).toBe('agency-user-1');
      expect(result.agencyAccess).toBeDefined();
      expect(result.agencyAccess!.agencyTeamId).toBe('agency-team-1');
      expect(result.agencyAccess!.clientTeamId).toBe('client-team-1');
    });
  });

  // ─── getEffectiveOwnerId ──────────────────────────────────────

  describe('getEffectiveOwnerId', () => {
    // FAIL test 1: should return userId when not in agency mode
    it('should return the user userId when no agencyAccess present', () => {
      const mockReq = {
        user: { userId: 'user-1', email: 'user@test.com', isAdmin: false },
      } as AuthenticatedRequest;

      expect(getEffectiveOwnerId(mockReq)).toBe('user-1');
    });

    // FAIL test 2: should return undefined when no user on request
    it('should return undefined when no user on request', () => {
      const mockReq = {} as AuthenticatedRequest;
      expect(getEffectiveOwnerId(mockReq)).toBeUndefined();
    });

    // SUCCESS test: should return clientTeamId when in agency-switch mode
    it('should return clientTeamId when in agency-switch mode', () => {
      const mockReq = {
        user: { userId: 'agency-user-1', email: 'agency@test.com', isAdmin: false },
        agencyAccess: {
          agencyTeamId: 'agency-team-1',
          clientTeamId: 'client-team-1',
          originalUserId: 'agency-user-1',
        },
      } as AuthenticatedRequest;

      expect(getEffectiveOwnerId(mockReq)).toBe('client-team-1');
    });
  });
});
