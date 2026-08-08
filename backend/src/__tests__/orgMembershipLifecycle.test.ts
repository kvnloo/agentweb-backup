/**
 * ENG-954 — the full org membership lifecycle, end to end at the route level.
 *
 * Add a person, promote them, demote them, remove them, let them leave, and do
 * the same to owners. These behaviors are well-defined and should not shift as
 * the authorization internals change, so they are pinned here deterministically
 * rather than left to a browser pass.
 *
 * The scenario throughout is xCures: Filipe owns the org and is the billing
 * root, Eric and Tyler need real authority, Georgia and Sophie are members.
 */

import request from 'supertest';
import express from 'express';
import orgRoutes from '../routes/org';
import { orgDb } from '../services/db';

let actingUserId = 'u-filipe';
let mockUsers: Record<string, any> = {};
let mockOrgs: Record<string, any> = {};

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
    getUserById: jest.fn((userId: string) => Promise.resolve(mockUsers[userId] || null)),
    getUserByEmail: jest.fn((email: string) =>
      Promise.resolve(Object.values(mockUsers).find((u: any) => u.email === email) || null)),
    updateUser: jest.fn((userId: string, updates: any) => {
      if (mockUsers[userId]) Object.assign(mockUsers[userId], updates);
      return Promise.resolve(mockUsers[userId]);
    }),
    joinOrg: jest.fn((userId: string, orgId: string, orgRole: string) => {
      const user = mockUsers[userId];
      if (!user || user.orgId) return Promise.resolve('already_in_org');
      user.orgId = orgId;
      user.orgRole = orgRole;
      user.pendingOrgInvite = null;
      return Promise.resolve('joined');
    }),
    clearOrgMembership: jest.fn((userId: string) => {
      const user = mockUsers[userId];
      if (user) { delete user.orgId; delete user.orgRole; }
      return Promise.resolve();
    }),
  },
  orgDb: {
    getOrgById: jest.fn((orgId: string) => Promise.resolve(mockOrgs[orgId] || null)),
    getOrgMembers: jest.fn((orgId: string) =>
      Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === orgId))),
    getOrgMemberCount: jest.fn((orgId: string) =>
      Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === orgId).length)),
    updateOrg: jest.fn((orgId: string, updates: any) => {
      Object.assign(mockOrgs[orgId], updates);
      return Promise.resolve(mockOrgs[orgId]);
    }),
    createOrg: jest.fn((org: any) => { mockOrgs[org.orgId] = org; return Promise.resolve(org); }),
    deleteOrg: jest.fn((orgId: string) => { delete mockOrgs[orgId]; return Promise.resolve(); }),
    removeDomainJoinRequest: jest.fn((orgId: string, requestToken: string) => {
      const org = mockOrgs[orgId];
      const before = (org?.pendingDomainJoinRequests || []).length;
      if (!org) return Promise.resolve(false);
      org.pendingDomainJoinRequests = (org.pendingDomainJoinRequests || [])
        .filter((r: any) => r.requestToken !== requestToken);
      return Promise.resolve(org.pendingDomainJoinRequests.length < before);
    }),
  },
  Organization: {},
}));

jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }), { virtual: true });

const ORG = 'org-xcures';
let app: express.Express;

function seed() {
  mockUsers = {
    'u-filipe':  { userId: 'u-filipe',  email: 'filipe@xcures.com',  orgId: ORG, orgRole: 'owner'  },
    'u-eric':    { userId: 'u-eric',    email: 'eric@xcures.com',    orgId: ORG, orgRole: 'member' },
    'u-tyler':   { userId: 'u-tyler',   email: 'tyler@xcures.com',   orgId: ORG, orgRole: 'member' },
    'u-georgia': { userId: 'u-georgia', email: 'georgia@xcures.com', orgId: ORG, orgRole: 'member' },
    'u-outsider':{ userId: 'u-outsider',email: 'outsider@other.com' },
    'u-newgrad': { userId: 'u-newgrad', email: 'newgrad@xcures.com' },
    'u-juan':    { userId: 'u-juan',    email: 'juan@haven.com', orgId: 'org-haven', orgRole: 'owner' },
  };
  mockOrgs = {
    [ORG]: {
      orgId: ORG,
      name: 'xCures',
      ownerUserId: 'u-filipe',
      pendingInvites: [],
      pendingDomainJoinRequests: [
        { userId: 'u-newgrad', email: 'newgrad@xcures.com', requestedAt: '2026-08-07T00:00:00.000Z', requestToken: 'tok-newgrad' },
      ],
    },
    'org-haven': { orgId: 'org-haven', name: 'Haven', ownerUserId: 'u-juan', pendingInvites: [] },
  };
  actingUserId = 'u-filipe';
}

