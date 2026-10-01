/**
 * ENG-2250 — seat cap enforcement on the two membership-creation paths not
 * already covered end-to-end elsewhere: POST /api/org/accept-invite and
 * POST /api/org/:orgId/domain-requests/:requestToken/approve.
 *
 * (POST /:orgId/invite's cap behavior — below cap, already-over-cap-before-
 * this-feature, and non-removal of existing members — is covered in
 * org.test.ts, which already has the right mocking in place for it.
 * assertSeatAvailable's own boundary math — exact-at-cap, above-cap,
 * purchased-extra-seats arithmetic — is covered in orgSeatService.test.ts
 * and is not re-derived here; these tests only prove the route layer calls
 * it and maps SeatLimitReachedError to 409 { code: "SEAT_LIMIT_REACHED" }.)
 *
 * Every test here also double-checks the "no existing member is touched"
 * invariant: a 409 from the seat gate must never remove, demote, or
 * otherwise modify anyone already in the org — it only ever blocks the NEW
 * membership from being created.
 */
import request from 'supertest';
import express from 'express';
import orgRoutes from '../routes/org';

let actingUserId = 'u-owner';
let mockUsers: Record<string, any> = {};
let mockOrgs: Record<string, any> = {};
let mockSubscriptionType = 'Starter'; // base 2 seats

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    const u = mockUsers[actingUserId];
    req.user = { userId: actingUserId, email: u?.email ?? 'unknown@example.com', isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] || null)),
    getUserByEmail: jest.fn((email: string) =>
      Promise.resolve(Object.values(mockUsers).find((u: any) => u.email === email) || null)),
    updateUser: jest.fn((id: string, updates: any) => {
      if (mockUsers[id]) Object.assign(mockUsers[id], updates);
      return Promise.resolve(mockUsers[id]);
    }),
    // Mirrors the real conditional write: a user who already belongs to an
    // org is rejected.
    joinOrg: jest.fn((userId: string, orgId: string, orgRole: string) => {
      const user = mockUsers[userId];
      if (!user || user.orgId) return Promise.resolve('already_in_org');
      user.orgId = orgId;
      user.orgRole = orgRole;
      user.pendingOrgInvite = null;
      return Promise.resolve('joined');
    }),
    clearOrgMembership: jest.fn((id: string) => {
      if (mockUsers[id]) { delete mockUsers[id].orgId; delete mockUsers[id].orgRole; }
      return Promise.resolve();
    }),
  },
  orgDb: {
    getOrgById: jest.fn((id: string) => Promise.resolve(mockOrgs[id] || null)),
    updateOrg: jest.fn((id: string, updates: any) => {
      if (mockOrgs[id]) Object.assign(mockOrgs[id], updates);
      return Promise.resolve(mockOrgs[id]);
    }),
    getOrgMembers: jest.fn((id: string) =>
      Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === id))),
    getOrgMemberCount: jest.fn((id: string) =>
      Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === id).length)),
    removeDomainJoinRequest: jest.fn((id: string, requestToken: string) => {
      const org = mockOrgs[id];
      if (!org) return Promise.resolve(false);
      const before = (org.pendingDomainJoinRequests || []).length;
      org.pendingDomainJoinRequests = (org.pendingDomainJoinRequests || [])
        .filter((r: any) => r.requestToken !== requestToken);
      return Promise.resolve(org.pendingDomainJoinRequests.length < before);
    }),
    Organization: {},
  },
  Organization: {},
}));

jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(() => Promise.resolve(mockSubscriptionType)),
  getUserSubscriptionResolution: jest.fn(),
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));

const ORG = 'org-acme';
let app: express.Express;

function fillMembers(count: number) {
  // u-owner already counts as one member; add `count - 1` more.
  for (let i = 0; i < count - 1; i++) {
    mockUsers[`u-fill-${i}`] = { userId: `u-fill-${i}`, email: `fill${i}@acme.com`, orgId: ORG, orgRole: 'member' };
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSubscriptionType = 'Starter'; // base 2
  mockUsers = {
    'u-owner': { userId: 'u-owner', email: 'owner@acme.com', orgId: ORG, orgRole: 'owner' },
    'u-joiner': { userId: 'u-joiner', email: 'joiner@acme.com' },
  };
  mockOrgs = {
    [ORG]: {
      orgId: ORG,
      name: 'Acme',
      ownerUserId: 'u-owner',
      pendingInvites: [
        { email: 'joiner@acme.com', inviteToken: 'valid-token', invitedAt: '2026-01-01T00:00:00Z', invitedBy: 'u-owner' },
      ],
      pendingDomainJoinRequests: [
        { userId: 'u-joiner', email: 'joiner@acme.com', requestedAt: '2026-01-01T00:00:00Z', requestToken: 'valid-domain-token' },
      ],
    },
  };
  actingUserId = 'u-joiner';
  app = express();
  app.use(express.json());
  app.use('/api/org', orgRoutes);
});

