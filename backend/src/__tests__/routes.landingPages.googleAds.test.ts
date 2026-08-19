/**
 * ENG-1328 — the manual Google Ads endpoint, the third seam beside /gtm and /meta-pixel.
 *
 * This is the path a customer takes when the conversion action is created AFTER the site
 * was generated, which is the common case: the label only exists once the action exists.
 */
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
const mockUpdateGoogleAds = jest.fn();
const mockUpdateGoogleAdsInstalled = jest.fn();
const mockListLandingPages = jest.fn();
const mockTriggerDeploy = jest.fn();

jest.mock('../services/v0Service', () => {
  const actual = jest.requireActual('../services/v0Service');
  return {
    ...actual,
    getLandingPageById: (...a: any[]) => mockGetLandingPageById(...a),
    updateLandingPageGoogleAds: (...a: any[]) => mockUpdateGoogleAds(...a),
    updateLandingPageGoogleAdsInstalled: (...a: any[]) => mockUpdateGoogleAdsInstalled(...a),
    listLandingPages: (...a: any[]) => mockListLandingPages(...a),
    triggerVercelDeployment: (...a: any[]) => mockTriggerDeploy(...a),
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

const AW = 'AW-18192751758';
const LABEL = 'qAnwCOLmx-McEI65_eJD';
const LAYOUT = 'export default function RootLayout({children}){return <html><head><title>t</title></head><body>{children}</body></html>}';
const validPage = {
  id: 'p1', userId: 'u1', siteId: 'p1',
  githubRepoUrl: 'https://github.com/owner/repo',
  vercelProjectId: 'vp1', status: 'deployed',
};
const post = (body: any) =>
  request(app).post('/api/landing-pages/v0/generated/p1/google-ads').send(body);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLandingPageById.mockResolvedValue(validPage);
  mockUpdateGoogleAds.mockResolvedValue(undefined);
  mockUpdateGoogleAdsInstalled.mockResolvedValue(undefined);
  mockListLandingPages.mockResolvedValue([validPage, { ...validPage, id: 'p2' }]);
  mockTriggerDeploy.mockResolvedValue(undefined);
  mockAxiosGet.mockResolvedValue({
    data: { sha: 'sha1', content: Buffer.from(LAYOUT).toString('base64') },
  });
  mockAxiosPut.mockResolvedValue({ data: {} });
});

describe('POST /generated/:id/google-ads — rejects before writing', () => {
  it('refuses a missing conversion id', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect(mockAxiosPut).not.toHaveBeenCalled();
  });

  it('refuses a malformed conversion id rather than installing a dead tag', async () => {
    // Must match RULE 7.5's own detector, or we would install a tag the pre-flight
    // gate cannot see and the launch would be blocked anyway.
    for (const bad of ['AW-123', 'GTM-ABCD123', 'G-ABC123', '18192751758', 'AW-abcdefgh']) {
      const res = await post({ googleAdsConversionId: bad });
      expect(res.status).toBe(400);
    }
    expect(mockAxiosPut).not.toHaveBeenCalled();
  });
});