const setRole = (target: string, role: string) =>
  request(app).patch(`/api/org/${ORG}/members/${target}/role`).send({ role });

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  app = express();
  app.use(express.json());
  app.use('/api/org', orgRoutes);
});

describe('promoting people (upgrading)', () => {
  it('an owner promotes a member to admin', async () => {
    const res = await setRole('u-eric', 'admin');
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    expect(mockUsers['u-eric'].orgRole).toBe('admin');
  });

  it('an owner promotes a member all the way to owner — orgs can have many', async () => {
    await setRole('u-eric', 'owner');
    expect(mockUsers['u-eric'].orgRole).toBe('owner');
    const owners = Object.values(mockUsers).filter((u: any) => u.orgId === ORG && u.orgRole === 'owner');
    expect(owners).toHaveLength(2);
  });

  it('promoting does not move the billing root', async () => {
    await setRole('u-eric', 'owner');
    expect(mockOrgs[ORG].ownerUserId).toBe('u-filipe');
  });

  it('an ADMIN may promote a member to admin', async () => {
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    const res = await setRole('u-tyler', 'admin');
    expect(res.status).toBe(200);
    expect(mockUsers['u-tyler'].orgRole).toBe('admin');
  });

  it('an ADMIN may NOT mint an owner — that would route around the delete-org denial', async () => {
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    const res = await setRole('u-tyler', 'owner');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only an owner can grant or revoke owner/i);
    expect(mockUsers['u-tyler'].orgRole).toBe('member');
  });

  it('a plain MEMBER may not change anyone’s role', async () => {
    actingUserId = 'u-georgia';
    const res = await setRole('u-tyler', 'admin');
    expect(res.status).toBe(403);
    expect(mockUsers['u-tyler'].orgRole).toBe('member');
  });

  it('rejects an unknown role rather than storing it', async () => {
    const res = await setRole('u-eric', 'superadmin');
    expect(res.status).toBe(400);
    expect(mockUsers['u-eric'].orgRole).toBe('member');
  });

  it('setting the role a member already has is a no-op success', async () => {
    const res = await setRole('u-georgia', 'member');
    expect(res.status).toBe(200);
    expect(mockUsers['u-georgia'].orgRole).toBe('member');
  });
});

describe('demoting people (downgrading)', () => {
  it('an owner demotes an admin back to member', async () => {
    await setRole('u-eric', 'admin');
    const res = await setRole('u-eric', 'member');
    expect(res.status).toBe(200);
    expect(mockUsers['u-eric'].orgRole).toBe('member');
  });

  it('an owner demotes a second owner once another remains', async () => {
    await setRole('u-eric', 'owner');
    const res = await setRole('u-eric', 'admin');
    expect(res.status).toBe(200);
    expect(mockUsers['u-eric'].orgRole).toBe('admin');
  });

  it('the LAST owner cannot be demoted — this is the path that orphans orgs', async () => {
    // Filipe is also the billing root, so the billing-root guard answers first
    // now. Same invariant, earlier and with a more actionable reason: the
    // last owner in any org is necessarily the billing root, because roleOf
    // counts ownerUserId as an owner permanently.

    const res = await setRole('u-filipe', 'member');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/billing owner|only owner/i);
    expect(mockUsers['u-filipe'].orgRole).toBe('owner');
  });

  it('an ADMIN demotes another ADMIN back to member', async () => {
    await setRole('u-eric', 'admin');
    await setRole('u-tyler', 'admin');
    actingUserId = 'u-eric';
    const res = await setRole('u-tyler', 'member');
    expect(res.status).toBe(200);
    expect(mockUsers['u-tyler'].orgRole).toBe('member');
  });

  it('the BILLING ROOT cannot be demoted — it would report success and move nothing', async () => {
    // roleOf unions ownerUserId, so writing the column here changes no
    // authority at all. Live run returned 200 twice while the target kept
    // canDeleteOrg. Succeeding at nothing is worse than refusing.
    await setRole('u-eric', 'owner');
    actingUserId = 'u-eric';
    const res = await setRole('u-filipe', 'member');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/billing owner/i);
    expect(mockUsers['u-filipe'].orgRole).toBe('owner');
  });

  it('the billing root can still be raised, and stays owner', async () => {
    await setRole('u-filipe', 'owner');
    expect(mockUsers['u-filipe'].orgRole).toBe('owner');
  });

  it('an ADMIN may not demote an owner', async () => {
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    const res = await setRole('u-filipe', 'member');
    expect(res.status).toBe(403);
    expect(mockUsers['u-filipe'].orgRole).toBe('owner');
  });
});

