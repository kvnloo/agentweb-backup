import request from 'supertest';
import express, { Application } from 'express';

process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

const mockGetByOwner = jest.fn();
const mockGetByOrg = jest.fn();
const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockCanEditItem = jest.fn().mockReturnValue(true);

jest.mock('../services/v0Service', () => {
  const actual = jest.requireActual('../services/v0Service');
  return {
    ...actual,
    getLandingPagesByOwner: (...a: any[]) => mockGetByOwner(...a),
    getLandingPagesByOrg: (...a: any[]) => mockGetByOrg(...a),
  };
});

jest.mock('../services/db', () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrgById(...a) },
  crmDb: {},
}));

jest.mock('../services/orgShareService', () => ({
  canEditItem: (...a: any[]) => mockCanEditItem(...a),
  canViewItem: (...a: any[]) => mockCanEditItem(...a),
  canManageOrgFeature: jest.fn().mockReturnValue(false),
  isFeatureEffectivelyEnabled: jest.fn().mockReturnValue(false),
}));

jest.mock('../services/customDomainService', () => ({
  listDomains: jest.fn().mockResolvedValue([]),
  SUBDOMAIN_BASE: 'agentwebforms.com',
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

const builderPage = {
  id: 'p-builder', userId: 'u1', name: 'Builder', status: 'deployed',
  deployedUrl: 'https://x.agentwebforms.com', vercelProjectId: 'vp1',
};
const externalPage = {
  id: 'p-ext', userId: 'u1', name: 'AI Readiness Roadmap', status: 'deployed',
  sourceType: 'external', canonicalUrl: 'https://www.hireemma.ai/ai-readiness-roadmap',
  deployedUrl: 'https://www.hireemma.ai/ai-readiness-roadmap',
  repoRef: 'AgentWebPro/agentweb-landing-page', leadListId: 'list_1786727568488_vchiqixf5',
};

describe('ENG-1238 AC3: list surface marks external imports', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanEditItem.mockReturnValue(true);
    mockGetUserById.mockResolvedValue({ userId: 'u1' });
    mockGetOrgById.mockResolvedValue(null);
    mockGetByOwner.mockResolvedValue([builderPage, externalPage]);
    mockGetByOrg.mockResolvedValue([]);
  });

  test('FAIL-1: external record is flagged isExternalImport=true, builder record is false', async () => {
    const res = await request(app).get('/api/landing-pages/v0/generated').expect(200);
    const byId = Object.fromEntries(res.body.pages.map((p: any) => [p.id, p]));
    expect(byId['p-ext'].isExternalImport).toBe(true);
    expect(byId['p-builder'].isExternalImport).toBe(false);
  });

  test('FAIL-2: external record resolves a live URL from canonicalUrl', async () => {
    const res = await request(app).get('/api/landing-pages/v0/generated').expect(200);
    const ext = res.body.pages.find((p: any) => p.id === 'p-ext');
    expect(ext.customDomainUrl).toBe('https://www.hireemma.ai/ai-readiness-roadmap');
  });

  test('PASS-unchanged: builder record customDomainUrl untouched', async () => {
    const res = await request(app).get('/api/landing-pages/v0/generated').expect(200);
    const b = res.body.pages.find((p: any) => p.id === 'p-builder');
    expect(b.customDomainUrl).toBeUndefined();
  });
});
