/**
 * Greptile #2297 finding: "Parameterized organization routes still apply a
 * caller's role to another selected organization."
 *
 * Proving it at the route level before treating it as real. Filipe owns xCures
 * and has NO relationship to Haven. Every assertion below is what SHOULD
 * happen; failures are the vulnerability.
 */
import request from 'supertest';
import express from 'express';
import orgRoutes from '../routes/org';

let actingUserId = 'u-filipe';
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
    getUserByEmail: jest.fn((e: string) =>
      Promise.resolve(Object.values(mockUsers).find((u: any) => u.email === e) || null)),
    updateUser: jest.fn((id: string, u: any) => { Object.assign(mockUsers[id], u); return Promise.resolve(mockUsers[id]); }),
    joinOrg: jest.fn(() => Promise.resolve('joined')),
    clearOrgMembership: jest.fn((id: string) => { delete mockUsers[id].orgId; delete mockUsers[id].orgRole; return Promise.resolve(); }),
  },
  orgDb: {
    getOrgById: jest.fn((id: string) => Promise.resolve(mockOrgs[id] || null)),
    getOrgMembers: jest.fn((id: string) =>
      Promise.resolve(Object.values(mockUsers).filter((u: any) => u.orgId === id))),
    getOrgMemberCount: jest.fn(() => Promise.resolve(2)),
    updateOrg: jest.fn((id: string, u: any) => { Object.assign(mockOrgs[id], u); return Promise.resolve(mockOrgs[id]); }),
    createOrg: jest.fn(),
    deleteOrg: jest.fn((id: string) => { delete mockOrgs[id]; return Promise.resolve(); }),
    removeDomainJoinRequest: jest.fn(() => Promise.resolve(true)),
  },
  Organization: {},
}));
jest.mock('../services/emailService', () => ({ sendEmail: jest.fn(() => Promise.resolve()) }), { virtual: true });

const XCURES = 'org-xcures';
const HAVEN = 'org-haven';
let app: express.Express;

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = {
    // Owner of xCures. No relationship whatsoever to Haven.
    'u-filipe': { userId: 'u-filipe', email: 'filipe@xcures.com', orgId: XCURES, orgRole: 'owner' },
    // A plain member of xCures, for the negative control.
    'u-georgia': { userId: 'u-georgia', email: 'georgia@xcures.com', orgId: XCURES, orgRole: 'member' },
    // Haven's own people.
    'u-juan': { userId: 'u-juan', email: 'juan@haven.com', orgId: HAVEN, orgRole: 'owner' },
    'u-maria': { userId: 'u-maria', email: 'maria@haven.com', orgId: HAVEN, orgRole: 'member' },
  };
  mockOrgs = {
    [XCURES]: { orgId: XCURES, name: 'xCures', ownerUserId: 'u-filipe', pendingInvites: [] },
    [HAVEN]: { orgId: HAVEN, name: 'Haven', ownerUserId: 'u-juan', pendingInvites: [] },
  };
  actingUserId = 'u-filipe';
  app = express();
  app.use(express.json());
  app.use('/api/org', orgRoutes);
});

describe("an owner of one org has no authority over another org", () => {
  it('cannot rename it', async () => {
    const res = await request(app).put(`/api/org/${HAVEN}`).send({ name: 'Owned By xCures' });
    expect(res.status).toBe(403);
    expect(mockOrgs[HAVEN].name).toBe('Haven');
  });

  it('cannot invite people into it', async () => {
    const res = await request(app).post(`/api/org/${HAVEN}/invite`).send({ email: 'stranger@elsewhere.com' });
    expect(res.status).toBe(403);
  });

  it("cannot remove its members", async () => {
    const res = await request(app).delete(`/api/org/${HAVEN}/members/u-maria`);
    expect(res.status).toBe(403);
    expect(mockUsers['u-maria'].orgId).toBe(HAVEN);
  });

  it("cannot change its members' roles", async () => {
    const res = await request(app).patch(`/api/org/${HAVEN}/members/u-maria/role`).send({ role: 'owner' });
    expect(res.status).toBe(403);
    expect(mockUsers['u-maria'].orgRole).toBe('member');
  });

  it('cannot DELETE it', async () => {
    const res = await request(app).delete(`/api/org/${HAVEN}`);
    expect(res.status).toBe(403);
    expect(mockOrgs[HAVEN]).toBeDefined();
  });

  it('a plain member of one org certainly cannot act on another', async () => {
    actingUserId = 'u-georgia';
    expect((await request(app).put(`/api/org/${HAVEN}`).send({ name: 'nope' })).status).toBe(403);
  });

  it("...while Haven's own owner still can — this is not a blanket denial", async () => {
    actingUserId = 'u-juan';
    const res = await request(app).put(`/api/org/${HAVEN}`).send({ name: 'Haven Inc' });
    expect(res.status).toBe(200);
  });
});