describe('removing people', () => {
  const remove = (target: string) => request(app).delete(`/api/org/${ORG}/members/${target}`);

  it('an owner removes a member', async () => {
    const res = await remove('u-georgia');
    expect(res.status).toBe(200);
    expect(mockUsers['u-georgia'].orgId).toBeUndefined();
    expect(mockUsers['u-georgia'].orgRole).toBeUndefined();
  });

  it('an ADMIN removes a member', async () => {
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    const res = await remove('u-georgia');
    expect(res.status).toBe(200);
    expect(mockUsers['u-georgia'].orgId).toBeUndefined();
  });

  it('a plain member cannot remove anyone', async () => {
    actingUserId = 'u-georgia';
    const res = await remove('u-tyler');
    expect(res.status).toBe(403);
    expect(mockUsers['u-tyler'].orgId).toBe(ORG);
  });

  it('nobody can remove themselves through this route', async () => {
    const res = await remove('u-filipe');
    expect(res.status).toBe(400);
    expect(mockUsers['u-filipe'].orgId).toBe(ORG);
  });

  it('an ADMIN may not remove an owner — removal revokes ownership, which is owner-only', async () => {
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    const res = await remove('u-filipe');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only an owner/i);
    expect(mockUsers['u-filipe'].orgId).toBe(ORG);
    expect(mockUsers['u-filipe'].orgRole).toBe('owner');
  });

  it('an ADMIN may not remove a SECOND owner either — remove and demote now agree', async () => {
    // The asymmetry this pins: demote already 403s for an admin, so an admin who
    // could still *remove* an owner would be doing the same thing by a longer
    // route — and taking the owner out of the org as well.
    await setRole('u-tyler', 'owner');
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    const res = await remove('u-tyler');
    expect(res.status).toBe(403);
    expect(mockUsers['u-tyler'].orgId).toBe(ORG);
    expect(mockUsers['u-tyler'].orgRole).toBe('owner');
  });

  it('the LAST owner cannot be removed — the org would become unadministrable', async () => {
    await setRole('u-eric', 'owner');
    actingUserId = 'u-eric';
    // getOrgMembers reads an eventually-consistent GSI, so a just-promoted owner
    // can be missing from the listing. When the listing knows of only one owner,
    // removing them is refused rather than risking an org with no owner at all.
    (orgDb.getOrgMembers as jest.Mock).mockResolvedValueOnce([
      mockUsers['u-filipe'],
      mockUsers['u-georgia'],
    ]);
    const res = await remove('u-filipe');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only owner/i);
    expect(mockUsers['u-filipe'].orgId).toBe(ORG);
  });

  it('a second owner CAN be removed by another OWNER while one remains', async () => {
    await setRole('u-eric', 'owner');
    const res = await remove('u-eric');
    expect(res.status).toBe(200);
    expect(mockUsers['u-eric'].orgId).toBeUndefined();
    expect(mockUsers['u-filipe'].orgRole).toBe('owner');
  });

  it('a member of another org cannot be removed from this one', async () => {
    const res = await request(app).delete(`/api/org/${ORG}/members/u-juan`);
    expect(res.status).toBe(404);
    expect(mockUsers['u-juan'].orgId).toBe('org-haven');
  });
});