describe('POST /generated/:id/google-ads — install', () => {
  it('installs the tag, persists the config and redeploys', async () => {
    const res = await post({
      googleAdsConversionId: AW, googleAdsConversionLabel: LABEL, googleAdsCustomerId: '2883029950',
    });
    expect(res.status).toBe(200);
    expect(res.body.googleAdsConversionId).toBe(AW);
    expect(mockAxiosPut).toHaveBeenCalledTimes(1);
    expect(mockUpdateGoogleAds).toHaveBeenCalledWith('p1', 'u1', AW, LABEL, '2883029950');
    expect(mockTriggerDeploy).toHaveBeenCalled();
  });

  it('commits a layout that actually verifies', async () => {
    await post({ googleAdsConversionId: AW, googleAdsConversionLabel: LABEL });
    const committed = Buffer.from(mockAxiosPut.mock.calls[0][1].content, 'base64').toString('utf-8');
    expect(committed).toContain('{/* Google Ads Tag */}');
    expect(committed).toContain(`gtag('config', '${AW}')`);
  });

  it('warns — but still installs — when no conversion label is given', async () => {
    // The base tag is installable without a label, but nothing can be attributed until
    // one exists. Refusing would block the common "create the action next" flow.
    const res = await post({ googleAdsConversionId: AW });
    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/label/i);
  });

  it('syncs the installed flag across every sibling on the site', async () => {
    // The base tag lives in the SHARED layout, so this commit changed the answer for
    // every page. Stale siblings would have RULE 7.5 refuse a measurable page.
    await post({ googleAdsConversionId: AW, googleAdsConversionLabel: LABEL });
    expect(mockUpdateGoogleAdsInstalled).toHaveBeenCalledWith('p1', true);
    expect(mockUpdateGoogleAdsInstalled).toHaveBeenCalledWith('p2', true);
  });

  it('does not re-commit when the layout already carries this exact tag', async () => {
    const { injectGoogleAdsIntoLayout } = jest.requireActual('../utils/googleAdsInjection');
    mockAxiosGet.mockResolvedValue({
      data: { sha: 'sha1', content: Buffer.from(injectGoogleAdsIntoLayout(LAYOUT, AW)).toString('base64') },
    });
    const res = await post({ googleAdsConversionId: AW, googleAdsConversionLabel: LABEL });
    expect(res.status).toBe(200);
    expect(mockAxiosPut).not.toHaveBeenCalled();
  });
});

describe('POST /generated/:id/google-ads — removal and failure', () => {
  it('an empty id removes the tag and clears the flag on every sibling', async () => {
    const { injectGoogleAdsIntoLayout } = jest.requireActual('../utils/googleAdsInjection');
    mockAxiosGet.mockResolvedValue({
      data: { sha: 'sha1', content: Buffer.from(injectGoogleAdsIntoLayout(LAYOUT, AW)).toString('base64') },
    });
    const res = await post({ googleAdsConversionId: '' });
    expect(res.status).toBe(200);
    expect(mockUpdateGoogleAdsInstalled).toHaveBeenCalledWith('p1', false);
    const committed = Buffer.from(mockAxiosPut.mock.calls[0][1].content, 'base64').toString('utf-8');
    expect(committed).not.toContain('Google Ads Tag');
  });

  it('422s without committing when the layout has no anchor', async () => {
    // The silent-success shape: without verify we would commit unchanged content and
    // still report the tag installed.
    mockAxiosGet.mockResolvedValue({
      data: { sha: 'sha1', content: Buffer.from('export default function L(){return null}').toString('base64') },
    });
    const res = await post({ googleAdsConversionId: AW, googleAdsConversionLabel: LABEL });
    expect(res.status).toBe(422);
    expect(mockAxiosPut).not.toHaveBeenCalled();
    expect(mockUpdateGoogleAds).not.toHaveBeenCalled();
  });

  it('never leaks layout internals to the customer', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { sha: 'sha1', content: Buffer.from('export default function L(){return null}').toString('base64') },
    });
    const res = await post({ googleAdsConversionId: AW });
    expect(res.body.error).not.toMatch(/layout\.tsx|<head>|<body>/);
  });

  it('400s when the repo has no layout at all', async () => {
    mockAxiosGet.mockRejectedValue({ response: { status: 404 } });
    const res = await post({ googleAdsConversionId: AW });
    expect(res.status).toBe(400);
  });

  it('retries a 409 SHA race and re-fetches the SHA each time', async () => {
    mockAxiosPut
      .mockRejectedValueOnce({ response: { status: 409 } })
      .mockResolvedValueOnce({ data: {} });
    const res = await post({ googleAdsConversionId: AW, googleAdsConversionLabel: LABEL });
    expect(res.status).toBe(200);
    expect(mockAxiosPut).toHaveBeenCalledTimes(2);
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
  });

  it('a sibling sync failure does not undo the commit that already succeeded', async () => {
    mockUpdateGoogleAdsInstalled.mockRejectedValue(new Error('dynamo down'));
    const res = await post({ googleAdsConversionId: AW, googleAdsConversionLabel: LABEL });
    expect(res.status).toBe(200);
    expect(mockAxiosPut).toHaveBeenCalledTimes(1);
  });
});
