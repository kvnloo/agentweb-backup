/**
 * ENG-512: Domain-based org auto-join (owner-approved).
 *
 * Covers:
 *  - PUT /api/org/:orgId toggling autoJoinEnabled (domain derived server-side
 *    from the owner's own email, never client-supplied)
 *  - POST /api/org/:orgId/domain-requests/:requestToken/approve
 *  - POST /api/org/:orgId/domain-requests/:requestToken/reject
 */

import request from 'supertest';
import express from 'express';
import orgRoutes from '../routes/org';

let mockUser: any = {
  userId: 'user-1',
  email: 'owner@example.com',
  displayName: 'Test Owner',
  orgId: undefined,
  orgRole: undefined,
};

let mockUsers: Record<string, any> = {};
let mockOrgs: Record<string, any> = {};

jest.mock('../middleware/auth', () => ({
  // Supports an explicit x-test-user-id header so concurrency tests can pin
  // each in-flight request to a fixed identity — the shared `mockUser`
  // variable is otherwise a race hazard when two requests are genuinely
  // in-flight at once against the same app (both mutating/reading it).
  authenticateToken: (req: any, _res: any, next: any) => {
    const headerUserId = req.headers['x-test-user-id'];
    const user = headerUserId ? mockUsers[headerUserId as string] : mockUser;
    req.user = { userId: user.userId, email: user.email, isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((userId: string) => Promise.resolve(mockUsers[userId] || null)),
    getUserByEmail: jest.fn((email: string) =>
      Promise.resolve(Object.values(mockUsers).find((u: any) => u.email === email) || null)
    ),
    updateUser: jest.fn((userId: string, updates: any) => {
      if (mockUsers[userId]) Object.assign(mockUsers[userId], updates);
      return Promise.resolve(mockUsers[userId]);
    }),
    // Mirrors the real atomic transaction: check-and-set with no await in
    // between, so two "concurrent" calls in a test (via Promise.all) can't
    // both observe orgId as unset, or both squeeze under maxMembers —
    // matching what the real DynamoDB transaction guarantees in production.
    joinOrgWithCapacityCheck: jest.fn((userId: string, orgId: string, orgRole: string, maxMembers: number) => {
      const user = mockUsers[userId];
      if (!user) return Promise.resolve('already_in_org');
      if (user.orgId) return Promise.resolve('already_in_org');
      const org = mockOrgs[orgId];
      // Fail closed: a missing memberCount is never seeded from a live count
      // here — only the reviewed backfill migration is allowed to initialize
      // it. A live path just requires it to already exist and be under cap.
      if (org?.memberCount === undefined) return Promise.resolve('not_migrated');
      if (org.memberCount >= maxMembers) return Promise.resolve('org_full');
      user.orgId = orgId;
      user.orgRole = orgRole;
      org.memberCount += 1;
      return Promise.resolve('joined');
    }),
    clearOrgMembership: jest.fn((userId: string) => {
      const user = mockUsers[userId];
      if (user) {
        const orgId = user.orgId;
        delete user.orgId;
        delete user.orgRole;
        if (orgId && mockOrgs[orgId] && mockOrgs[orgId].memberCount !== undefined) {
          mockOrgs[orgId].memberCount = Math.max(0, mockOrgs[orgId].memberCount - 1);
        }
      }
      return Promise.resolve();
    }),
  },
  orgDb: {
    createOrg: jest.fn((org: any) => {
      mockOrgs[org.orgId] = org;
      return Promise.resolve(org);
    }),
    getOrgById: jest.fn((orgId: string) => Promise.resolve(mockOrgs[orgId] || null)),
    updateOrg: jest.fn((orgId: string, updates: any) => {
      if (mockOrgs[orgId]) Object.assign(mockOrgs[orgId], updates);
      return Promise.resolve(mockOrgs[orgId]);
    }),
    getOrgMemberCount: jest.fn((orgId: string) => {
      return Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === orgId).length);
    }),
    removeDomainJoinRequest: jest.fn((orgId: string, requestToken: string) => {
      const org = mockOrgs[orgId];
      if (!org) return Promise.resolve(false);
      const pending = org.pendingDomainJoinRequests || [];
      const updated = pending.filter((r: any) => r.requestToken !== requestToken);
      if (updated.length === pending.length) return Promise.resolve(false);
      org.pendingDomainJoinRequests = updated;
      return Promise.resolve(true);
    }),
    ORG_MAX_MEMBERS: 5,
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

let app: express.Application;

describe('Domain-based org auto-join', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgs = {};
    mockUsers = {
      'user-1': {
        userId: 'user-1',
        email: 'owner@example.com',
        displayName: 'Test Owner',
        orgId: undefined,
        orgRole: undefined,
      },
      'user-2': {
        userId: 'user-2',
        email: 'member@example.com',
        displayName: 'Test Member',
        orgId: undefined,
        orgRole: undefined,
      },
      'user-3': {
        userId: 'user-3',
        email: 'other@example.com',
        displayName: 'Other Requester',
        orgId: undefined,
        orgRole: undefined,
      },
    };
    mockUser = mockUsers['user-1'];

    app = express();
    app.use(express.json());
    app.use('/api/org', orgRoutes);
  });

  describe('PUT /api/org/:orgId - autoJoinEnabled toggle', () => {
    beforeEach(() => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
        maxMembers: 5,
        pendingInvites: [],
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
    });

    it('derives autoJoinDomain from the owner\'s own email when enabling, ignoring any client-supplied domain', async () => {
      const res = await request(app)
        .put('/api/org/org-1')
        .send({ autoJoinEnabled: true, autoJoinDomain: 'attacker-controlled.com' });

      expect(res.status).toBe(200);
      expect(res.body.data.autoJoinEnabled).toBe(true);
      expect(res.body.data.autoJoinDomain).toBe('example.com');
    });

    it('rejects enabling when the owner\'s own email is a personal domain (ENG-512 review)', async () => {
      mockUsers['user-1'].email = 'owner@gmail.com';
      const res = await request(app)
        .put('/api/org/org-1')
        .send({ autoJoinEnabled: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/personal email domain/i);
      expect(mockOrgs['org-1'].autoJoinEnabled).toBeUndefined();
      expect(mockOrgs['org-1'].autoJoinDomain).toBeUndefined();
    });

    it('clears autoJoinDomain when disabling', async () => {
      mockOrgs['org-1'].autoJoinEnabled = true;
      mockOrgs['org-1'].autoJoinDomain = 'example.com';

      const res = await request(app).put('/api/org/org-1').send({ autoJoinEnabled: false });

      expect(res.status).toBe(200);
      expect(res.body.data.autoJoinEnabled).toBe(false);
      expect(res.body.data.autoJoinDomain).toBeNull();
    });

    it('fails if not the owner', async () => {
      mockUser = mockUsers['user-2'];
      const res = await request(app).put('/api/org/org-1').send({ autoJoinEnabled: true });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/org/:orgId/domain-requests/:requestToken/approve', () => {
    beforeEach(() => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
        maxMembers: 5,
        memberCount: 1,
        autoJoinEnabled: true,
        autoJoinDomain: 'example.com',
        pendingDomainJoinRequests: [
          {
            userId: 'user-2',
            email: 'member@example.com',
            requestedAt: '2026-01-01T00:00:00Z',
            requestToken: 'valid-token',
          },
        ],
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
    });

    // === FAIL cases ===

    it('fails if not the owner', async () => {
      mockUser = mockUsers['user-2'];
      const res = await request(app).post('/api/org/org-1/domain-requests/valid-token/approve');
      expect(res.status).toBe(403);
    });

    it('fails closed (not silently seeded) when memberCount has not been backfilled yet', async () => {
      delete mockOrgs['org-1'].memberCount;
      const res = await request(app).post('/api/org/org-1/domain-requests/valid-token/approve');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/not yet ready/i);
      expect(mockOrgs['org-1'].pendingDomainJoinRequests).toHaveLength(1);
      expect(mockUsers['user-2'].orgId).toBeUndefined();
    });

    it('fails with an invalid/unknown token', async () => {
      const res = await request(app).post('/api/org/org-1/domain-requests/wrong-token/approve');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid|not found/i);
    });

    it('fails loudly (no silent drop) when the org is already full', async () => {
      mockUsers['user-1'].orgId = 'org-1';
      // Fill the org to maxMembers (owner already counts as 1).
      mockOrgs['org-1'].maxMembers = 1;
      mockOrgs['org-1'].memberCount = 1;

      const res = await request(app).post('/api/org/org-1/domain-requests/valid-token/approve');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/full|maximum/i);
      // Request must not be silently dropped/removed on failure.
      expect(mockOrgs['org-1'].pendingDomainJoinRequests).toHaveLength(1);
      expect(mockUsers['user-2'].orgId).toBeUndefined();
    });

    it('fails if the requesting user already joined a different org in the meantime (multi-org race)', async () => {
      mockUsers['user-2'].orgId = 'some-other-org';
      const res = await request(app).post('/api/org/org-1/domain-requests/valid-token/approve');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already in an organization/i);
      expect(mockUsers['user-2'].orgId).toBe('some-other-org');
    });

    it('under true concurrency, exactly one of two simultaneous approvals (different orgs, same user) wins — no phantom approval', async () => {
      // Regression test for a live-reproduced bug: two orgs approving the
      // same pending user at the same instant used to both return success,
      // because the orgId-check and the orgId-write were separate DB round
      // trips with no atomic guard between them. One org's "approved" was a
      // phantom — the request got cleared and the owner saw success, but the
      // membership write was silently overwritten by the other org's write.
      mockOrgs['org-2'] = {
        orgId: 'org-2',
        name: 'Second Org',
        ownerUserId: 'user-3',
        maxMembers: 5,
        memberCount: 1,
        autoJoinEnabled: true,
        autoJoinDomain: 'example.com',
        pendingDomainJoinRequests: [
          {
            userId: 'user-2',
            email: 'member@example.com',
            requestedAt: '2026-01-01T00:00:00Z',
            requestToken: 'valid-token-org2',
          },
        ],
      };

      // x-test-user-id pins each request's identity explicitly, so the two
      // in-flight requests can't race on the shared `mockUser` variable —
      // isolating the race to exactly the thing under test (the DB layer).
      const requestAsOrg1Owner = request(app)
        .post('/api/org/org-1/domain-requests/valid-token/approve')
        .set('x-test-user-id', 'user-1');
      const requestAsOrg2Owner = request(app)
        .post('/api/org/org-2/domain-requests/valid-token-org2/approve')
        .set('x-test-user-id', 'user-3');

      const [resA, resB] = await Promise.all([requestAsOrg1Owner, requestAsOrg2Owner]);
      const results = [resA, resB];
      const successes = results.filter((r) => r.status === 200);
      const failures = results.filter((r) => r.status === 400);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].body.error).toMatch(/already in an organization/i);

      // The user must end up in exactly one org, matching whichever call
      // actually won — never both, and never neither.
      expect(mockUsers['user-2'].orgId).toBe(successes[0] === resA ? 'org-1' : 'org-2');

      // Whichever org lost the race must NOT have silently dropped the
      // request (it should still be there, or explicitly handled) — since
      // this fix removes the request only after a successful join, the
      // loser's request should survive for a retry/manual follow-up.
      const loserOrgId = successes[0] === resA ? 'org-2' : 'org-1';
      expect(mockOrgs[loserOrgId].pendingDomainJoinRequests.length).toBeGreaterThan(0);
    });

    it('under true concurrency, exactly one of two different users approved into the same org (one slot left) succeeds — capacity never overshoots (Greptile review)', async () => {
      // Regression test for the capacity-side race: two DIFFERENT users
      // approved into the SAME org at the same instant used to both read
      // the same member count before either write landed, letting both
      // succeed and the org exceed maxMembers. joinOrgWithCapacityCheck ties
      // the memberCount increment and the membership write into one atomic
      // transaction, so only one can win when a single slot remains.
      mockOrgs['org-1'].maxMembers = 3;
      mockOrgs['org-1'].memberCount = 2; // one slot left
      mockUsers['user-1'].orgId = 'org-1'; // owner
      mockUsers['user-3'] = { userId: 'user-3', email: 'other@example.com', displayName: 'Other', orgId: undefined, orgRole: undefined };
      mockOrgs['org-1'].pendingDomainJoinRequests = [
        { userId: 'user-2', email: 'member@example.com', requestedAt: '2026-01-01T00:00:00Z', requestToken: 'valid-token' },
        { userId: 'user-3', email: 'other@example.com', requestedAt: '2026-01-01T00:00:00Z', requestToken: 'valid-token-user3' },
      ];

      const approveUser2 = request(app)
        .post('/api/org/org-1/domain-requests/valid-token/approve')
        .set('x-test-user-id', 'user-1');
      const approveUser3 = request(app)
        .post('/api/org/org-1/domain-requests/valid-token-user3/approve')
        .set('x-test-user-id', 'user-1');

      const [resA, resB] = await Promise.all([approveUser2, approveUser3]);
      const results = [resA, resB];
      const successes = results.filter((r) => r.status === 200);
      const failures = results.filter((r) => r.status === 400);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0].body.error).toMatch(/full|maximum/i);

      // Capacity must never be exceeded — exactly one of the two joined.
      expect(mockOrgs['org-1'].memberCount).toBe(3);
      const joinedCount = [mockUsers['user-2'].orgId, mockUsers['user-3'].orgId].filter((id) => id === 'org-1').length;
      expect(joinedCount).toBe(1);
    });

    // === SUCCESS case ===

    it('joins the requesting user as a member and removes the request', async () => {
      const res = await request(app).post('/api/org/org-1/domain-requests/valid-token/approve');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockUsers['user-2'].orgId).toBe('org-1');
      expect(mockUsers['user-2'].orgRole).toBe('member');
      expect(mockOrgs['org-1'].pendingDomainJoinRequests).toHaveLength(0);
    });
  });

  describe('POST /api/org/:orgId/domain-requests/:requestToken/reject', () => {
    beforeEach(() => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
        maxMembers: 5,
        autoJoinEnabled: true,
        autoJoinDomain: 'example.com',
        pendingDomainJoinRequests: [
          {
            userId: 'user-2',
            email: 'member@example.com',
            requestedAt: '2026-01-01T00:00:00Z',
            requestToken: 'valid-token',
          },
        ],
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
    });

    it('fails if not the owner', async () => {
      mockUser = mockUsers['user-2'];
      const res = await request(app).post('/api/org/org-1/domain-requests/valid-token/reject');
      expect(res.status).toBe(403);
    });

    it('fails with an invalid/unknown token', async () => {
      const res = await request(app).post('/api/org/org-1/domain-requests/wrong-token/reject');
      expect(res.status).toBe(404);
    });

    it('removes the request without joining the user to the org', async () => {
      const res = await request(app).post('/api/org/org-1/domain-requests/valid-token/reject');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockOrgs['org-1'].pendingDomainJoinRequests).toHaveLength(0);
      expect(mockUsers['user-2'].orgId).toBeUndefined();
    });
  });
});