describe('leaving', () => {
  const leave = () => request(app).post(`/api/org/${ORG}/leave`);

  it('a member leaves on their own', async () => {
    actingUserId = 'u-georgia';
    const res = await leave();
    expect(res.status).toBe(200);
    expect(mockUsers['u-georgia'].orgId).toBeUndefined();
  });

  it('an admin leaves on their own', async () => {
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    const res = await leave();
    expect(res.status).toBe(200);
    expect(mockUsers['u-eric'].orgId).toBeUndefined();
  });

  it('the last owner cannot leave, and is told what to do instead', async () => {
    const res = await leave();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/promote another member/i);
    expect(mockUsers['u-filipe'].orgId).toBe(ORG);
  });

  it('an owner CAN leave once another owner exists — succession, end to end', async () => {
    // Filipe promotes Eric, then departs. No transfer primitive involved.
    await setRole('u-eric', 'owner');
    actingUserId = 'u-filipe';
    const res = await leave();
    expect(res.status).toBe(200);
    expect(mockUsers['u-filipe'].orgId).toBeUndefined();
    expect(mockUsers['u-eric'].orgRole).toBe('owner');
  });

  it('someone who is not a member gets a clear error', async () => {
    actingUserId = 'u-outsider';
    const res = await leave();
    expect(res.status).toBe(400);
  });
});

describe('adding people', () => {
  it('an owner invites a new person', async () => {
    const res = await request(app).post(`/api/org/${ORG}/invite`).send({ email: 'newhire@xcures.com' });
    expect(res.status).toBe(200);
    expect(mockOrgs[ORG].pendingInvites).toHaveLength(1);
  });

  it('an ADMIN invites a new person — the thing xCures actually asked for', async () => {
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    const res = await request(app).post(`/api/org/${ORG}/invite`).send({ email: 'newhire@xcures.com' });
    expect(res.status).toBe(200);
  });

  it('a plain member cannot invite', async () => {
    actingUserId = 'u-georgia';
    const res = await request(app).post(`/api/org/${ORG}/invite`).send({ email: 'newhire@xcures.com' });
    expect(res.status).toBe(403);
    expect(mockOrgs[ORG].pendingInvites).toHaveLength(0);
  });

  it('org size is not capped — invites keep succeeding past the old limit of 5', async () => {
    for (let i = 0; i < 10; i++) {
      mockUsers[`u-fill-${i}`] = { userId: `u-fill-${i}`, email: `fill${i}@xcures.com`, orgId: ORG, orgRole: 'member' };
    }
    const res = await request(app).post(`/api/org/${ORG}/invite`).send({ email: 'fifteenth@xcures.com' });
    expect(res.status).toBe(200);
  });
});

describe('the roster reports EFFECTIVE authority, not the stored column', () => {
  const roster = () => request(app).get('/api/org/me');
  const roleInRoster = async (userId: string) => {
    const res = await roster();
    return (res.body?.data?.members ?? []).find((m: any) => m.userId === userId)?.orgRole;
  };

  it('a drifted billing root still reports as owner, because they still ARE one', async () => {
    // The API can no longer produce this drift — demoting the billing root is
    // refused. The DATA still can, and has twice in production (the stale-role
    // repairs in 15a47e29c and a7f320a80), plus every org created before
    // orgRole existed. That is what this pins.
    mockUsers['u-filipe'].orgRole = 'member';
    expect(mockOrgs[ORG].ownerUserId).toBe('u-filipe');

    // The roster must not call them a plain member while the same response
    // hands that same user canDeleteOrg.
    expect(await roleInRoster('u-filipe')).toBe('owner');
  });

  it('the roster agrees with the capabilities in the same response', async () => {
    mockUsers['u-filipe'].orgRole = 'member';
    actingUserId = 'u-filipe';
    const res = await roster();
    expect(res.body.data.capabilities.canDeleteOrg).toBe(true);
    expect(res.body.data.callerRole).toBe('owner');
    // The row for this very user, in this very payload.
    expect(await roleInRoster('u-filipe')).toBe('owner');
  });

  it('ordinary members and admins are unaffected', async () => {
    await setRole('u-eric', 'admin');
    expect(await roleInRoster('u-eric')).toBe('admin');
    expect(await roleInRoster('u-georgia')).toBe('member');
    expect(await roleInRoster('u-filipe')).toBe('owner');
  });
});

