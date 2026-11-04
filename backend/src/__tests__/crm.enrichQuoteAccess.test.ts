// ENG-2720: route-level checks for the three pre-run quote surfaces (POST .../enrich-v3/estimate, POST .../enrich-v3?mode=estimate
// and the stale-token 409 on POST .../enrich-v3): authorization order, no dollar or vendor leakage, token flow, input handling.
// Written by the independent reviewer of the PR as exploit tests and adopted here, so the thin glue in routes/crm.ts is covered.
process.env.JWT_SECRET = 'test-secret';
process.env.ENRICH_V3_REQUIRE_COST_CONFIRMATION = 'false';

jest.mock('../server', () => ({ io: { to: jest.fn().mockReturnValue({ emit: jest.fn() }), emit: jest.fn() }, app: {} }));
jest.mock('../controllers/templates', () => ({
  createTemplate: jest.fn(), getTemplates: jest.fn(), getTemplate: jest.fn(), updateTemplate: jest.fn(),
  deleteTemplate: jest.fn(), publishTemplate: jest.fn(),
}));
jest.mock('../config/aws', () => ({
  dynamodb: {
    get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    put: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    update: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
    query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
    scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  },
}));
const mockGetLeadList = jest.fn();
const mockGetUser = jest.fn();
const mockGetOrg = jest.fn();
const mockGetLeads = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: (...a: any[]) => mockGetLeadList(...a),
    getLeadsByListId: (...a: any[]) => mockGetLeads(...a),
  },
  taskDb: {}, subscriberDb: {},
  userDb: { getUserById: (...a: any[]) => mockGetUser(...a) },
  orgDb: { getOrgById: (...a: any[]) => mockGetOrg(...a) },
}));
jest.mock('../services/dealDb', () => ({ dealDb: {}, DealAuthError: class extends Error {}, DealNotFoundError: class extends Error {}, DEAL_STAGES: [] }));
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn(), setSetting: jest.fn() } }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/leadListAlertService', () => ({ leadListAlertService: {} }));
jest.mock('../services/contactSyncService', () => ({ syncContact: jest.fn() }));
jest.mock('../services/internalEnrichmentService', () => ({ enrichContact: jest.fn(), defaultEnrichmentCache: {} }));
jest.mock('../services/contactDedupService', () => ({ dedupContactsForUser: jest.fn() }));
jest.mock('../services/emailEventsDb', () => ({ emailEventsDb: {} }));
jest.mock('../services/externalCrmSyncService', () => ({ externalCrmSyncService: {} }));
jest.mock('../services/dripSequenceDb', () => ({ dripSequenceDb: {} }));

const mockGetCfg = jest.fn();
jest.mock('../services/enrichmentConfigService', () => ({
  ...jest.requireActual('../services/enrichmentConfigService'),
  getEnrichmentConfig: (...a: any[]) => mockGetCfg(...a),
}));
jest.mock('../services/enrichmentConfigDeps', () => ({ buildConfigServiceDeps: () => ({}) }));

const mockRun = jest.fn();
jest.mock('../services/crmEnrichmentServiceV3', () => ({ runEnrichment: (...a: any[]) => mockRun(...a) }));
jest.mock('../services/enrichmentV3RealDeps', () => ({ buildOrchestratorDeps: jest.fn().mockReturnValue({}) }));
jest.mock('../emma/enrichmentToolRunner', () => ({ buildListContext: jest.fn().mockReturnValue({}) }));

const mockCheck = jest.fn();
jest.mock('../services/tokenUsageService', () => ({ checkTokenUsage: (...a: any[]) => mockCheck(...a), TURN_ADMISSION: { recordAdmission: true } }));
jest.mock('../services/modelRoles', () => ({ resolveModelForUser: jest.fn().mockResolvedValue('openrouter/openai/gpt-5.6-luna') }));

const mockUser: { userId: string } = { userId: 'attacker' };
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = mockUser.userId ? { userId: mockUser.userId, email: 'x@y.z' } : undefined; next(); },
  AuthenticatedRequest: {},
}));

import express from 'express';
import request from 'supertest';
import router from '../routes/crm';

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use('/api/crm', router);

