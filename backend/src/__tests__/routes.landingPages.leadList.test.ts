import request from 'supertest';
import express, { Application } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockGetLandingPageById = jest.fn();
const mockUpdateLeadList = jest.fn();
const mockGetLeadListById = jest.fn();
const mockUpdateLeadListRecord = jest.fn();
const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockCanEditItem = jest.fn();
const mockSyncLeadCapture = jest.fn();
const mockGetPagesByOwner = jest.fn();

jest.mock('../services/v0Service', () => {
  const actual = jest.requireActual('../services/v0Service');
  return {
    ...actual,
    getLandingPageById: (...a: any[]) => mockGetLandingPageById(...a),
    updateLandingPageLeadList: (...a: any[]) => mockUpdateLeadList(...a),
    syncLeadCaptureFilesToRepo: (...a: any[]) => mockSyncLeadCapture(...a),
    getLandingPagesByOwner: (...a: any[]) => mockGetPagesByOwner(...a),
  };
});

jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrgById(...a) },
  crmDb: {
    getLeadListById: (...a: any[]) => mockGetLeadListById(...a),
    updateLeadList: (...a: any[]) => mockUpdateLeadListRecord(...a),
  },
}));

jest.mock('../services/orgShareService', () => ({
  canEditItem: (...a: any[]) => mockCanEditItem(...a),
  canViewItem: (...a: any[]) => mockCanEditItem(...a),
  canManageOrgFeature: jest.fn().mockReturnValue(false),
  isFeatureEffectivelyEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _r: any, n: any) => { req.user = { userId: 'u1' }; n(); },
}));

jest.mock('../utils/secretsManager', () => ({
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: 'gh-test-token' }),
}));

import router from '../routes/landingPageGeneration';
const app: Application = express();
app.use(express.json());
app.use('/api/landing-pages/v0', router);

const ownedPage = { id: 'p1', userId: 'u1' };

describe('PATCH /generated/:id/lead-list', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLandingPageById.mockResolvedValue(ownedPage);
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    mockUpdateLeadList.mockResolvedValue(undefined);
    mockUpdateLeadListRecord.mockResolvedValue(undefined);
  });

  it('happy path: sets leadListId', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1' });
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });
    expect(res.status).toBe(200);
    expect(mockUpdateLeadList).toHaveBeenCalledWith('p1', 'u1', 'l1');
  });

  it('happy path: detach (leadListId: null)', async () => {
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: null });
    expect(res.status).toBe(200);
    expect(mockUpdateLeadList).toHaveBeenCalledWith('p1', 'u1', null);
  });

  it('400 when body missing leadListId', async () => {
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({});
    expect(res.status).toBe(400);
  });

  it('403 when caller cannot edit page', async () => {
    mockGetLandingPageById.mockResolvedValue({ id: 'p1', userId: 'u2' });
    mockGetUserById
      .mockResolvedValueOnce({ userId: 'u1' })
      .mockResolvedValueOnce({ userId: 'u2' });
    mockCanEditItem.mockReturnValue(false);
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });
    expect(res.status).toBe(403);
  });

  it('403 when lead list belongs to someone else', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u99' });
    mockGetUserById
      .mockResolvedValueOnce({ userId: 'u1' })
      .mockResolvedValueOnce({ userId: 'u99' });
    mockCanEditItem.mockReturnValue(false);
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });
    expect(res.status).toBe(403);
  });

  it('404 when page not found', async () => {
    mockGetLandingPageById.mockResolvedValue(null);
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });
    expect(res.status).toBe(404);
  });

  it('409 on ConditionalCheckFailedException', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1' });
    mockUpdateLeadList.mockRejectedValue(Object.assign(new Error('cond fail'), { code: 'ConditionalCheckFailedException' }));
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });
    expect(res.status).toBe(409);
  });
});

/**
 * ENG-967: attaching a lead list has to make that list actually able to RECEIVE the
 * page's submissions. The generated capture route posts to /api/webhooks/forward-lead,
 * which 403s any list with publicAccessEnabled !== true — and the visitor still sees a
 * success screen. Binding without enabling is a page that reports "saving leads to X"
 * while dropping every single one, indefinitely.
 */