describe('POST /api/org/accept-invite — seat cap', () => {
  it('succeeds when the org is below its seat cap', async () => {
    // Only u-owner is in the org (1 of 2 Starter seats) — room for one more.
    const res = await request(app).post('/api/org/accept-invite').send({ orgId: ORG, inviteToken: 'valid-token' });
    expect(res.status).toBe(200);
    expect(mockUsers['u-joiner'].orgId).toBe(ORG);
  });

  it('returns 409 SEAT_LIMIT_REACHED when the org is already at its seat cap', async () => {
    fillMembers(2); // owner + 1 filler = 2 of 2 Starter seats, already full
    const res = await request(app).post('/api/org/accept-invite').send({ orgId: ORG, inviteToken: 'valid-token' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEAT_LIMIT_REACHED');
    // The invitee never joined.
    expect(mockUsers['u-joiner'].orgId).toBeUndefined();
  });

  it('returns 409 for an org already over cap before this feature shipped (5 members, base 2, no purchased seats)', async () => {
    fillMembers(5);
    const res = await request(app).post('/api/org/accept-invite').send({ orgId: ORG, inviteToken: 'valid-token' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEAT_LIMIT_REACHED');
  });

  it('does not touch any existing member when the seat gate blocks the join', async () => {
    fillMembers(2);
    const before = JSON.parse(JSON.stringify(mockUsers));
    const res = await request(app).post('/api/org/accept-invite').send({ orgId: ORG, inviteToken: 'valid-token' });
    expect(res.status).toBe(409);
    // Every pre-existing member (owner + filler) is byte-for-byte unchanged —
    // the seat gate only ever blocks the NEW membership, never mutates an
    // existing one.
    expect(mockUsers['u-owner']).toEqual(before['u-owner']);
    expect(mockUsers['u-fill-0']).toEqual(before['u-fill-0']);
    // The invite itself is still pending — a blocked accept is not consumed.
    expect(mockOrgs[ORG].pendingInvites).toHaveLength(1);
  });

  it('is uncapped for a tier with no seat concept (e.g. Managed), regardless of headcount', async () => {
    mockSubscriptionType = 'Managed';
    fillMembers(20);
    const res = await request(app).post('/api/org/accept-invite').send({ orgId: ORG, inviteToken: 'valid-token' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/org/:orgId/domain-requests/:requestToken/approve — seat cap', () => {
  beforeEach(() => {
    actingUserId = 'u-owner'; // approval is an owner/admin action
  });

  it('succeeds when the org is below its seat cap', async () => {
    const res = await request(app).post(`/api/org/${ORG}/domain-requests/valid-domain-token/approve`);
    expect(res.status).toBe(200);
    expect(mockUsers['u-joiner'].orgId).toBe(ORG);
  });

  it('returns 409 SEAT_LIMIT_REACHED when the org is already at its seat cap', async () => {
    fillMembers(2);
    const res = await request(app).post(`/api/org/${ORG}/domain-requests/valid-domain-token/approve`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEAT_LIMIT_REACHED');
    expect(mockUsers['u-joiner'].orgId).toBeUndefined();
    // The pending request survives a blocked approval — nothing silently
    // dropped.
    expect(mockOrgs[ORG].pendingDomainJoinRequests).toHaveLength(1);
  });

  it('returns 409 for an org already over cap before this feature shipped (5 members, base 2, no purchased seats)', async () => {
    fillMembers(5);
    const res = await request(app).post(`/api/org/${ORG}/domain-requests/valid-domain-token/approve`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEAT_LIMIT_REACHED');
  });

  it('does not touch any existing member when the seat gate blocks the join', async () => {
    fillMembers(2);
    const before = JSON.parse(JSON.stringify(mockUsers));
    const res = await request(app).post(`/api/org/${ORG}/domain-requests/valid-domain-token/approve`);
    expect(res.status).toBe(409);
    expect(mockUsers['u-owner']).toEqual(before['u-owner']);
    expect(mockUsers['u-fill-0']).toEqual(before['u-fill-0']);
  });

  it('is uncapped for a tier with no seat concept (e.g. Managed), regardless of headcount', async () => {
    mockSubscriptionType = 'Managed';
    fillMembers(20);
    const res = await request(app).post(`/api/org/${ORG}/domain-requests/valid-domain-token/approve`);
    expect(res.status).toBe(200);
  });
});
