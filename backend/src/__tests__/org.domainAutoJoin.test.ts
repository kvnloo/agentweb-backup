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
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: mockUser.userId, email: mockUser.email, isAdmin: false };
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

    it('fails with an invalid/unknown token', async () => {
      const res = await request(app).post('/api/org/org-1/domain-requests/wrong-token/approve');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid|not found/i);
    });

    it('fails loudly (no silent drop) when the org is already full', async () => {
      mockUsers['user-1'].orgId = 'org-1';
      // Fill the org to maxMembers with other members.
      mockOrgs['org-1'].maxMembers = 1;

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
