/**
 * Integration-style auth-gating tests for the seat-purchase endpoints
 * (ENG-2243..2246): POST/DELETE /api/org/:orgId/seats must be owner-only
 * (orgAuthz.isBillingRoot), must translate orgSeatBillingService's
 * "can't remove an occupied seat" refusal into a 400, and must compute
 * `effectiveCap` from the quantity the service actually returned rather than
 * re-reading the org record.
 *
 * Follows the same mocking pattern as orgCrossTenant.proof.test.ts: mock
 * `../middleware/auth` to inject whichever caller the test wants, and mock
 * `../services/db` with an in-memory org/user map. orgSeatBillingService
 * itself (and therefore Stripe) is mocked out here — its own correctness is
 * covered by orgSeatBillingService.test.ts — this file only asserts the
 * route layer wires auth and responses correctly.
 */
import request from 'supertest';
import express from 'express';
import orgRoutes from '../routes/org';
import { purchaseExtraSeat, removeExtraSeat } from '../services/orgSeatBillingService';

let actingUserId = 'u-owner';
let mockUsers: Record<string, any> = {};
let mockOrgs: Record<string, any> = {};

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: actingUserId, email: mockUsers[actingUserId]?.email ?? 'x@y.com', isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] || null)),
  },
  orgDb: {
    getOrgById: jest.fn((id: string) => Promise.resolve(mockOrgs[id] || null)),
    getOrgMemberCount: jest.fn(() => Promise.resolve(0)),
  },
  Organization: {},
}));

jest.mock('../services/orgSeatBillingService', () => ({
  purchaseExtraSeat: jest.fn(),
  removeExtraSeat: jest.fn(),
}));

jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(() => Promise.resolve('Starter')),
  getUserSubscriptionResolution: jest.fn(),
}));

const ORG = 'org-acme';
let app: express.Express;

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = {
    'u-owner': { userId: 'u-owner', email: 'owner@acme.com', orgId: ORG, orgRole: 'owner' },
    'u-member': { userId: 'u-member', email: 'member@acme.com', orgId: ORG, orgRole: 'member' },
  };
  mockOrgs = {
    [ORG]: { orgId: ORG, name: 'Acme', ownerUserId: 'u-owner' },
  };
  actingUserId = 'u-owner';
  app = express();
  app.use(express.json());
  app.use('/api/org', orgRoutes);
});

describe('POST /api/org/:orgId/seats', () => {
  it("rejects a non-owner (non-billing-root) with 403 and never calls purchaseExtraSeat", async () => {
    actingUserId = 'u-member';
    const res = await request(app).post(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(403);
    expect(purchaseExtraSeat).not.toHaveBeenCalled();
  });

  it('allows the billing owner and returns newTotalSeats + effectiveCap', async () => {
    (purchaseExtraSeat as jest.Mock).mockResolvedValue({ newTotalSeats: 3 });
    const res = await request(app).post(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(200);
    expect(purchaseExtraSeat).toHaveBeenCalledWith(ORG);
    // Starter base is 2 (orgSeatService.baseSeatsForTier) + 3 purchased = 5.
    expect(res.body).toEqual({ newTotalSeats: 3, effectiveCap: 5 });
  });

  it('returns 404 for an unknown org', async () => {
    const res = await request(app).post(`/api/org/does-not-exist/seats`);
    expect(res.status).toBe(404);
    expect(purchaseExtraSeat).not.toHaveBeenCalled();
  });

  it('propagates a thrown service error as 500', async () => {
    (purchaseExtraSeat as jest.Mock).mockRejectedValue(new Error('Stripe is down'));
    const res = await request(app).post(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Stripe is down');
  });
});

describe('DELETE /api/org/:orgId/seats', () => {
  it('rejects a non-owner (non-billing-root) with 403 and never calls removeExtraSeat', async () => {
    actingUserId = 'u-member';
    const res = await request(app).delete(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(403);
    expect(removeExtraSeat).not.toHaveBeenCalled();
  });

  it('allows the billing owner and returns newTotalSeats + effectiveCap', async () => {
    (removeExtraSeat as jest.Mock).mockResolvedValue({ newTotalSeats: 1 });
    const res = await request(app).delete(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(200);
    expect(removeExtraSeat).toHaveBeenCalledWith(ORG);
    expect(res.body).toEqual({ newTotalSeats: 1, effectiveCap: 3 });
  });

  it("maps the service's occupied-seat refusal to 400 with its message", async () => {
    (removeExtraSeat as jest.Mock).mockRejectedValue(
      new Error('Cannot remove extra seat for organization org-acme: it has 5 member(s) ...')
    );
    const res = await request(app).delete(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Cannot remove extra seat/);
  });

  it('returns 500 for an unrelated thrown error', async () => {
    (removeExtraSeat as jest.Mock).mockRejectedValue(new Error('Stripe is down'));
    const res = await request(app).delete(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(500);
  });
});
