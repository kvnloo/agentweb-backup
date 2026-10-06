/**
 * ENG-2327 — POST|DELETE /api/landing-pages/v0/generated/:id/session-tracking.
 *
 * Auth runs through the REAL authorizeLandingPageAccess + orgShareService (only the user/org
 * stores are mocked); the session-tracking service itself is mocked, its own behaviour is in
 * sessionTrackingService.test.ts. Covers: edit authorization and the "never touch a page the caller
 * cannot edit" rule, request validation, response shape, error mapping and the shared edit rate limit.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockGetLandingPageById = jest.fn();
const mockEnable = jest.fn();
const mockDisable = jest.fn();
const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();

jest.mock('../services/sessionTrackingService', () => {
  class SessionTrackingError extends Error {
    constructor(public code: string, message: string, public httpStatus: number = 422) { super(message); }
  }
  return {
    SessionTrackingError,
    enableSessionTrackingForPage: (...a: any[]) => mockEnable(...a),
    disableSessionTrackingForPage: (...a: any[]) => mockDisable(...a),
  };
});
jest.mock('../services/v0Service', () => ({
  ...jest.requireActual('../services/v0Service'),
  getLandingPageById: (...a: any[]) => mockGetLandingPageById(...a),
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrgById(...a) },
  crmDb: {},
}));
// The caller is chosen per request by header, so one app serves every actor.
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const u = req.headers['x-test-user'];
    if (!u) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { userId: u };
    next();
  },
}));

import request from 'supertest';
import express from 'express';
import router, { _resetRateLimitState } from '../routes/landingPageGeneration';
import { SessionTrackingError } from '../services/sessionTrackingService';

const app = express();
app.use(express.json());
app.use('/api/landing-pages/v0', router);

const URL = '/api/landing-pages/v0/generated/page-1/session-tracking';
const PAGE = { id: 'page-1', userId: 'owner', name: 'Spring', status: 'deployed', githubRepoUrl: 'https://github.com/o/r' };
const RESULT = {
  listId: 'list_abc_123456', embedSnippet: '<script ...>', installed: true, alreadyInstalled: false,
  listCreated: true, path: 'app/layout.tsx', allowedOrigins: ['https://a.example.com'],
};
const users: Record<string, any> = {
  owner: { userId: 'owner', orgId: 'org1', orgRole: 'owner' },
  editor: { userId: 'editor', orgId: 'org1', orgRole: 'member' },
  viewer: { userId: 'viewer', orgId: 'org1', orgRole: 'member' },
  outsider: { userId: 'outsider' },
  otherorg: { userId: 'otherorg', orgId: 'org2', orgRole: 'owner' },
};

beforeEach(() => {
  jest.resetAllMocks();
  _resetRateLimitState();
  mockGetLandingPageById.mockResolvedValue(PAGE);
  mockGetUserById.mockImplementation(async (id: string) => users[id] ?? null);
  mockGetOrgById.mockImplementation(async (id: string) =>
    id === 'org1'
      ? { orgId: 'org1', ownerUserId: 'owner', shareSettings: { landingPages: { enabled: true, editors: ['editor'] } } }
      : null);
  mockEnable.mockResolvedValue(RESULT);
  mockDisable.mockResolvedValue({ removed: true, alreadyRemoved: false, listId: RESULT.listId, path: 'app/layout.tsx' });
});

describe('POST /generated/:id/session-tracking — authorization', () => {
  it('401 without a user', async () => {
    const res = await request(app).post(URL).send({});
    expect(res.status).toBe(401);
    expect(mockEnable).not.toHaveBeenCalled();
  });

  it('the page owner may enable', async () => {
    const res = await request(app).post(URL).set('x-test-user', 'owner').send({});
    expect(res.status).toBe(200);
    expect(mockEnable).toHaveBeenCalledWith(PAGE, { overrideExistingTracker: false });
  });

  it('a listed org editor may enable', async () => {
    const res = await request(app).post(URL).set('x-test-user', 'editor').send({});
    expect(res.status).toBe(200);
    expect(mockEnable).toHaveBeenCalledTimes(1);
  });

  it.each(['viewer', 'outsider', 'otherorg'])('%s cannot edit: 403 and the service is never called', async (who) => {
    const res = await request(app).post(URL).set('x-test-user', who).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Not authorized to edit/);
    expect(mockEnable).not.toHaveBeenCalled();
  });

  it('404 for a page that does not exist; the service is never called', async () => {
    mockGetLandingPageById.mockResolvedValue(null);
    const res = await request(app).post(URL).set('x-test-user', 'owner').send({});
    expect(res.status).toBe(404);
    expect(mockEnable).not.toHaveBeenCalled();
  });

  it('the page handed to the service is the one loaded by id, never anything from the request body', async () => {
    await request(app).post(URL).set('x-test-user', 'owner').send({ page: { id: 'other', userId: 'owner', githubRepoUrl: 'https://github.com/evil/repo' }, githubRepoUrl: 'https://github.com/evil/repo' });
    expect(mockEnable.mock.calls[0][0]).toBe(PAGE);
  });
});

describe('POST /generated/:id/session-tracking — behaviour', () => {
  it('returns { listId, embedSnippet, installed, alreadyInstalled } and passes the explicit override through', async () => {
    const res = await request(app).post(URL).set('x-test-user', 'owner').send({ overrideExistingTracker: true, htmlPath: 'public/offer.html' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, listId: RESULT.listId, embedSnippet: RESULT.embedSnippet, installed: true, alreadyInstalled: false });
    expect(mockEnable).toHaveBeenCalledWith(PAGE, { overrideExistingTracker: true, htmlPath: 'public/offer.html' });
  });

  it('an idempotent repeat reports alreadyInstalled with a matching message', async () => {
    mockEnable.mockResolvedValue({ ...RESULT, alreadyInstalled: true, listCreated: false });
    const res = await request(app).post(URL).set('x-test-user', 'owner').send({});
    expect(res.status).toBe(200);
    expect(res.body.alreadyInstalled).toBe(true);
    expect(res.body.message).toMatch(/already installed/);
  });

  it('only a literal true overrides: "true" / 1 are rejected as 400', async () => {
    for (const bad of ['true', 1, {}]) {
      const res = await request(app).post(URL).set('x-test-user', 'owner').send({ overrideExistingTracker: bad });
      expect(res.status).toBe(400);
    }
    expect((await request(app).post(URL).set('x-test-user', 'owner').send({ htmlPath: 5 })).status).toBe(400);
    expect(mockEnable).not.toHaveBeenCalled();
  });

  it('maps a refusal to its own status with a stable code (existing tracker -> 409)', async () => {
    mockEnable.mockRejectedValue(new SessionTrackingError('existing_tracker', 'This page already carries its own tracker', 409));
    const res = await request(app).post(URL).set('x-test-user', 'owner').send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'This page already carries its own tracker', code: 'existing_tracker' });
  });

  it('maps an unexpected failure to 500 with the reason', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockEnable.mockRejectedValue(Object.assign(new Error('socket hang up'), { response: { status: 502, data: { message: 'Bad gateway' } } }));
    const res = await request(app).post(URL).set('x-test-user', 'owner').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Bad gateway/);
    spy.mockRestore();
  });

  it('maps a GitHub timeout to 504', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockEnable.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
    expect((await request(app).post(URL).set('x-test-user', 'owner').send({})).status).toBe(504);
    spy.mockRestore();
  });

  it('is rate limited like its siblings: the 61st edit-limiter request in the window gets 429', async () => {
    for (let i = 0; i < 60; i++) {
      const ok = await request(app).post(URL).set('x-test-user', 'owner').send({});
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).post(URL).set('x-test-user', 'owner').send({});
    expect(limited.status).toBe(429);
    expect(limited.body.retry_after_seconds).toBeGreaterThan(0);
    expect(mockEnable).toHaveBeenCalledTimes(60);
  });
});

describe('DELETE /generated/:id/session-tracking', () => {
  it('owner disables: removes the tag, says the list was kept', async () => {
    const res = await request(app).delete(URL).set('x-test-user', 'owner');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, removed: true, alreadyRemoved: false, listId: RESULT.listId });
    expect(res.body.message).toMatch(/list and its history were kept/);
    expect(mockDisable).toHaveBeenCalledWith(PAGE, { htmlPath: undefined });
  });

  it('passes htmlPath from the query string', async () => {
    await request(app).delete(`${URL}?htmlPath=public/offer.html`).set('x-test-user', 'owner');
    expect(mockDisable).toHaveBeenCalledWith(PAGE, { htmlPath: 'public/offer.html' });
  });

  it.each(['viewer', 'outsider', 'otherorg'])('%s cannot disable: 403, service never called', async (who) => {
    const res = await request(app).delete(URL).set('x-test-user', who);
    expect(res.status).toBe(403);
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it('401 without a user; 404 for a missing page', async () => {
    expect((await request(app).delete(URL)).status).toBe(401);
    mockGetLandingPageById.mockResolvedValue(null);
    expect((await request(app).delete(URL).set('x-test-user', 'owner')).status).toBe(404);
    expect(mockDisable).not.toHaveBeenCalled();
  });

  it('maps service refusals', async () => {
    mockDisable.mockRejectedValue(new SessionTrackingError('external_page', 'Imported pages are not managed', 400));
    const res = await request(app).delete(URL).set('x-test-user', 'owner');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('external_page');
  });
});
