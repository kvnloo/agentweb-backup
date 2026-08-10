/**
 * ENG-953 — `GET /api/org/me` must not disclose org secrets or credential-
 * bearing fields to org members.
 *
 * The route is membership-gated only (`routes/org.ts` `/me`), so every member of
 * an org can read it — not just the owner. Before this suite the handler
 * returned `{ ...org }`, which included `secrets` (the encrypted per-org
 * credential map written by the ClickUp and Foreplay OAuth callbacks) and
 * unsanitized `connected_accounts`.
 *
 * These assertions are the ENG-953 behavioral contract. They are written to fail
 * against the pre-fix handler: see the PR body for the proven-red run.
 */
import request from 'supertest';
import express from 'express';
import orgRoutes from '../routes/org';

let mockUsers: Record<string, any> = {};
let mockOrgs: Record<string, any> = {};
let currentUserId = 'user-2'; // a MEMBER, not the owner — that is the exposure

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: currentUserId, email: 'member@example.com', isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((userId: string) => Promise.resolve(mockUsers[userId] || null)),
    getUserByEmail: jest.fn(() => Promise.resolve(null)),
    updateUser: jest.fn(() => Promise.resolve(null)),
  },
  orgDb: {
    getOrgById: jest.fn((orgId: string) => Promise.resolve(mockOrgs[orgId] || null)),
    getOrgMembers: jest.fn((orgId: string) =>
      Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === orgId))
    ),
    ORG_MAX_MEMBERS: 5,
  },
}));

jest.mock('../services/emailService', () => ({
  emailService: { sendEmail: jest.fn().mockResolvedValue(undefined) },
}));

let app: express.Application;

/** Every credential-ish value seeded below. None may appear in the response. */
const SECRET_VALUES = [
  'clickup-encrypted-blob',
  'foreplay-encrypted-blob',
  'ya29.a0-super-secret-access-token',
  'refresh-me-please',
  'sk_live_51H0000000000',
  'invite-token-abc123',
  'domain-request-token-xyz789',
];

beforeEach(() => {
  jest.clearAllMocks();
  currentUserId = 'user-2';

  mockUsers = {
    'user-1': { userId: 'user-1', email: 'owner@example.com', displayName: 'Owner', orgId: 'org-1', orgRole: 'owner' },
    'user-2': { userId: 'user-2', email: 'member@example.com', displayName: 'Member', orgId: 'org-1', orgRole: 'member' },
  };

  mockOrgs = {
    'org-1': {
      orgId: 'org-1',
      name: 'Acme',
      ownerUserId: 'user-1',
      maxMembers: 5,
      memberCount: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',

      // --- the disclosure ---
      secrets: {
        clickup_token: 'clickup-encrypted-blob',
        foreplay_api_key: 'foreplay-encrypted-blob',
      },
      connected_accounts: [
        {
          platform: 'google',
          account_id: 'acct-1',
          account_name: 'Acme Google',
          created_at: '2026-01-01T00:00:00.000Z',
          config: {
            account_type: 'oauth',
            profile_id: 'p-1',
            access_token: 'ya29.a0-super-secret-access-token',
            refresh_token: 'refresh-me-please',
            api_key: 'sk_live_51H0000000000',
          },
        },
      ],
      pendingInvites: [
        { email: 'invitee@example.com', inviteToken: 'invite-token-abc123', invitedAt: '2026-01-03T00:00:00.000Z', invitedBy: 'user-1' },
      ],
      pendingDomainJoinRequests: [
        { userId: 'user-9', email: 'joiner@acme.com', requestedAt: '2026-01-04T00:00:00.000Z', requestToken: 'domain-request-token-xyz789' },
      ],

      // --- fields the portal actually renders ---
      autoJoinEnabled: true,
      autoJoinDomain: 'acme.com',
    },
  };

  app = express();
  app.use(express.json());
  app.use('/api/org', orgRoutes);
});

