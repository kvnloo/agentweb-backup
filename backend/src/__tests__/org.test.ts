import request from 'supertest';
import express from 'express';

// Mock user state
let mockUser: any = {
  userId: 'user-1',
  email: 'owner@example.com',
  displayName: 'Test Owner',
  orgId: undefined,
  orgRole: undefined,
};

let mockUsers: Record<string, any> = {};
let mockOrgs: Record<string, any> = {};

// Mock auth middleware
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: mockUser.userId, email: mockUser.email, isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

// Mock db
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((userId: string) => {
      return Promise.resolve(mockUsers[userId] || null);
    }),
    getUserByEmail: jest.fn((email: string) => {
      return Promise.resolve(Object.values(mockUsers).find((u: any) => u.email === email) || null);
    }),
    updateUser: jest.fn((userId: string, updates: any) => {
      if (mockUsers[userId]) {
        Object.assign(mockUsers[userId], updates);
      }
      return Promise.resolve(mockUsers[userId]);
    }),
    // Mirrors the real conditional write: a user who already belongs to an org
    // is rejected, checked and set with no await in between so it cannot be
    // raced within a single test's synchronous mock body.
    joinOrg: jest.fn((userId: string, orgId: string, orgRole: string) => {
      const user = mockUsers[userId];
      if (!user) return Promise.resolve('already_in_org');
      if (user.orgId) return Promise.resolve('already_in_org');
      user.orgId = orgId;
      user.orgRole = orgRole;
      user.pendingOrgInvite = null;
      return Promise.resolve('joined');
    }),
    clearOrgMembership: jest.fn((userId: string) => {
      const user = mockUsers[userId];
      if (user) {
        const orgId = user.orgId;
        delete user.orgId;
        delete user.orgRole;
      }
      return Promise.resolve();
    }),
  },
  orgDb: {
    // ENG-954: owner-loss serialization. Default-true = no contention,
    // which is every test here except the explicit race case.
    claimOwnerChange: jest.fn(() => Promise.resolve(true)),
    createOrg: jest.fn((org: any) => {
      mockOrgs[org.orgId] = org;
      return Promise.resolve(org);
    }),
    getOrgById: jest.fn((orgId: string) => {
      return Promise.resolve(mockOrgs[orgId] || null);
    }),
    updateOrg: jest.fn((orgId: string, updates: any) => {
      if (mockOrgs[orgId]) {
        Object.assign(mockOrgs[orgId], updates);
      }
      return Promise.resolve(mockOrgs[orgId]);
    }),
    deleteOrg: jest.fn((orgId: string) => {
      delete mockOrgs[orgId];
      return Promise.resolve();
    }),
    getOrgMembers: jest.fn((orgId: string) => {
      return Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === orgId));
    }),
    getOrgMemberCount: jest.fn((orgId: string) => {
      return Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === orgId).length);
    }),
    ORG_MAX_MEMBERS: 5,
  },
}));

// Mock email service.
//
// ENG-1112: this is the seam that keeps the invite route off the wire. `routes/org.ts`
// reaches email through `await import("../services/emailService")`, whose real
// implementation calls `resendService.sendEmail` → the Resend SDK → an HTTPS POST to
// api.resend.com. Without this mock the invite tests below would send real mail on any
// host where `dev/AgentWeb/Resend` resolves, and `emailService.sendEmail` swallows send
// failures by design (ENG-164) — so the suite would stay green either way. The transport
// guard installed in `beforeEach` is the belt to this mock's braces: it asserts the
// absence of traffic rather than trusting that the mock registered.
const mockSendEmail = jest.fn().mockResolvedValue({ id: 'test-email' });
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: mockSendEmail } }));
const orgRoutes = require('../routes/org').default;