describe('invite -> accept: the whole admission round trip', () => {
  const invite = (email: string) => request(app).post(`/api/org/${ORG}/invite`).send({ email });
  const tokenFor = (email: string) =>
    (mockOrgs[ORG].pendingInvites || []).find((i: any) => i.email === email)?.inviteToken;
  const accept = (inviteToken: string) =>
    request(app).post('/api/org/accept-invite').send({ orgId: ORG, inviteToken });

  it('an owner invites an outsider, who accepts and lands as a member', async () => {
    expect((await invite('outsider@other.com')).status).toBe(200);
    const token = tokenFor('outsider@other.com');
    expect(token).toBeTruthy();

    actingUserId = 'u-outsider';
    const res = await accept(token);
    expect(res.status).toBe(200);
    expect(mockUsers['u-outsider'].orgId).toBe(ORG);
    expect(mockUsers['u-outsider'].orgRole).toBe('member');
    // The invite is consumed, so the same link cannot admit a second person.
    expect(mockOrgs[ORG].pendingInvites).toHaveLength(0);
  });

  it('an ADMIN can admit someone end to end, not just send the invite', async () => {
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    expect((await invite('outsider@other.com')).status).toBe(200);

    actingUserId = 'u-outsider';
    expect((await accept(tokenFor('outsider@other.com'))).status).toBe(200);
    expect(mockUsers['u-outsider'].orgRole).toBe('member');
  });

  it('a SECOND owner can admit someone end to end', async () => {
    await setRole('u-eric', 'owner');
    actingUserId = 'u-eric';
    expect((await invite('outsider@other.com')).status).toBe(200);

    actingUserId = 'u-outsider';
    expect((await accept(tokenFor('outsider@other.com'))).status).toBe(200);
    expect(mockUsers['u-outsider'].orgId).toBe(ORG);
  });

  it('a plain member cannot invite, so there is no token to accept', async () => {
    actingUserId = 'u-georgia';
    expect((await invite('outsider@other.com')).status).toBe(403);
    expect(mockOrgs[ORG].pendingInvites).toHaveLength(0);
  });

  it('a wrong token is refused and admits nobody', async () => {
    await invite('outsider@other.com');
    actingUserId = 'u-outsider';
    const res = await accept('not-the-token');
    expect(res.status).toBe(400);
    expect(mockUsers['u-outsider'].orgId).toBeUndefined();
  });

  it("someone else's token does not admit you", async () => {
    await invite('outsider@other.com');
    const token = tokenFor('outsider@other.com');
    // u-newgrad is a real user with a different email; the invite is matched on
    // token AND email, so holding the link is not enough.
    actingUserId = 'u-newgrad';
    const res = await accept(token);
    expect(res.status).toBe(400);
    expect(mockUsers['u-newgrad'].orgId).toBeUndefined();
  });
});

describe('revoking access', () => {
  const invite = (email: string) => request(app).post(`/api/org/${ORG}/invite`).send({ email });
  const cancel = (email: string) =>
    request(app).delete(`/api/org/${ORG}/invite/${encodeURIComponent(email)}`);
  const tokenFor = (email: string) =>
    (mockOrgs[ORG].pendingInvites || []).find((i: any) => i.email === email)?.inviteToken;

  it('an owner cancels a pending invite', async () => {
    await invite('outsider@other.com');
    const res = await cancel('outsider@other.com');
    expect(res.status).toBe(200);
    expect(mockOrgs[ORG].pendingInvites).toHaveLength(0);
  });

  it('an ADMIN cancels a pending invite', async () => {
    await invite('outsider@other.com');
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    const res = await cancel('outsider@other.com');
    expect(res.status).toBe(200);
    expect(mockOrgs[ORG].pendingInvites).toHaveLength(0);
  });

  it('a plain member cannot cancel, and the invite survives', async () => {
    await invite('outsider@other.com');
    actingUserId = 'u-georgia';
    const res = await cancel('outsider@other.com');
    expect(res.status).toBe(403);
    expect(mockOrgs[ORG].pendingInvites).toHaveLength(1);
  });

  it('a cancelled invite can no longer be accepted — revocation actually revokes', async () => {
    await invite('outsider@other.com');
    const token = tokenFor('outsider@other.com');
    await cancel('outsider@other.com');

    actingUserId = 'u-outsider';
    const res = await request(app).post('/api/org/accept-invite').send({ orgId: ORG, inviteToken: token });
    expect(res.status).toBe(400);
    expect(mockUsers['u-outsider'].orgId).toBeUndefined();
  });

  it("cancelling clears the invitee's pendingOrgInvite stamp, so they are not bounced to accept-invite", async () => {
    await invite('outsider@other.com');
    expect(mockUsers['u-outsider'].pendingOrgInvite).toMatchObject({ orgId: ORG });
    await cancel('outsider@other.com');
    expect(mockUsers['u-outsider'].pendingOrgInvite).toBeNull();
  });

  it('cancelling an invite that does not exist is a 404, not a silent success', async () => {
    const res = await cancel('nobody@nowhere.com');
    expect(res.status).toBe(404);
  });

  it('a removed member loses org access and can be re-invited afterwards', async () => {
    expect((await request(app).delete(`/api/org/${ORG}/members/u-georgia`)).status).toBe(200);
    expect(mockUsers['u-georgia'].orgId).toBeUndefined();
    expect(mockUsers['u-georgia'].orgRole).toBeUndefined();
    expect((await invite('georgia@xcures.com')).status).toBe(200);
  });
});

