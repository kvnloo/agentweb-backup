/**
 * ENG-927 — `GET /api/auth/me`'s `hasBrandGuidelines` flag.
 *
 * The flag is computed from the org-authoritative brand, so an org created
 * without copying the owner's profile must resolve through the owner's record
 * rather than reporting "no brand". MCP's `emma_get_account_status` surfaces
 * this verbatim as `is_onboarded`.
 *
 * The resolution is also the one org-derived enrichment in `/me` that can issue
 * an extra record read, and `/me` is what the whole app boots off — so a
 * failure there must degrade this single flag, never the whole response.
 */

import request from 'supertest';
import express from 'express';
import authRoutes from '../routes/auth';
import { authenticateToken } from '../middleware/auth';
import { userDb, orgDb } from '../services/db';

jest.mock('../middleware/auth');
const mockedAuthenticate = authenticateToken as jest.MockedFunction<typeof authenticateToken>;

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  taskDb: {},
  subscriberDb: {},
  orgDb: { getOrgById: jest.fn() },
}));

jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionType: jest.fn(async () => 'Pro'),
  getAllowedPages: jest.fn(async () => []),
  getAllowedSkills: jest.fn(async () => []),
  getHiddenPages: jest.fn(async () => []),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn(async () => []) },
}));

jest.mock('../services/analyticsConfigResolver', () => ({
  resolveAnalyticsConfig: jest.fn(async () => ({})),
  resolveConfigTarget: jest.fn(async () => ({ canEdit: false })),
}));

const mockedUserDb = userDb as jest.Mocked<typeof userDb>;
const mockedOrgDb = orgDb as jest.Mocked<typeof orgDb>;

const OWNER_ID = 'owner-u';
const MEMBER_ID = 'member-u';
const ORG_ID = 'org-1';

const ownerBrand = { brandData: { brandName: 'Acme' } };
/** Structural fields only — exactly what orgDb.createOrg writes. */
const unCopiedOrg = { orgId: ORG_ID, ownerUserId: OWNER_ID, name: 'Acme' };

const memberRecord = {
  userId: MEMBER_ID,
  email: 'member@test.com',
  orgId: ORG_ID,
  orgRole: 'member',
};

let app: express.Application;

function callAs(userId: string) {
  mockedAuthenticate.mockImplementation(async (req: any, _res: any, next: any) => {
    req.user = { userId };
    next();
    return undefined;
  });
  return request(app).get('/api/auth/me');
}

describe('GET /api/auth/me — hasBrandGuidelines on an un-copied org', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
  });

  afterEach(() => {
    (console.warn as jest.Mock).mockRestore?.();
    (console.error as jest.Mock).mockRestore?.();
  });

  it('stays true for the owner whose brand only lives on their user record', async () => {
    mockedUserDb.getUserById.mockResolvedValue({
      userId: OWNER_ID,
      email: 'owner@test.com',
      orgId: ORG_ID,
      orgRole: 'owner',
      brandGuidelines: ownerBrand,
    } as any);
    mockedOrgDb.getOrgById.mockResolvedValue(unCopiedOrg as any);

    const res = await callAs(OWNER_ID).expect(200);

    expect(res.body.hasBrandGuidelines).toBe(true);
    // The owner short-circuits: no second record read on this hot endpoint.
    expect(mockedUserDb.getUserById).toHaveBeenCalledTimes(1);
  });

  it("reports the owner's brand for a member of the same org", async () => {
    mockedUserDb.getUserById.mockImplementation((async (id: string) =>
      id === MEMBER_ID
        ? memberRecord
        : { userId: OWNER_ID, email: 'owner@test.com', brandGuidelines: ownerBrand }) as any);
    mockedOrgDb.getOrgById.mockResolvedValue(unCopiedOrg as any);

    const res = await callAs(MEMBER_ID).expect(200);

    expect(res.body.hasBrandGuidelines).toBe(true);
  });

  it('is false when neither the org nor the owner has a brand', async () => {
    mockedUserDb.getUserById.mockImplementation((async (id: string) =>
      id === MEMBER_ID ? memberRecord : { userId: OWNER_ID, email: 'owner@test.com' }) as any);
    mockedOrgDb.getOrgById.mockResolvedValue(unCopiedOrg as any);

    const res = await callAs(MEMBER_ID).expect(200);

    expect(res.body.hasBrandGuidelines).toBe(false);
  });

  it('still answers 200 when the owner lookup fails, degrading only the flag', async () => {
    mockedUserDb.getUserById.mockImplementation((async (id: string) => {
      if (id === MEMBER_ID) return memberRecord;
      throw new Error('dynamo down');
    }) as any);
    mockedOrgDb.getOrgById.mockResolvedValue(unCopiedOrg as any);

    const res = await callAs(MEMBER_ID).expect(200);

    expect(res.body.hasBrandGuidelines).toBe(false);
    expect(res.body.orgId).toBe(ORG_ID);
  });

  it('prefers the populated org record without reading the owner', async () => {
    mockedUserDb.getUserById.mockResolvedValue(memberRecord as any);
    mockedOrgDb.getOrgById.mockResolvedValue({
      ...unCopiedOrg,
      brandGuidelines: { brandData: { brandName: 'Acme Org' } },
    } as any);

    const res = await callAs(MEMBER_ID).expect(200);

    expect(res.body.hasBrandGuidelines).toBe(true);
    expect(mockedUserDb.getUserById).toHaveBeenCalledTimes(1);
  });
});
