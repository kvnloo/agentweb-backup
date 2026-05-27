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

const mockGetLandingPageById = jest.fn();
const mockUpdateLandingPageGtm = jest.fn();
const mockTriggerDeploy = jest.fn();

jest.mock('../services/v0Service', () => {
  const actual = jest.requireActual('../services/v0Service');
  return {
    ...actual,
    getLandingPageById: (...a: any[]) => mockGetLandingPageById(...a),
    updateLandingPageGtm: (...a: any[]) => mockUpdateLandingPageGtm(...a),
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

const validPage = {
  id: 'p1', userId: 'u1',
  githubRepoUrl: 'https://github.com/owner/repo',
  vercelProjectId: 'vp1', status: 'deployed',
};

describe('POST /generated/:id/gtm — 409 retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLandingPageById.mockResolvedValue(validPage);
    mockUpdateLandingPageGtm.mockResolvedValue(undefined);
    mockTriggerDeploy.mockResolvedValue(undefined);
    mockAxiosGet.mockResolvedValue({
      data: {
        sha: 'sha1',
        content: Buffer.from('export default function RootLayout({children}){return <html><body>{children}</body></html>}').toString('base64'),
      },
    });
  });

  it('succeeds on first attempt when no conflict', async () => {
    mockAxiosPut.mockResolvedValueOnce({ data: {} });
    const res = await request(app)
      .post('/api/landing-pages/v0/generated/p1/gtm')
      .send({ gtmContainerId: 'GTM-ABCD1' });
    expect([200, 201]).toContain(res.status);
    expect(mockAxiosPut).toHaveBeenCalledTimes(1);
  });

  it('retries on 409 and succeeds on attempt 2', async () => {
    mockAxiosPut
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce({ data: {} });
    const res = await request(app)
      .post('/api/landing-pages/v0/generated/p1/gtm')
      .send({ gtmContainerId: 'GTM-ABCD1' });
    expect([200, 201]).toContain(res.status);
    expect(mockAxiosPut).toHaveBeenCalledTimes(2);
    expect(mockAxiosGet).toHaveBeenCalledTimes(2); // re-fetches SHA each iteration
  });

  it('surfaces 500 after 3 consecutive 409s', async () => {
    mockAxiosPut.mockRejectedValue({ response: { status: 409 } });
    const res = await request(app)
      .post('/api/landing-pages/v0/generated/p1/gtm')
      .send({ gtmContainerId: 'GTM-ABCD1' });
    expect(res.status).toBe(500);
    expect(mockAxiosPut).toHaveBeenCalledTimes(3);
  });
});
