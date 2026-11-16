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
const mockGetLeads = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadListById: (...a: any[]) => mockGetLeadList(...a),
    getLeadsByListId: (...a: any[]) => mockGetLeads(...a),
  },
  taskDb: {}, subscriberDb: {}, userDb: {}, orgDb: {},
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

const mockCanDestructive = jest.fn();
const mockCanAccess = jest.fn();
jest.mock('../services/crmAccessControl', () => ({
  canAccessCrmList: (...a: any[]) => mockCanAccess(...a),
  canDestructiveCrmList: (...a: any[]) => mockCanDestructive(...a),
  CRM_EDITOR_REQUIRED_MESSAGE: 'editor required',
  CRM_SHARING_DISABLED_MESSAGE: 'sharing disabled',
  getReadableOrgMemberIds: jest.fn(),
}));

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

const LIST = { listId: 'victim-list', userId: 'victim' };
// The first field is the email column (a saved config that requests an email can reach the Apollo broker).
const cfgFields = Array.from({ length: 10 }, (_, i) => ({ name: i === 0 ? 'email' : `f${i}`, type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' }));

beforeEach(() => {
  jest.clearAllMocks();
  mockUser.userId = 'attacker';
  mockGetLeadList.mockResolvedValue(LIST);
  // Named leads with a company: an emailless one can reach the Apollo broker (the estimate prices only those at the full rate).
  mockGetLeads.mockResolvedValue({ items: [{ leadId: 'a', email: '', firstName: 'Ada', lastName: 'Lovelace', company: 'Acme' }, { leadId: 'b', email: 'a@acme.com', firstName: 'Bo', lastName: 'Ng', company: 'Acme' }], lastEvaluatedKey: undefined });
  mockCheck.mockResolvedValue({ allowed: true, month: '2026-11', costAllowance: 80, costUsed: 5 });
  mockGetCfg.mockResolvedValue({ isDefault: false, config: { fields: cfgFields, globalOverwriteDefault: 'fill_if_empty', schemaVersion: 1 } });
  mockRun.mockResolvedValue({ processed: 0, durationMs: 1 });
});

describe('authorization on the quote surfaces', () => {
  beforeEach(() => mockCanDestructive.mockResolvedValue(false));

  it('/estimate: 403 and NO lead read for a non-editor (no count/emailless oracle)', async () => {
    const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({});
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body)).not.toMatch(/leadCount|confirmationToken|Percent/);
    expect(mockGetLeads).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });
  it('?mode=estimate: 403 and NO lead / config / ledger read', async () => {
    const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3?mode=estimate').send({});
    expect(r.status).toBe(403);
    expect(mockGetLeads).not.toHaveBeenCalled();
    expect(mockGetCfg).not.toHaveBeenCalled();
    expect(mockCheck).not.toHaveBeenCalled();
  });
  it('enrich with a token: 403 before the token check (no 409/estimate body for a foreign list)', async () => {
    const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3').send({ confirmEstimateToken: 'x'.repeat(32) });
    expect(r.status).toBe(403);
    expect(r.body.estimate).toBeUndefined();
    expect(mockGetLeads).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });
  it('unknown list -> 404 on all three (same order)', async () => {
    mockGetLeadList.mockResolvedValue(undefined);
    for (const url of ['/estimate', '?mode=estimate', '']) {
      const r = await request(app).post(`/api/crm/lists/nope/leads/enrich-v3${url}`).send({});
      expect(r.status).toBe(404);
    }
  });
});

describe('no dollar or vendor leakage from customer-reachable bodies', () => {
  beforeEach(() => mockCanDestructive.mockResolvedValue(true));
  const DOLLARISH = /usd|breakdown|apollo|enrich\.so|you\.com|openrouter|enigma|perLead|totalUsd|\$\s?\d|"cost|rate/i;

  it('/estimate body is exactly the four fields', async () => {
    const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({});
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['confirmationToken', 'estimatedPercentOfAllowance', 'leadCount', 'withinAllowance']);
    expect(JSON.stringify(r.body)).not.toMatch(DOLLARISH);
  });
  it('?mode=estimate body is exactly the four fields', async () => {
    const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3?mode=estimate').send({});
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['confirmationToken', 'estimatedPercentOfAllowance', 'leadCount', 'withinAllowance']);
  });
  it('stale-token 409 returns message + code + customer view only; token from /estimate is accepted', async () => {
    const q = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({});
    const stale = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3').send({ confirmEstimateToken: 'deadbeef' });
    expect(stale.status).toBe(409);
    expect(Object.keys(stale.body).sort()).toEqual(['code', 'estimate', 'message']);
    expect(Object.keys(stale.body.estimate).sort()).toEqual(['confirmationToken', 'estimatedPercentOfAllowance', 'leadCount', 'withinAllowance']);
    expect(JSON.stringify(stale.body)).not.toMatch(DOLLARISH);
    // the 409 body's fresh token equals the quote token
    expect(stale.body.estimate.confirmationToken).toBe(q.body.confirmationToken);
    // and the quote's token is accepted at enrich time
    const ok = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3').send({ confirmEstimateToken: q.body.confirmationToken });
    expect(ok.status).toBe(200);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });
  it('with ENRICH_V3_REQUIRE_COST_CONFIRMATION=true a missing or non-string token is refused with the four customer fields only', async () => {
    const saved = process.env.ENRICH_V3_REQUIRE_COST_CONFIRMATION;
    process.env.ENRICH_V3_REQUIRE_COST_CONFIRMATION = 'true';
    try {
      for (const body of [{}, { confirmEstimateToken: 12345 }, { confirmEstimateToken: ['x'] }, { confirmEstimateToken: '' }]) {
        const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3').send(body);
        expect(r.status).toBe(409);
        expect(Object.keys(r.body.estimate).sort()).toEqual(['confirmationToken', 'estimatedPercentOfAllowance', 'leadCount', 'withinAllowance']);
        expect(JSON.stringify(r.body)).not.toMatch(DOLLARISH);
      }
      expect(mockRun).not.toHaveBeenCalled();
      const q = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({});
      const ok = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3').send({ confirmEstimateToken: q.body.confirmationToken });
      expect(ok.status).toBe(200);
      expect(mockRun).toHaveBeenCalledTimes(1);
    } finally {
      if (saved === undefined) delete process.env.ENRICH_V3_REQUIRE_COST_CONFIRMATION; else process.env.ENRICH_V3_REQUIRE_COST_CONFIRMATION = saved;
    }
  });
  it('another user\'s token is rejected (bound to the user)', async () => {
    const q = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({});
    mockUser.userId = 'someone-else';
    const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3').send({ confirmEstimateToken: q.body.confirmationToken });
    expect(r.status).toBe(409);
  });
  it('a ledger/config failure surfaces only a generic 500 (no error text)', async () => {
    mockCheck.mockRejectedValue(new Error('SECRET apollo $0.445 rate boom'));
    const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({});
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).toBe(JSON.stringify({ message: 'Enrichment estimate failed' }));
  });
  it('missing JWT secret fails closed (500) rather than minting a guessable token', async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({});
      expect(r.status).toBe(500);
      const e = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3').send({ confirmEstimateToken: 'x' });
      expect(e.status).toBe(500);
      expect(mockRun).not.toHaveBeenCalled();
    } finally { process.env.JWT_SECRET = saved; }
  });
});

