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

  it('maps an unexpected service error to a generic 500 without leaking its message', async () => {
    // A raw Stripe SDK error (or any other unexpected failure) must never
    // reach the client verbatim — it can carry internal identifiers or
    // implementation detail that has no business in an API response. Only
    // the specific, expected, client-correctable error shapes (asserted in
    // the other tests here) get their message echoed back.
    (purchaseExtraSeat as jest.Mock).mockRejectedValue(
      new Error('Stripe API error: no such price prod_internal_abc123')
    );
    const res = await request(app).post(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toMatch(/prod_internal_abc123/);
  });

  it("maps the service's 'no Stripe subscription' refusal to 400 with its message", async () => {
    (purchaseExtraSeat as jest.Mock).mockRejectedValue(
      new Error(`Organization ${ORG}'s owner (u-owner) has no Stripe subscription; cannot manage extra seats`)
    );
    const res = await request(app).post(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no Stripe subscription/);
  });

  it("maps the service's 'no seatPricing configured' refusal to 400 with its message", async () => {
    (purchaseExtraSeat as jest.Mock).mockRejectedValue(
      new Error(`Subscription tier 'Managed' has no seatPricing configured; cannot bill extra seats for organization ${ORG}`)
    );
    const res = await request(app).post(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no seatPricing configured/);
  });

  it("maps a service 'not found' error to a generic 404 without leaking internal ids", async () => {
    (purchaseExtraSeat as jest.Mock).mockRejectedValue(
      new Error(`Owner u-owner of organization ${ORG} not found`)
    );
    const res = await request(app).post(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Organization not found');
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

  it('maps an unrelated unexpected error to a generic 500 without leaking its message', async () => {
    (removeExtraSeat as jest.Mock).mockRejectedValue(
      new Error('Stripe API error: no such price prod_internal_abc123')
    );
    const res = await request(app).delete(`/api/org/${ORG}/seats`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toMatch(/prod_internal_abc123/);
  });
});