const ORG = { orgId: 'org-1', ownerUserId: 'org-owner', shareSettings: { crm: { enabled: true, editors: ['listed-editor'] } } };
const USERS: Record<string, { userId: string; orgId?: string; orgRole?: string }> = {
  'list-owner':   { userId: 'list-owner', orgId: 'org-1', orgRole: 'member' },
  'org-owner':    { userId: 'org-owner', orgId: 'org-1', orgRole: 'owner' },
  'org-admin':    { userId: 'org-admin', orgId: 'org-1', orgRole: 'admin' },
  'listed-editor': { userId: 'listed-editor', orgId: 'org-1', orgRole: 'member' },
  'plain-member': { userId: 'plain-member', orgId: 'org-1', orgRole: 'member' },
  'other-org':    { userId: 'other-org', orgId: 'org-2', orgRole: 'owner' },
  'no-org':       { userId: 'no-org' },
};
const ORGS: Record<string, any> = { 'org-1': ORG, 'org-2': { orgId: 'org-2', ownerUserId: 'other-org', shareSettings: {} } };
const LIST = { listId: 'the-list', userId: 'list-owner' };
const cfgFields = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' }));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLeadList.mockResolvedValue(LIST);
  mockGetUser.mockImplementation(async (id: string) => USERS[id]);
  mockGetOrg.mockImplementation(async (id: string) => ORGS[id]);
  mockGetLeads.mockResolvedValue({ items: [{ leadId: 'a', email: '' }], lastEvaluatedKey: undefined });
  mockCheck.mockResolvedValue({ allowed: true, month: '2026-11', costAllowance: 80, costUsed: 5 });
  mockGetCfg.mockResolvedValue({ isDefault: false, config: { fields: cfgFields, globalOverwriteDefault: 'fill_if_empty', schemaVersion: 1 } });
  mockRun.mockResolvedValue({ processed: 0, durationMs: 1 });
});

const SURFACES: Array<[string, string, object]> = [
  ['POST /estimate', '/api/crm/lists/the-list/leads/enrich-v3/estimate', {}],
  ['POST ?mode=estimate', '/api/crm/lists/the-list/leads/enrich-v3?mode=estimate', {}],
  ['POST enrich with a token (the 409 path)', '/api/crm/lists/the-list/leads/enrich-v3', { confirmEstimateToken: 'x'.repeat(32) }],
];
const as = (userId: string) => { mockUser.userId = userId; };

describe('who may use the quote surfaces (real crmAccessControl)', () => {
  it.each(['list-owner', 'org-owner', 'org-admin', 'listed-editor'])('%s (owner, org owner, org admin or listed CRM editor) is allowed on every surface', async (who) => {
    as(who);
    for (const [label, url, body] of SURFACES) {
      const r = await request(app).post(url).send(body);
      expect([200, 409]).toContain(r.status); // 409 = stale token, which means the caller got past authorization
      expect(r.status).not.toBe(403);
      void label;
    }
  });

  it.each(['plain-member', 'other-org', 'no-org'])('%s is refused with 403 on every surface, with no lead, config or ledger read', async (who) => {
    as(who);
    for (const [, url, body] of SURFACES) {
      const r = await request(app).post(url).send(body);
      expect(r.status).toBe(403);
      expect(r.body.estimate).toBeUndefined();
      expect(JSON.stringify(r.body)).not.toMatch(/leadCount|confirmationToken|Percent/);
    }
    expect(mockGetLeads).not.toHaveBeenCalled();
    expect(mockGetCfg).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a plain member can READ the list through the reader check but still cannot quote it (editor access is required)', async () => {
    // plain-member shares the org and crm sharing is enabled, so canAccessCrmList would pass; the quote must not.
    const { canAccessCrmList, canDestructiveCrmList } = jest.requireActual('../services/crmAccessControl');
    expect(await canAccessCrmList('plain-member', LIST)).toBe(true);
    expect(await canDestructiveCrmList('plain-member', LIST)).toBe(false);
    as('plain-member');
    const r = await request(app).post('/api/crm/lists/the-list/leads/enrich-v3/estimate').send({});
    expect(r.status).toBe(403);
  });
});