describe('domain-join requests (the other admission path)', () => {
  const approve = (tok: string) => request(app).post(`/api/org/${ORG}/domain-requests/${tok}/approve`);
  const reject = (tok: string) => request(app).post(`/api/org/${ORG}/domain-requests/${tok}/reject`);

  it('an owner approves, and the requester joins as a member', async () => {
    const res = await approve('tok-newgrad');
    expect(res.status).toBe(200);
    expect(mockUsers['u-newgrad'].orgId).toBe(ORG);
    expect(mockUsers['u-newgrad'].orgRole).toBe('member');
    expect(mockOrgs[ORG].pendingDomainJoinRequests).toHaveLength(0);
  });

  it('an ADMIN approves too — this is member management, not an owner reserve', async () => {
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    expect((await approve('tok-newgrad')).status).toBe(200);
    expect(mockUsers['u-newgrad'].orgId).toBe(ORG);
  });

  it('a plain member can neither approve nor reject', async () => {
    actingUserId = 'u-georgia';
    expect((await approve('tok-newgrad')).status).toBe(403);
    expect((await reject('tok-newgrad')).status).toBe(403);
    expect(mockUsers['u-newgrad'].orgId).toBeUndefined();
    expect(mockOrgs[ORG].pendingDomainJoinRequests).toHaveLength(1);
  });

  it('an ADMIN rejects, and the requester joins nothing', async () => {
    await setRole('u-eric', 'admin');
    actingUserId = 'u-eric';
    expect((await reject('tok-newgrad')).status).toBe(200);
    expect(mockUsers['u-newgrad'].orgId).toBeUndefined();
    expect(mockOrgs[ORG].pendingDomainJoinRequests).toHaveLength(0);
  });

  it('a rejected request cannot then be approved', async () => {
    await reject('tok-newgrad');
    const res = await approve('tok-newgrad');
    expect(res.status).toBe(400);
    expect(mockUsers['u-newgrad'].orgId).toBeUndefined();
  });
});

describe('the whole xCures story, in order', () => {
  it('Filipe adds Eric and Tyler as admins, Georgia stays a member, nobody is displaced', async () => {
    await setRole('u-eric', 'admin');
    await setRole('u-tyler', 'admin');

    expect(mockUsers['u-filipe'].orgRole).toBe('owner');
    expect(mockUsers['u-eric'].orgRole).toBe('admin');
    expect(mockUsers['u-tyler'].orgRole).toBe('admin');
    expect(mockUsers['u-georgia'].orgRole).toBe('member');
    // Filipe gave up nothing: still owner, still the billing root.
    expect(mockOrgs[ORG].ownerUserId).toBe('u-filipe');

    // Eric can now do the operational work he was blocked on.
    actingUserId = 'u-eric';
    expect((await request(app).post(`/api/org/${ORG}/invite`).send({ email: 'sixth@xcures.com' })).status).toBe(200);
    expect((await request(app).put(`/api/org/${ORG}`).send({ name: 'xCures Inc' })).status).toBe(200);

    // But he cannot delete the org.
    expect((await request(app).delete(`/api/org/${ORG}`)).status).toBe(403);
  });

  it('and if Filipe leaves, the org survives', async () => {
    await setRole('u-eric', 'owner');
    actingUserId = 'u-filipe';
    expect((await request(app).post(`/api/org/${ORG}/leave`)).status).toBe(200);

    actingUserId = 'u-eric';
    expect((await request(app).post(`/api/org/${ORG}/invite`).send({ email: 'x@xcures.com' })).status).toBe(200);
  });

  it('no action in xCures ever touches Haven', async () => {
    await setRole('u-eric', 'owner');
    await request(app).delete(`/api/org/${ORG}/members/u-tyler`);
    expect(mockUsers['u-juan'].orgId).toBe('org-haven');
    expect(mockUsers['u-juan'].orgRole).toBe('owner');
    expect(mockOrgs['org-haven'].ownerUserId).toBe('u-juan');
  });
});
