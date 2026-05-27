import request from 'supertest';
import express, { Application } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockResolveSiteForCaller = jest.fn();
const mockGetProjectEnvVars = jest.fn();
const mockUpsertEnvVar = jest.fn();
const mockDeleteEnvVar = jest.fn();
const mockTriggerDeploy = jest.fn();
jest.mock('../services/v0Service', () => {
  const actual = jest.requireActual('../services/v0Service');
  return {
    ...actual,
    resolveSiteForCaller: (...a: any[]) => mockResolveSiteForCaller(...a),
    getProjectEnvVars: (...a: any[]) => mockGetProjectEnvVars(...a),
    upsertEnvVar: (...a: any[]) => mockUpsertEnvVar(...a),
    deleteEnvVar: (...a: any[]) => mockDeleteEnvVar(...a),
    triggerVercelDeployment: (...a: any[]) => mockTriggerDeploy(...a),
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

describe('GET /api/landing-pages/v0/site/integrations', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 404 when no site', async () => {
    mockResolveSiteForCaller.mockResolvedValue(null);
    const res = await request(app).get('/api/landing-pages/v0/site/integrations');
    expect(res.status).toBe(404);
  });

  it('returns integrations payload for the resolved site', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', vercelProjectId: 'vp1', status: 'deployed',
      githubRepoUrl: 'https://github.com/o/r',
    });
    mockGetProjectEnvVars.mockResolvedValue({
      NEXT_PUBLIC_RECAPTCHA_SITE_KEY: { ids: ['e1'], id: 'e1', value: 'sk1', type: 'plain' },
      RECAPTCHA_SECRET_KEY: { ids: ['e2'], id: 'e2', value: 'secret', type: 'encrypted' },
      MY_CUSTOM: { ids: ['e3'], id: 'e3', value: 'val', type: 'plain' },
    });
    const res = await request(app).get('/api/landing-pages/v0/site/integrations');
    expect(res.status).toBe(200);
    expect(res.body.recaptcha.siteKey).toBe('sk1');
    expect(res.body.recaptcha.secretKeyIsSet).toBe(true);
    expect(Array.isArray(res.body.custom)).toBe(true);
  });

  it('returns empty custom array when no custom env vars exist', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', vercelProjectId: 'vp1', status: 'deployed',
      githubRepoUrl: 'https://github.com/o/r',
    });
    mockGetProjectEnvVars.mockResolvedValue({});
    const res = await request(app).get('/api/landing-pages/v0/site/integrations');
    expect(res.status).toBe(200);
    expect(res.body.recaptcha.siteKey).toBe('');
    expect(res.body.recaptcha.secretKeyIsSet).toBe(false);
    expect(res.body.custom).toEqual([]);
  });

  it('returns 500 on unexpected error', async () => {
    mockResolveSiteForCaller.mockRejectedValue(new Error('db failure'));
    const res = await request(app).get('/api/landing-pages/v0/site/integrations');
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/landing-pages/v0/site/integrations', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 404 when no site', async () => {
    mockResolveSiteForCaller.mockResolvedValue(null);
    const res = await request(app).put('/api/landing-pages/v0/site/integrations').send({ recaptcha: {}, custom: [] });
    expect(res.status).toBe(404);
  });

  it('saves integrations: calls upsertEnvVar and returns updated payload', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', vercelProjectId: 'vp1', status: 'deployed',
      githubRepoUrl: 'https://github.com/o/r',
    });
    mockGetProjectEnvVars.mockResolvedValue({});
    mockUpsertEnvVar.mockResolvedValue(undefined);
    mockDeleteEnvVar.mockResolvedValue(undefined);
    mockTriggerDeploy.mockResolvedValue(undefined);
    const res = await request(app).put('/api/landing-pages/v0/site/integrations')
      .send({ recaptcha: { siteKey: 'newsk' }, custom: [{ key: 'FOO', value: 'bar' }] });
    expect(res.status).toBe(200);
    expect(mockUpsertEnvVar).toHaveBeenCalled();
  });

  it('triggers redeployment after saving env vars', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', vercelProjectId: 'vp1', status: 'deployed',
      githubRepoUrl: 'https://github.com/o/r',
    });
    mockGetProjectEnvVars.mockResolvedValue({});
    mockUpsertEnvVar.mockResolvedValue(undefined);
    mockTriggerDeploy.mockResolvedValue(undefined);
    await request(app).put('/api/landing-pages/v0/site/integrations')
      .send({ recaptcha: { siteKey: 'newsk' } });
    expect(mockTriggerDeploy).toHaveBeenCalledWith('vp1', 'o/r');
  });

  it('returns 500 on unexpected error', async () => {
    mockResolveSiteForCaller.mockRejectedValue(new Error('db failure'));
    const res = await request(app).put('/api/landing-pages/v0/site/integrations')
      .send({ recaptcha: {} });
    expect(res.status).toBe(500);
  });
});