describe('ENG-953 — GET /api/org/me projection', () => {
  it('AC1: never returns the `secrets` field (absent, not null)', async () => {
    const res = await request(app).get('/api/org/me');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTruthy();
    // `absent`, not merely falsy — a null would still confirm the field exists.
    expect(Object.prototype.hasOwnProperty.call(res.body.data, 'secrets')).toBe(false);
  });

  it('AC2: returns connected_accounts only in sanitized form', async () => {
    const res = await request(app).get('/api/org/me');
    const account = res.body.data.connected_accounts[0];

    // Non-credential config survives, so the portal still renders the account.
    expect(account.platform).toBe('google');
    expect(account.account_name).toBe('Acme Google');
    expect(account.config.account_type).toBe('oauth');
    expect(account.config.profile_id).toBe('p-1');

    expect(account.config.access_token).toBeUndefined();
    expect(account.config.refresh_token).toBeUndefined();
    expect(account.config.api_key).toBeUndefined();
  });

  it('AC3: is an allowlist — an unknown org field does not appear', async () => {
    mockOrgs['org-1'].someFutureCredentialField = 'leaked-by-default';
    const res = await request(app).get('/api/org/me');
    expect(Object.prototype.hasOwnProperty.call(res.body.data, 'someFutureCredentialField')).toBe(false);
  });

  it('AC4: no regression — every field the portal reads is still present', async () => {
    const res = await request(app).get('/api/org/me');
    const d = res.body.data;
    // Enumerated from agentweb-customer-portal OrganizationTab.tsx.
    expect(d.orgId).toBe('org-1');
    expect(d.name).toBe('Acme');
    expect(d.maxMembers).toBe(5);
    expect(d.autoJoinEnabled).toBe(true);
    expect(d.autoJoinDomain).toBe('acme.com');
    expect(Array.isArray(d.members)).toBe(true);
    expect(Array.isArray(d.pendingInvites)).toBe(true);
    expect(Array.isArray(d.pendingDomainJoinRequests)).toBe(true);
    // The portal renders these two specific invite fields.
    expect(d.pendingInvites[0].email).toBe('invitee@example.com');
    expect(d.pendingInvites[0].invitedAt).toBe('2026-01-03T00:00:00.000Z');
  });

  it('AC5: members keeps only the existing safe projection', async () => {
    const res = await request(app).get('/api/org/me');
    for (const m of res.body.data.members) {
      expect(Object.keys(m).sort()).toEqual(['displayName', 'email', 'orgId', 'orgRole', 'userId'].filter((k) => k in m).sort());
      expect(m.pendingOrgInvite).toBeUndefined();
    }
  });

  it('strips invite and domain-join bearer tokens', async () => {
    const res = await request(app).get('/api/org/me');
    expect(res.body.data.pendingInvites[0].inviteToken).toBeUndefined();
    expect(res.body.data.pendingDomainJoinRequests[0].requestToken).toBeUndefined();
  });

  it('no seeded secret value appears anywhere in the serialized payload', async () => {
    // Whole-body scan: catches a leak through any field, including one added later.
    const res = await request(app).get('/api/org/me');
    const body = JSON.stringify(res.body);
    for (const secret of SECRET_VALUES) {
      expect(body).not.toContain(secret);
    }
  });

  // --- boundary + invalid-input coverage for the collection branches (Greptile) ---

  it('legacy record with no collections: fields are absent, nothing crashes', async () => {
    delete mockOrgs['org-1'].connected_accounts;
    delete mockOrgs['org-1'].pendingInvites;
    delete mockOrgs['org-1'].pendingDomainJoinRequests;
    const res = await request(app).get('/api/org/me');
    expect(res.status).toBe(200);
    expect(res.body.data.connected_accounts).toBeUndefined();
    expect(res.body.data.pendingInvites).toBeUndefined();
    expect(res.body.data.pendingDomainJoinRequests).toBeUndefined();
    expect(res.body.data.name).toBe('Acme');
  });

  it('empty collections stay empty rather than becoming undefined', async () => {
    mockOrgs['org-1'].connected_accounts = [];
    mockOrgs['org-1'].pendingInvites = [];
    const res = await request(app).get('/api/org/me');
    expect(res.body.data.connected_accounts).toEqual([]);
    expect(res.body.data.pendingInvites).toEqual([]);
  });

  it('FAILS CLOSED: a non-array connected_accounts is dropped, not passed through', async () => {
    // A malformed/legacy record shaped as an object must not bypass the
    // sanitizer. Passing the raw value through would re-open the disclosure.
    mockOrgs['org-1'].connected_accounts = {
      google: { config: { access_token: 'ya29.a0-super-secret-access-token' } },
    } as any;
    const res = await request(app).get('/api/org/me');
    expect(res.body.data.connected_accounts).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('ya29.a0-super-secret-access-token');
  });

  it('FAILS CLOSED: non-array invite collections are dropped, tokens never leak', async () => {
    mockOrgs['org-1'].pendingInvites = { a: { inviteToken: 'invite-token-abc123' } } as any;
    mockOrgs['org-1'].pendingDomainJoinRequests = 'corrupt' as any;
    const res = await request(app).get('/api/org/me');
    expect(res.body.data.pendingInvites).toBeUndefined();
    expect(res.body.data.pendingDomainJoinRequests).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('invite-token-abc123');
  });

  it('tolerates null entries inside the collections', async () => {
    mockOrgs['org-1'].pendingInvites = [null, { email: 'x@y.com', invitedAt: 'now', inviteToken: 'invite-token-abc123' }] as any;
    const res = await request(app).get('/api/org/me');
    expect(res.status).toBe(200);
    expect(res.body.data.pendingInvites).toHaveLength(2);
    expect(res.body.data.pendingInvites[1].email).toBe('x@y.com');
    expect(JSON.stringify(res.body)).not.toContain('invite-token-abc123');
  });

  it('a null or primitive entry in connected_accounts does not 500 the endpoint', async () => {
    // sanitizeConnectedAccountForOrgResponse reads account.config; a null entry
    // would throw and take /me down for every member of the org.
    mockOrgs['org-1'].connected_accounts = [
      null,
      'garbage',
      {
        platform: 'google',
        account_id: 'acct-1',
        config: { profile_id: 'p-1', access_token: 'ya29.a0-super-secret-access-token' },
      },
    ] as any;
    const res = await request(app).get('/api/org/me');
    expect(res.status).toBe(200);
    // Unsanitizable entries are dropped, the real one survives sanitized.
    expect(res.body.data.connected_accounts).toHaveLength(1);
    expect(res.body.data.connected_accounts[0].config.profile_id).toBe('p-1');
    expect(JSON.stringify(res.body)).not.toContain('ya29.a0-super-secret-access-token');
  });
});