// ---------------------------------------------------------------------------
// Outbound-transport guard (ENG-1112, same shape as seo.orgAnalytics.test.ts)
//
// These routes should make zero outbound requests, so the guard throws on *any* host
// instead of returning a plausible `ok`. Returning ok would let a regression — a new
// un-mocked send, or this file's emailService mock failing to register — pass quietly,
// which is precisely how a live Resend POST hid here in the first place.
// ---------------------------------------------------------------------------
const attemptedFetches: string[] = [];
const realFetch = global.fetch;

function installNoNetworkGuard() {
  attemptedFetches.length = 0;
  global.fetch = jest.fn((input: any) => {
    const url = typeof input === 'string' ? input : input?.url;
    attemptedFetches.push(String(url));
    throw new Error(
      `org.test.ts attempted a live network call to ${url}. These routes must not reach ` +
        `third-party APIs — a request to api.resend.com sends real mail.`
    );
  }) as unknown as typeof fetch;
}

let app: express.Application;

describe('Organization routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-installed per test: `clearMocks` wipes call history, and a fresh guard keeps
    // each test's `attemptedFetches` assertions independent of run order.
    installNoNetworkGuard();
    mockSendEmail.mockResolvedValue(undefined);
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
    };
    mockUser = mockUsers['user-1'];

    app = express();
    app.use(express.json());
    app.use('/api/org', orgRoutes);
  });

  afterEach(() => {
    // Every test in this file, not just the invite ones: no route here has any business
    // touching the network.
    expect(attemptedFetches).toEqual([]);
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  // === FAIL cases ===

  describe('POST /api/org - create org', () => {
    it('should fail without a name', async () => {
      const res = await request(app).post('/api/org').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name.*required/i);
    });

    it('should fail if user is already in an org', async () => {
      mockUsers['user-1'].orgId = 'existing-org';
      const res = await request(app).post('/api/org').send({ name: 'My Org' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already in an organization/i);
    });

    it('should fail with empty name', async () => {
      const res = await request(app).post('/api/org').send({ name: '  ' });
      expect(res.status).toBe(400);
    });

    // === SUCCESS case ===
    it('should create an org and set user as owner', async () => {
      const res = await request(app).post('/api/org').send({ name: 'My Org' });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('My Org');
      expect(res.body.data.ownerUserId).toBe('user-1');
      // Owner is the first member — seeded directly, no transaction needed.

      // User should be updated with orgId and owner role
      expect(mockUsers['user-1'].orgId).toBe(res.body.data.orgId);
      expect(mockUsers['user-1'].orgRole).toBe('owner');
    });

    it('does not seed autoJoinEnabled/autoJoinDomain at creation — opt-in only, owner enables it explicitly later (ENG-512)', async () => {
      const res = await request(app).post('/api/org').send({ name: 'My Org' });
      expect(res.status).toBe(201);
      expect(res.body.data.autoJoinEnabled).toBeUndefined();
      expect(res.body.data.autoJoinDomain).toBeUndefined();
    });

    it('should seed shareSettings with everything shared by default', async () => {
      // A new org is a team that has just arrived. Seeding these to private meant they
      // saw an empty product until someone found the org settings page.
      const res = await request(app).post('/api/org').send({ name: 'My Org' });
      expect(res.status).toBe(201);
      const settings = res.body.data.shareSettings;
      expect(settings).toBeDefined();
      expect(settings.skills).toEqual({ enabled: true, editors: [] });
      expect(settings.workPlans).toEqual({ enabled: true, editors: [] });
      expect(settings.knowledgeBase.enabled).toBe(true);
      expect(settings.htmlTemplates.enabled).toBe(true);
      expect(settings.landingPages.enabled).toBe(true);
      expect(settings.analytics.enabled).toBe(true);
      // Always-on features carry only editors
      expect(settings.brandGuidelines).toEqual({ editors: [] });
      expect(settings.marketingStrategy).toEqual({ editors: [] });
    });
  });

  describe('GET /api/org/me - get current org', () => {
    it('should return null if user has no org', async () => {
      const res = await request(app).get('/api/org/me');
      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it('should return org with members if user is in an org', async () => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
      mockUsers['user-2'].orgId = 'org-1';
      mockUsers['user-2'].orgRole = 'member';

      const res = await request(app).get('/api/org/me');
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Test Org');
      expect(res.body.data.members).toHaveLength(2);
      // Members should not include sensitive data
      expect(res.body.data.members[0]).not.toHaveProperty('password');
    });
  });

  describe('PUT /api/org/:orgId - update org', () => {
    beforeEach(() => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
    });

    it('should fail if not the owner', async () => {
      mockUser = mockUsers['user-2'];
      mockUsers['user-2'].orgId = 'org-1';
      mockUsers['user-2'].orgRole = 'member';
      const res = await request(app).put('/api/org/org-1').send({ name: 'New Name' });
      expect(res.status).toBe(403);
    });

    it('should fail for non-existent org', async () => {
      const res = await request(app).put('/api/org/fake-org').send({ name: 'New Name' });
      expect(res.status).toBe(404);
    });

    it('should update org name', async () => {
      const res = await request(app).put('/api/org/org-1').send({ name: 'Updated Org' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/org/:orgId/copy-profile - copy shared profile data', () => {
    beforeEach(() => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
    });

    it('copies an existing marketStrategy along with brand guidelines', async () => {
      mockUsers['user-1'].brandGuidelines = {
        brandData: { brandName: 'Corgi' },
        attachments: [],
        createdAt: '2026-06-22T00:00:00.000Z',
        updatedAt: '2026-06-22T00:00:00.000Z',
      };
      mockUsers['user-1'].marketStrategy = {
        businessOverview: 'Corgi helps GTM teams target accounts.',
        competitors: [{ name: 'Competitor A', description: 'Legacy option' }],
        icp: [{ title: 'Account executives', description: 'Sales users', valueProposition: 'Find better leads', buyerPersonas: [] }],
        createdAt: '2026-06-22T00:00:00.000Z',
        updatedAt: '2026-06-22T00:00:00.000Z',
      };

      const res = await request(app).post('/api/org/org-1/copy-profile').send({});

      expect(res.status).toBe(200);
      expect(res.body.copiedFields).toEqual(['brandGuidelines', 'marketStrategy']);
      expect(mockOrgs['org-1'].brandGuidelines.brandData.brandName).toBe('Corgi');
      expect(mockOrgs['org-1'].marketStrategy.icp).toHaveLength(1);
    });

    it('copies ICPs from onboarding results when marketStrategy is missing', async () => {
      mockUsers['user-1'].icpResult = [
        {
          name: 'Revenue leaders',
          pain: 'Pipeline is too broad.',
          desire: 'Prioritized target accounts.',
          objection: 'Already has a CRM.',
          meta_targeting_brief: 'VP Sales and RevOps leaders at B2B SaaS companies',
        },
      ];

      const res = await request(app).post('/api/org/org-1/copy-profile').send({});

      expect(res.status).toBe(200);
      expect(res.body.copiedFields).toEqual(['marketStrategy']);
      expect(mockOrgs['org-1'].marketStrategy.icp).toEqual([
        {
          title: 'Revenue leaders',
          description: 'Pipeline is too broad.',
          valueProposition: 'Prioritized target accounts.',
          buyerPersonas: ['VP Sales and RevOps leaders at B2B SaaS companies'],
        },
      ]);
    });

    it('copies competitors from onboarding results when marketStrategy is missing', async () => {
      mockUsers['user-1'].competitorResult = {
        per_icp: [
          {
            icp_id: 'icp-1',
            competitor_names: ['Legacy CRM', 'Legacy CRM', 'Point Solution'],
            offer_angles: ['Fast list building', 'Targeted landing pages'],
            meta_targeting_brief: 'AE teams',
          },
        ],
      };

      const res = await request(app).post('/api/org/org-1/copy-profile').send({});

      expect(res.status).toBe(200);
      expect(mockOrgs['org-1'].marketStrategy.competitors).toEqual([
        { name: 'Legacy CRM', description: 'Fast list building; Targeted landing pages' },
        { name: 'Point Solution', description: 'Fast list building; Targeted landing pages' },
      ]);
    });

    it('fills missing ICP and competitor sections from onboarding without overwriting existing business overview', async () => {
      mockUsers['user-1'].marketStrategy = {
        businessOverview: 'Existing overview from the owner account.',
        competitors: [],
        icp: [],
        createdAt: '2026-06-20T00:00:00.000Z',
        updatedAt: '2026-06-20T00:00:00.000Z',
      };
      mockUsers['user-1'].icpResult = [
        {
          name: 'Account executives',
          pain: 'Manual prospecting takes too long.',
          desire: 'Sample lead lists for every segment.',
          objection: 'Needs proof quality is high.',
          meta_targeting_brief: 'AEs at growth-stage software companies',
        },
      ];
      mockUsers['user-1'].competitorResult = {
        per_icp: [
          {
            icp_id: 'icp-1',
            competitor_names: ['Prospecting Tool'],
            offer_angles: ['Enriched lists'],
            meta_targeting_brief: 'Sales teams',
          },
        ],
      };

      const res = await request(app).post('/api/org/org-1/copy-profile').send({});

      expect(res.status).toBe(200);
      expect(mockOrgs['org-1'].marketStrategy.businessOverview).toBe('Existing overview from the owner account.');
      expect(mockOrgs['org-1'].marketStrategy.icp).toHaveLength(1);
      expect(mockOrgs['org-1'].marketStrategy.competitors).toHaveLength(1);
    });
  });

  describe('POST /api/org/:orgId/invite - invite member', () => {
    beforeEach(() => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
        pendingInvites: [],
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
    });

    it('should fail without email', async () => {
      const res = await request(app).post('/api/org/org-1/invite').send({});
      expect(res.status).toBe(400);
    });

    it('should fail if not the owner', async () => {
      mockUser = mockUsers['user-2'];
      const res = await request(app).post('/api/org/org-1/invite').send({ email: 'new@example.com' });
      expect(res.status).toBe(403);
    });

    it('should fail if target user is already in this org', async () => {
      mockUsers['user-2'].orgId = 'org-1';
      const res = await request(app).post('/api/org/org-1/invite').send({ email: 'member@example.com' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already in your organization/i);
    });

    it('should fail if target user is in another org', async () => {
      mockUsers['user-2'].orgId = 'other-org';
      const res = await request(app).post('/api/org/org-1/invite').send({ email: 'member@example.com' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already in another organization/i);
    });

    it('should succeed and send an invite', async () => {
      const res = await request(app).post('/api/org/org-1/invite').send({ email: 'member@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/invitation sent/i);
    });

    // ENG-1112: "send an invite" above asserts only the HTTP envelope. The route's whole
    // point — that an invite email is actually composed, addressed to the invitee, and
    // carries a working accept link — was never asserted, so the handler could have sent
    // nothing, sent to the wrong address, or omitted the token and this suite would still
    // have passed. Assert the intent against the mocked transport instead.
    it('composes the invite email: recipient, subject, and an accept link carrying the stored token', async () => {
      const res = await request(app).post('/api/org/org-1/invite').send({ email: 'Member@Example.com' });
      expect(res.status).toBe(200);

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      const [{ to, subject, text, html }] = mockSendEmail.mock.calls[0];

      // Addressed to the invitee, normalised to lower case — the same value stored on
      // the org's pendingInvites, so accept-invite can match it.
      expect(to).toBe('member@example.com');
      const storedInvite = mockOrgs['org-1'].pendingInvites.at(-1);
      expect(storedInvite.email).toBe('member@example.com');

      expect(subject).toBe("You're invited to join Test Org on AgentWeb");

      // The link must carry the *stored* token and org, or the invitee cannot accept.
      const expectedLink =
        `http://localhost:5174/org/accept-invite` +
        `?token=${storedInvite.inviteToken}&orgId=org-1`;
      expect(text).toContain(expectedLink);
      expect(html).toContain(`href="${expectedLink}"`);

      // Inviter is named from the acting user, and the org name is rendered in the body.
      expect(text).toContain('Test Owner');
      expect(html).toContain('Test Org');

      // A 64-hex-char token: the route mints 32 random bytes. A truncated or predictable
      // token would be an authorization defect, not a cosmetic one.
      expect(storedInvite.inviteToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stamps pendingOrgInvite on an existing account so login routes them to accept-invite', async () => {
      const res = await request(app).post('/api/org/org-1/invite').send({ email: 'member@example.com' });
      expect(res.status).toBe(200);

      const storedInvite = mockOrgs['org-1'].pendingInvites.at(-1);
      expect(mockUsers['user-2'].pendingOrgInvite).toEqual({
        orgId: 'org-1',
        inviteToken: storedInvite.inviteToken,
      });
    });

    it('still creates the invite when the email transport fails — and reports success', async () => {
      // The handler swallows send failures on purpose ("Don't fail the invite if email
      // fails"). Pinned here because it is exactly why a live-send regression was
      // invisible: a rejected POST to api.resend.com produced a 200 and a green suite.
      mockSendEmail.mockRejectedValueOnce(new Error('transport down'));

      const res = await request(app).post('/api/org/org-1/invite').send({ email: 'member@example.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockOrgs['org-1'].pendingInvites).toHaveLength(1);
    });

    // Replaces the removed maxMembers/memberCount capacity tests. Org size is no
    // longer capped: tiers are usage-based, not seat-based, so there is nothing
    // for a seat limit to enforce. Orgs that predate this still carry a stored
    // maxMembers attribute; nothing reads it, so it is inert.
    it('does not cap org size — an invite succeeds well past the old limit of 5', async () => {
      for (let i = 0; i < 12; i++) {
        mockUsers[`filler-${i}`] = { userId: `filler-${i}`, email: `filler-${i}@example.com`, orgId: 'org-1', orgRole: 'member' };
      }
      const res = await request(app).post('/api/org/org-1/invite').send({ email: 'thirteenth@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('ignores a stale maxMembers attribute left on an org created before the cap was removed', async () => {
      (mockOrgs['org-1'] as any).maxMembers = 5;
      (mockOrgs['org-1'] as any).memberCount = 5;
      const res = await request(app).post('/api/org/org-1/invite').send({ email: 'sixth@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('POST /api/org/accept-invite - accept invite', () => {
    beforeEach(() => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
        pendingInvites: [{
          email: 'member@example.com',
          inviteToken: 'valid-token',
          invitedAt: '2026-01-01T00:00:00Z',
          invitedBy: 'user-1',
        }],
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
      // Owner is on a paid tier — the org's effective tier that members inherit.
      mockUsers['user-1'].subscriptionType = 'Pro';
      mockUsers['user-1'].allowedPages = ['/', '/agent-mode', '/settings', '/landing-pages'];
      mockUsers['user-1'].allowedSkills = ['*'];
      // Member starts on the default Free tier from signup.
      mockUsers['user-2'].subscriptionType = 'Free';
      mockUsers['user-2'].allowedPages = ['/', '/agent-mode', '/settings'];
      mockUsers['user-2'].allowedSkills = [];
      // Switch to member user for accept
      mockUser = mockUsers['user-2'];
    });

    it('should fail with missing params', async () => {
      const res = await request(app).post('/api/org/accept-invite').send({});
      expect(res.status).toBe(400);
    });

    it('should fail with wrong token', async () => {
      const res = await request(app).post('/api/org/accept-invite').send({
        orgId: 'org-1',
        inviteToken: 'wrong-token',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid or expired/i);
    });

    it('should fail if user is already in an org', async () => {
      mockUsers['user-2'].orgId = 'other-org';
      const res = await request(app).post('/api/org/accept-invite').send({
        orgId: 'org-1',
        inviteToken: 'valid-token',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already in an organization/i);
    });

    it('should succeed and join the org', async () => {
      const res = await request(app).post('/api/org/accept-invite').send({
        orgId: 'org-1',
        inviteToken: 'valid-token',
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockUsers['user-2'].orgId).toBe('org-1');
      expect(mockUsers['user-2'].orgRole).toBe('member');
    });

    it('should NOT snapshot the owner tier onto the member on accept (ENG-288)', async () => {
      const res = await request(app).post('/api/org/accept-invite').send({
        orgId: 'org-1',
        inviteToken: 'valid-token',
      });
      expect(res.status).toBe(200);
      // The member's effective tier is resolved dynamically from the org owner at
      // read time (getUserSubscriptionType), NOT persisted onto the member record.
      // Snapshotting the owner's tier here would leave a departed/downgraded member
      // with permanently elevated access, so accept-invite must leave the member's
      // own subscription fields untouched.
      expect(mockUsers['user-2'].subscriptionType).toBe('Free');
      expect(mockUsers['user-2'].allowedPages).toEqual(['/', '/agent-mode', '/settings']);
      expect(mockUsers['user-2'].allowedSkills).toEqual([]);
    });
  });

  describe('DELETE /api/org/:orgId/members/:memberId - remove member', () => {
    beforeEach(() => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
      mockUsers['user-2'].orgId = 'org-1';
      mockUsers['user-2'].orgRole = 'member';
    });

    it('should fail if not the owner', async () => {
      mockUser = mockUsers['user-2'];
      const res = await request(app).delete('/api/org/org-1/members/user-2');
      expect(res.status).toBe(403);
    });

    it('should fail if trying to remove self', async () => {
      const res = await request(app).delete('/api/org/org-1/members/user-1');
      expect(res.status).toBe(400);
    });

    it('should succeed and remove the member', async () => {
      const res = await request(app).delete('/api/org/org-1/members/user-2');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockUsers['user-2'].orgId).toBeUndefined();
    });
  });

  describe('POST /api/org/:orgId/leave - leave org', () => {
    beforeEach(() => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
      mockUsers['user-2'].orgId = 'org-1';
      mockUsers['user-2'].orgRole = 'member';
    });

    // Behavior change (ENG-954): what blocks the owner is being the LAST owner,
    // not being the owner. The old 400 fired unconditionally and told them to
    // "transfer ownership" via a route that was never built, which made the
    // primary owner permanently unable to leave their own org. Now it is a 409
    // naming the actual remedy, and it lifts as soon as a second owner exists.
    it('should fail if the only owner tries to leave, naming the remedy', async () => {
      const res = await request(app).post('/api/org/org-1/leave');
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/only owner/i);
      expect(res.body.error).toMatch(/promote another member/i);
    });

    it('should succeed for an owner once a second owner exists', async () => {
      mockUsers['user-2'].orgRole = 'owner';
      const res = await request(app).post('/api/org/org-1/leave');
      expect(res.status).toBe(200);
      expect(mockUsers['user-1'].orgId).toBeUndefined();
    });

    it('should succeed for a member', async () => {
      mockUser = mockUsers['user-2'];
      const res = await request(app).post('/api/org/org-1/leave');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockUsers['user-2'].orgId).toBeUndefined();
    });
  });

  describe('DELETE /api/org/:orgId - delete org', () => {
    beforeEach(() => {
      mockOrgs['org-1'] = {
        orgId: 'org-1',
        name: 'Test Org',
        ownerUserId: 'user-1',
      };
      mockUsers['user-1'].orgId = 'org-1';
      mockUsers['user-1'].orgRole = 'owner';
      mockUsers['user-2'].orgId = 'org-1';
      mockUsers['user-2'].orgRole = 'member';
    });

    it('should fail if not the owner', async () => {
      mockUser = mockUsers['user-2'];
      const res = await request(app).delete('/api/org/org-1');
      expect(res.status).toBe(403);
    });

    it('should succeed and remove all members', async () => {
      const res = await request(app).delete('/api/org/org-1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockOrgs['org-1']).toBeUndefined();
    });
  });
});