describe('PATCH /generated/:id/lead-list — public submissions on the attached list (ENG-967)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLandingPageById.mockResolvedValue(ownedPage);
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    mockUpdateLeadList.mockResolvedValue(undefined);
    mockUpdateLeadListRecord.mockResolvedValue(undefined);
  });

  it('FAIL CASE: attaching a private list enables public access on it', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1', publicAccessEnabled: false });

    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });

    expect(res.status).toBe(200);
    expect(mockUpdateLeadListRecord).toHaveBeenCalledWith('l1', { publicAccessEnabled: true });
  });

  it('FAIL CASE: a list with publicAccessEnabled entirely absent is still enabled', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1' });

    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });

    expect(res.status).toBe(200);
    expect(mockUpdateLeadListRecord).toHaveBeenCalledWith('l1', { publicAccessEnabled: true });
  });

  it('FAIL CASE: the enabling write failing is reported, not swallowed as a clean save', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1', publicAccessEnabled: false });
    mockUpdateLeadListRecord.mockRejectedValue(new Error('dynamo blip'));

    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });

    // The page IS bound (the DynamoDB write already happened), so this is a 200 with a
    // warning — never a silent success.
    expect(res.status).toBe(200);
    expect(res.body.captureSyncWarning).toEqual(expect.stringContaining('public'));
    expect(res.body.warnings).toEqual([expect.stringContaining('public')]);
  });

  it('SUCCESS: an already-public list is not re-written', async () => {
    mockGetLeadListById.mockResolvedValue({ listId: 'l1', userId: 'u1', publicAccessEnabled: true });

    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: 'l1' });

    expect(res.status).toBe(200);
    expect(mockUpdateLeadListRecord).not.toHaveBeenCalled();
    expect(res.body.captureSyncWarning).toBeUndefined();
    expect(res.body.warnings).toBeUndefined();
  });

  it('SUCCESS: detaching (null) never flips any list public', async () => {
    const res = await request(app).patch('/api/landing-pages/v0/generated/p1/lead-list').send({ leadListId: null });

    expect(res.status).toBe(200);
    expect(mockUpdateLeadListRecord).not.toHaveBeenCalled();
  });
});


// ─── ENG-449: the captureRouteSkipped warning ────────────────────────────────
//
// `captureRouteSkipped` means the deployed LIST_BY_PATH could not be parsed, so route.ts was
// left out of the commit ENTIRELY — it still carries the OLD mapping. What that means for the
// owner depends on what they just did, and the three cases are opposites. Untested until now:
// disabling the whole branch left 255 tests green.
describe('PATCH /generated/:id/lead-list — captureRouteSkipped warning (ENG-449)', () => {
  const deployedPage = {
    id: 'p1',
    userId: 'u1',
    slug: 'pricing',
    githubRepoUrl: 'https://github.com/AgentWebPro/lp-site-abc',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    mockUpdateLeadList.mockResolvedValue(undefined);
    mockUpdateLeadListRecord.mockResolvedValue(undefined);
    mockGetLeadListById.mockResolvedValue({ listId: 'l2', userId: 'u1' });
    mockGetPagesByOwner.mockResolvedValue([]);
    mockSyncLeadCapture.mockResolvedValue({
      committed: true,
      captureRouteSkipped: true,
      pushedCommitSha: 'abc1234',
    });
  });

  it('DETACH: says leads KEEP being filed into the list just removed', async () => {
    mockGetLandingPageById.mockResolvedValue({ ...deployedPage, leadListId: 'l1' });
    const res = await request(app)
      .patch('/api/landing-pages/v0/generated/p1/lead-list')
      .send({ leadListId: null });

    expect(res.status).toBe(200);
    expect(res.body.captureSyncWarning).toMatch(/Lead list removed/);
    expect(res.body.captureSyncWarning).toMatch(/KEEP being filed into the list you just removed/);
    expect(res.body.captureSyncWarning).not.toMatch(/will not be filed/);
  });

  it('FIRST ATTACH: says leads will not be filed until the route is repaired', async () => {
    mockGetLandingPageById.mockResolvedValue({ ...deployedPage, leadListId: undefined });
    const res = await request(app)
      .patch('/api/landing-pages/v0/generated/p1/lead-list')
      .send({ leadListId: 'l2' });

    expect(res.status).toBe(200);
    expect(res.body.captureSyncWarning).toMatch(/lead list was saved/i);
    expect(res.body.captureSyncWarning).toMatch(/will not be filed until the route is repaired/);
    expect(res.body.captureSyncWarning).not.toMatch(/KEEP being filed/);
  });

  // The case the detach fix originally missed. A switch is not a first attach: the deployed
  // route still maps this path to list A, so submissions keep arriving — into the WRONG list,
  // silently. "Will not be filed" is wrong in the same direction the detach arm was wrong.
  it('RE-ATTACH: says leads KEEP being filed into the PREVIOUS list', async () => {
    mockGetLandingPageById.mockResolvedValue({ ...deployedPage, leadListId: 'l1' });
    const res = await request(app)
      .patch('/api/landing-pages/v0/generated/p1/lead-list')
      .send({ leadListId: 'l2' });

    expect(res.status).toBe(200);
    expect(res.body.captureSyncWarning).toMatch(/KEEP being filed into the previously attached list/);
    expect(res.body.captureSyncWarning).not.toMatch(/will not be filed/);
  });

  it('no warning when the capture route was written', async () => {
    mockGetLandingPageById.mockResolvedValue({ ...deployedPage, leadListId: 'l1' });
    mockSyncLeadCapture.mockResolvedValue({ committed: true, pushedCommitSha: 'abc1234' });
    const res = await request(app)
      .patch('/api/landing-pages/v0/generated/p1/lead-list')
      .send({ leadListId: 'l2' });

    expect(res.status).toBe(200);
    expect(res.body.captureSyncWarning).toBeUndefined();
  });
});
