import request from 'supertest';
import express, { Application } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockAxiosGet = jest.fn();
const mockAxiosPut = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockAxiosGet(...a),
    put: (...a: any[]) => mockAxiosPut(...a),
    isAxiosError: (e: any) => !!e?.response,
  },
  get: (...a: any[]) => mockAxiosGet(...a),
  put: (...a: any[]) => mockAxiosPut(...a),
  isAxiosError: (e: any) => !!e?.response,
}));

const mockResolveSiteForCaller = jest.fn();
const mockGetProjectEnvVars = jest.fn();
const mockUpsertEnvVar = jest.fn();
const mockDeleteEnvVar = jest.fn();
const mockTriggerDeploy = jest.fn();
const mockUpdateLandingPageGtm = jest.fn();
jest.mock('../services/v0Service', () => {
  const actual = jest.requireActual('../services/v0Service');
  return {
    ...actual,
    resolveSiteForCaller: (...a: any[]) => mockResolveSiteForCaller(...a),
    getProjectEnvVars: (...a: any[]) => mockGetProjectEnvVars(...a),
    upsertEnvVar: (...a: any[]) => mockUpsertEnvVar(...a),
    deleteEnvVar: (...a: any[]) => mockDeleteEnvVar(...a),
    triggerVercelDeployment: (...a: any[]) => mockTriggerDeploy(...a),
    updateLandingPageGtm: (...a: any[]) => mockUpdateLandingPageGtm(...a),
  };
});

jest.mock('../utils/secretsManager', () => ({
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: 'gh-test-token' }),
}));

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
      gtmContainerId: 'GTM-TEST1',
    });
    const res = await request(app).get('/api/landing-pages/v0/site');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      rootPageId: 'p1', vercelProjectId: 'vp1',
      githubRepoUrl: 'https://github.com/o/r',
      gtmContainerId: 'GTM-TEST1',
      deployStatus: 'ready',
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

describe('POST /api/landing-pages/v0/site/gtm', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 404 when no site', async () => {
    mockResolveSiteForCaller.mockResolvedValue(null);
    const res = await request(app).post('/api/landing-pages/v0/site/gtm').send({ gtmContainerId: 'GTM-ABCD1' });
    expect(res.status).toBe(404);
  });

  it('returns 400 on invalid GTM container ID', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', vercelProjectId: 'vp1',
      githubRepoUrl: 'https://github.com/o/r', status: 'deployed',
    });
    const res = await request(app).post('/api/landing-pages/v0/site/gtm').send({ gtmContainerId: 'not-valid' });
    expect(res.status).toBe(400);
  });

  it('removes GTM when gtmContainerId is empty string', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', vercelProjectId: 'vp1',
      githubRepoUrl: 'https://github.com/o/r', status: 'deployed',
    });
    const layoutWithGtm = [
      'export default function Layout() {',
      '  return (',
      '    <html>',
      '      <head>',
      '        {/* Google Tag Manager */}',
      '        <script dangerouslySetInnerHTML={{ __html: `old-gtm` }} />',
      '        {/* End Google Tag Manager */}',
      '      </head>',
      '      <body>',
      '        {/* Google Tag Manager (noscript) */}',
      '        <noscript dangerouslySetInnerHTML={{ __html: `old-noscript` }} />',
      '        {/* End Google Tag Manager (noscript) */}',
      '      </body>',
      '    </html>',
      '  );',
      '}',
    ].join('\n');
    mockAxiosGet.mockResolvedValue({
      data: { sha: 'sha1', content: Buffer.from(layoutWithGtm).toString('base64') },
    });
    mockAxiosPut.mockResolvedValue({ data: {} });
    mockUpdateLandingPageGtm.mockResolvedValue(undefined);
    mockTriggerDeploy.mockResolvedValue(undefined);
    const res = await request(app).post('/api/landing-pages/v0/site/gtm').send({ gtmContainerId: '' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    // Verify DynamoDB was called with empty string (signals removal)
    expect(mockUpdateLandingPageGtm).toHaveBeenCalledWith('p1', 'u1', '');
    // Verify the committed content has no GTM blocks
    const committedContent = Buffer.from(mockAxiosPut.mock.calls[0][1].content, 'base64').toString('utf-8');
    expect(committedContent).not.toContain('Google Tag Manager');
  });

  it('returns 400 when GitHub 404s on layout.tsx', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', vercelProjectId: 'vp1',
      githubRepoUrl: 'https://github.com/o/r', status: 'deployed',
    });
    mockAxiosGet.mockRejectedValue({ response: { status: 404 } });
    const res = await request(app).post('/api/landing-pages/v0/site/gtm').send({ gtmContainerId: 'GTM-ABCD1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/app\/layout\.tsx not found/);
  });

  it('happy path → 200', async () => {
    mockResolveSiteForCaller.mockResolvedValue({
      id: 'p1', userId: 'u1', vercelProjectId: 'vp1',
      githubRepoUrl: 'https://github.com/o/r', status: 'deployed',
    });
    mockAxiosGet.mockResolvedValue({
      data: { sha: 'sha1', content: Buffer.from('export default function(){return null}').toString('base64') },
    });
    mockAxiosPut.mockResolvedValue({ data: {} });
    mockUpdateLandingPageGtm.mockResolvedValue(undefined);
    mockTriggerDeploy.mockResolvedValue(undefined);
    const res = await request(app).post('/api/landing-pages/v0/site/gtm').send({ gtmContainerId: 'GTM-ABCD1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, gtmContainerId: 'GTM-ABCD1' });
    expect(mockUpdateLandingPageGtm).toHaveBeenCalled();
  });
});