describe('input handling', () => {
  beforeEach(() => mockCanDestructive.mockResolvedValue(true));
  it('non-string / duplicate / huge leadIds do not break the quote and only real leads of the list are counted', async () => {
    const ids = Array.from({ length: 200000 }, (_, i) => (i % 2 ? 'a' : `id-${i % 1000}`));
    const t0 = Date.now();
    const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({ leadIds: [...ids, 1, null, {}, ['x']] });
    expect(r.status).toBe(200);
    expect(r.body.leadCount).toBe(1); // only 'a' exists, however many times it is repeated
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('a selected subset is priced with the real email state of those leads', async () => {
    const withEmail = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({ leadIds: ['b'] });
    const without = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({ leadIds: ['a'] });
    expect(withEmail.body.leadCount).toBe(1);
    expect(without.body.leadCount).toBe(1);
    expect(without.body.estimatedPercentOfAllowance).toBeGreaterThan(withEmail.body.estimatedPercentOfAllowance);
  });
  it('blank and placeholder-domain emails count as no email (the resolver ignores them), real ones do not', async () => {
    mockGetLeads.mockResolvedValue({ items: [
      { leadId: 'real', email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
      { leadId: 'blank', email: '   ', firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
      { leadId: 'placeholder', email: 'x@example.com', firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
      { leadId: 'missing', firstName: 'Jane', lastName: 'Doe', company: 'Acme' },
    ], lastEvaluatedKey: undefined });
    const pct = async (id: string) => (await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({ leadIds: [id] })).body.estimatedPercentOfAllowance;
    const [real, blank, placeholder, missing] = [await pct('real'), await pct('blank'), await pct('placeholder'), await pct('missing')];
    expect(blank).toBeGreaterThan(real);
    expect(placeholder).toBe(blank);
    expect(missing).toBe(blank);
  });
  it('duplicate leadIds are quoted once AND reach the run once (the run uses DynamoDB batch reads, which reject duplicate keys)', async () => {
    const q = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({ leadIds: ['a', 'a', 'a', 'b', 'a'] });
    expect(q.body.leadCount).toBe(2);
    const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3')
      .send({ leadIds: ['a', 'a', 'a', 'b', 'a'], confirmEstimateToken: q.body.confirmationToken });
    expect(r.status).toBe(200);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun.mock.calls[0][0].leadIds).toEqual(['a', 'b']);
  });
  it('?mode=estimate de-duplicates the same way as the other surfaces', async () => {
    const a = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3?mode=estimate').send({ leadIds: ['a', 'a', 'b'] });
    const b = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({ leadIds: ['a', 'b'] });
    expect(a.body.leadCount).toBe(2);
    expect(a.body.confirmationToken).toBe(b.body.confirmationToken);
  });
  it('quotes the reference config when none is saved (isDefault), not the default config it was handed', async () => {
    const wide = Array.from({ length: 40 }, (_, i) => ({ name: i === 0 ? 'email' : `w${i}`, type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' }));
    const pct = async () => (await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({})).body.estimatedPercentOfAllowance;
    mockGetCfg.mockResolvedValue({ isDefault: false, config: { fields: wide, globalOverwriteDefault: 'fill_if_empty', schemaVersion: 1 } });
    const saved40 = await pct();
    mockGetCfg.mockResolvedValue({ isDefault: true, config: { fields: wide, globalOverwriteDefault: 'fill_if_empty', schemaVersion: 1 } });
    const defaultConfig = await pct();
    expect(defaultConfig).toBeLessThan(saved40); // the unsaved default's 40 fields are ignored
    expect(defaultConfig).toBeGreaterThan(0);
  });
  it('a saved config that cannot be read fails the quote with a generic 500 and NO token (the run would fail on it)', async () => {
    mockGetCfg.mockRejectedValue(new Error("Cannot read properties of undefined (reading 'filter')"));
    for (const [url, body] of [['/estimate', {}], ['?mode=estimate', {}]] as Array<[string, object]>) {
      const r = await request(app).post(`/api/crm/lists/victim-list/leads/enrich-v3${url}`).send(body);
      expect(r.status).toBe(500);
      expect(r.body.confirmationToken).toBeUndefined();
      expect(JSON.stringify(r.body)).not.toMatch(/filter|undefined|leadCount|Percent/);
    }
    expect(mockRun).not.toHaveBeenCalled();
  });
  it('leadIds that is not an array = whole list', async () => {
    const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({ leadIds: 'x' });
    expect(r.body.leadCount).toBe(2);
  });
  it('fake lead ids cannot amplify the quote: they match nothing, so the percent stays at zero', async () => {
    const big = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({ leadIds: Array.from({ length: 100000 }, (_, i) => `fake-${i}`) });
    expect(big.status).toBe(200);
    expect(big.body.leadCount).toBe(0);
    expect(big.body.estimatedPercentOfAllowance).toBe(0);
  });
  it('allowance 0 / null / NaN do not produce NaN percent', async () => {
    for (const a of [0, null, undefined, NaN, -5]) {
      mockCheck.mockResolvedValue({ allowed: true, month: 'm', costAllowance: a, costUsed: 0 });
      const r = await request(app).post('/api/crm/lists/victim-list/leads/enrich-v3/estimate').send({});
      expect(r.status).toBe(200);
      const p = r.body.estimatedPercentOfAllowance;
      expect(p === null || Number.isFinite(p)).toBe(true);
    }
  });
});
