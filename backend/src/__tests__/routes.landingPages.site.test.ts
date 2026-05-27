import request from 'supertest';
import express, { Application } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockResolveSiteForCaller = jest.fn();
jest.mock('../services/v0Service', () => {
  const actual = jest.requireActual('../services/v0Service');
  return {
    ...actual,
    resolveSiteForCaller: (...a: any[]) => mockResolveSiteForCaller(...a),
  };
});

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn().mockResolvedValue({ userId: 'u1' }) },
  orgDb: { getOrgById: jest.fn() },
  crmDb: {},
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _r: any, n: any) => { req.user = { userId: 'u1' }; n(); },
}));

import router from '../routes/landingPageGeneration';
const app: Application = express();
app.use(express.json());
app.use('/api/landing-pages/v0', router);

describe('GET /api/landing-pages/v0/site', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 404 with deployStatus no_site when no root page', async () => {
    mockResolveSiteForCaller.mockResolvedValue(null);
    const res = await request(app).get('/api/landing-pages/v0/site');
    expect(res.status).toBe(404);
    expect(res.body.deployStatus).toBe('no_site');
  });

  it('returns ready when both vercelProjectId and githubRepoUrl present', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', status: 'deployed',
      vercelProjectId: 'vp1', githubRepoUrl: 'https://github.com/o/r',
    });
    const res = await request(app).get('/api/landing-pages/v0/site');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rootPageId: 'p1', vercelProjectId: 'vp1',
      githubRepoUrl: 'https://github.com/o/r', deployStatus: 'ready',
    });
  });

  it('returns deploying when site exists but vercelProjectId missing', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', status: 'deploying',
      githubRepoUrl: 'https://github.com/o/r',
    });
    const res = await request(app).get('/api/landing-pages/v0/site');
    expect(res.status).toBe(200);
    expect(res.body.deployStatus).toBe('deploying');
  });

  it('returns failed when root page status === failed', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', status: 'failed',
    });
    const res = await request(app).get('/api/landing-pages/v0/site');
    expect(res.status).toBe(200);
    expect(res.body.deployStatus).toBe('failed');
  });
});
