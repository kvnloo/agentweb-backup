/**
 * ENG-1388 Phase 2 — Enigma card revenue inside V3 enrichment.
 *
 * Invariants only (CLAUDE.md Rule 2), each tied to an ENG-1932 acceptance
 * criterion:
 *   - spend: flag + allowlist, per-run cap, daily quota, 402/401 breaker (AC1, AC4, AC5)
 *   - no implicit opt-in: defaults, aliasing, smart-field deps (AC2)
 *   - fail closed: no web/LLM tier ever fills card revenue, incl. V2 (AC7)
 *   - low card-adoption industries never call Enigma (AC8)
 *   - no cross-customer sibling copy (AC9)
 *   - provenance: strings, provider enigma, medium confidence, asOf (AC6)
 */

jest.mock('../services/db', () => ({ crmDb: {} }));
jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(() => ({ generateJSONContent: jest.fn().mockResolvedValue({}) })),
}));

import {
  classifyCardAdoption,
  createEnigmaCardRevenueFetcher,
  isEnigmaEnrichmentEnabledForUser,
} from '../services/enigmaCardRevenueEnrichment';
import {
  EnigmaAuthError,
  EnigmaCreditsExhaustedError,
  EnigmaBudgetExhaustedError,
  EnigmaQuotaExceededError,
  EnigmaService,
  type EnigmaBrandLookupResult,
} from '../services/enigmaService';
import { buildEnigmaQuotaTracker } from '../services/enigmaServiceFactory';
import {
  runWaterfall,
  createApolloFetchContext,
  createEnrichSoFetchContext,
  type WaterfallDeps,
} from '../services/enrichmentGroupWaterfall';
import { llmEligibleFields } from '../services/crmEnrichmentService';
import { getEnrichmentConfig, processEnrichmentConfig, stripImplicitCardRevenueRouting, type ConfigServiceDeps } from '../services/enrichmentConfigService';
import { copySiblingConfigFields } from '../services/enrichmentSiblingConfigFields';
import { splitFieldsByGroup } from '../services/enrichmentCacheService';
import type { LeadRecord } from '../services/crmEnrichmentService';
import type { EnrichmentConfig } from '../services/crmEnrichmentServiceV3';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const found = (amountUsd: number | null, yoyGrowth: number | null = 0.1): EnigmaBrandLookupResult => ({
  status: 'found',
  brandId: 'b1',
  brandName: 'Popup Bagels',
  matchedWebsite: 'popupbagels.com',
  cardRevenue12m: amountUsd === null ? null : {
    amountUsd, yoyGrowth, periodStartDate: '2025-06-01', periodEndDate: '2026-05-31',
  },
  fromCache: false,
  checkedAt: '2026-09-15T00:00:00Z',
});

function fakeService(impl: jest.Mock) {
  return { lookupBrandCardRevenue: impl } as unknown as EnigmaService;
}

const lead = (overrides: Partial<LeadRecord> = {}): LeadRecord => ({
  leadId: 'lead-1',
  listId: 'list-1',
  email: 'owner@popupbagels.com',
  company: 'Popup Bagels',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  ...overrides,
} as LeadRecord);

function waterfallDeps(overrides: Partial<WaterfallDeps> = {}): WaterfallDeps {
  return {
    fetchApolloOrg: jest.fn().mockResolvedValue(null),
    fetchApolloPerson: jest.fn().mockResolvedValue(null),
    extractFieldsViaLLM: jest.fn().mockResolvedValue({ filled: {}, missing: [] }),
    fetchWebForGroup: jest.fn().mockResolvedValue({ webContext: 'Popup Bagels makes $9M a year' }),
    findUnipileCompany: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const CARD_FIELDS = ['card_revenue_12m', 'card_revenue_period_end', 'card_revenue_yoy_growth'];

function runCardGroup(deps: WaterfallDeps, opts: { lead?: LeadRecord; refresh?: string[]; orgRawJson?: any } = {}) {
  const apolloCtx = createApolloFetchContext();
  apolloCtx.orgRawJson = opts.orgRawJson ?? null;
  return runWaterfall({
    listId: 'list-1',
    lead: opts.lead ?? lead(),
    groupName: 'company_card_revenue',
    requestedFields: CARD_FIELDS,
    configFieldsByName: {},
    apolloCtx,
    enrichSoCtx: createEnrichSoFetchContext(),
    refreshFields: new Set(opts.refresh ?? []),
  }, deps);
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ─── Access gate (AC1) ───────────────────────────────────────────────────────

describe('isEnigmaEnrichmentEnabledForUser', () => {
  it.each([
    ['flag off', { ENIGMA_ENRICHMENT_USER_ALLOWLIST: 'u1' }, false],
    ['flag not exactly "true"', { ENIGMA_ENRICHMENT_ENABLED: '1', ENIGMA_ENRICHMENT_USER_ALLOWLIST: 'u1' }, false],
    ['empty allowlist means nobody', { ENIGMA_ENRICHMENT_ENABLED: 'true', ENIGMA_ENRICHMENT_USER_ALLOWLIST: '' }, false],
    ['missing allowlist means nobody', { ENIGMA_ENRICHMENT_ENABLED: 'true' }, false],
    ['user not listed', { ENIGMA_ENRICHMENT_ENABLED: 'true', ENIGMA_ENRICHMENT_USER_ALLOWLIST: 'u2, u3' }, false],
    ['user listed', { ENIGMA_ENRICHMENT_ENABLED: 'true', ENIGMA_ENRICHMENT_USER_ALLOWLIST: 'u2, u1' }, true],
  ])('%s', (_label, env, expected) => {
    expect(isEnigmaEnrichmentEnabledForUser('u1', env)).toBe(expected);
  });
});

// ─── Industry gate (AC8) ─────────────────────────────────────────────────────

describe('classifyCardAdoption', () => {
  it.each([
    [['Restaurants'], 'high'],
    [['B2B SaaS for restaurants'], 'low'],
    [['Hospital & Health Care'], 'mixed'],
    [['Construction'], 'mixed'],
    [[undefined, ''], 'unknown'],
    [['Logistics & Supply Chain'], 'low'],
  ])('%j → %s', (labels, expected) => {
    expect(classifyCardAdoption(labels as string[])).toBe(expected);
  });
});

// ─── Per-run fetcher: spend controls (AC4, AC5, AC8) ─────────────────────────

describe('createEnigmaCardRevenueFetcher', () => {
  const req = (over: Partial<Parameters<ReturnType<typeof createEnigmaCardRevenueFetcher>['fetch']>[0]> = {}) => ({
    domain: 'popupbagels.com', companyName: 'Popup Bagels', industryLabels: ['Restaurants'], forceRefresh: false, ...over,
  });

  it('skips low card-adoption industries and unusable domains without calling Enigma', async () => {
    const lookup = jest.fn();
    const f = createEnigmaCardRevenueFetcher({ service: fakeService(lookup), userId: 'u1', maxLookupsPerRun: 10 });

    expect(await f.fetch(req({ industryLabels: ['Computer Software'] }))).toEqual({ kind: 'skipped', reason: 'low_card_adoption' });
    expect(await f.fetch(req({ domain: null }))).toEqual({ kind: 'skipped', reason: 'unusable_domain' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('stops at the per-run cap even when leads run concurrently', async () => {
    const lookup = jest.fn().mockResolvedValue(found(1000));
    const f = createEnigmaCardRevenueFetcher({ service: fakeService(lookup), userId: 'u1', maxLookupsPerRun: 2 });

    const outcomes = await Promise.all([f.fetch(req()), f.fetch(req()), f.fetch(req())]);

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(outcomes.filter((o) => o.kind === 'skipped' && o.reason === 'cap_reached')).toHaveLength(1);
  });

  it('does not spend a run slot on a website that can never be looked up', async () => {
    const lookup = jest.fn().mockResolvedValue(found(1000));
    const f = createEnigmaCardRevenueFetcher({ service: fakeService(lookup), userId: 'u1', maxLookupsPerRun: 1 });

    expect(await f.fetch(req({ domain: 'everyio.agentwebforms.com' }))).toEqual({ kind: 'skipped', reason: 'unusable_domain' });
    expect(await f.fetch(req({ domain: 'linkedin.com' }))).toEqual({ kind: 'skipped', reason: 'unusable_domain' });
    expect((await f.fetch(req())).kind).toBe('found');     // the one real slot is still free
    expect(f.summary().lookups).toBe(1);
  });

  // ENG-1933: credits, not calls, are the real limit (~19 credits per call on a
  // 2,100/month plan), so a spent budget must stop the run like a 402 does.
  it('halts the run when the monthly credit budget is spent, as a skip not a failure', async () => {
    const lookup = jest.fn()
      .mockRejectedValueOnce(new EnigmaBudgetExhaustedError(1800))
      .mockResolvedValue(found(1000));
    const f = createEnigmaCardRevenueFetcher({ service: fakeService(lookup), userId: 'u1', maxLookupsPerRun: 10 });

    expect(await f.fetch(req())).toEqual({ kind: 'skipped', reason: 'budget_reached' });
    expect(await f.fetch(req())).toEqual({ kind: 'skipped', reason: 'budget_reached' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(f.summary()).toMatchObject({ filled: 0, failed: {} });
  });

  it.each([
    ['402 out of credits', new EnigmaCreditsExhaustedError(), 'credits_exhausted'],
    ['401 bad key', new EnigmaAuthError(401), 'auth'],
  ])('halts every later lookup in the run after %s, reported as failed not "no data"', async (_label, error, reason) => {
    const lookup = jest.fn().mockRejectedValueOnce(error).mockResolvedValue(found(1000));
    const f = createEnigmaCardRevenueFetcher({ service: fakeService(lookup), userId: 'u1', maxLookupsPerRun: 10 });

    expect(await f.fetch(req())).toEqual({ kind: 'failed', reason });
    expect(await f.fetch(req())).toEqual({ kind: 'skipped', reason: 'provider_unavailable' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(f.summary()).toMatchObject({ haltedBy: reason, failed: { [reason]: 1 }, skipped: { provider_unavailable: 1 }, filled: 0 });
  });

  it('treats the daily quota as a cap (skipped), and a null value as no_value', async () => {
    const lookup = jest.fn()
      .mockRejectedValueOnce(new EnigmaQuotaExceededError(300))
      .mockResolvedValueOnce(found(null))
      .mockResolvedValueOnce(found(4_250_000));
    const f = createEnigmaCardRevenueFetcher({ service: fakeService(lookup), userId: 'u1', maxLookupsPerRun: 10 });

    expect(await f.fetch(req())).toEqual({ kind: 'skipped', reason: 'cap_reached' });
    expect(await f.fetch(req())).toEqual({ kind: 'skipped', reason: 'no_value' });
    expect((await f.fetch(req())).kind).toBe('found');
    expect(f.summary()).toMatchObject({ lookups: 3, filled: 1, failed: {} });
  });
});

// ─── Service daily quota (AC4) ───────────────────────────────────────────────

describe('EnigmaService daily quota', () => {
  const brand = {
    id: 'b1',
    names: { edges: [{ node: { name: 'Popup Bagels' } }] },
    websites: { edges: [{ node: { website: 'https://popupbagels.com', domain: 'popupbagels', topLevelDomain: 'com' } }] },
    cardTransactions: { edges: [] },
  };
  const store = () => {
    const rows = new Map<string, any>();
    return { get: async (id: string, sk: string) => rows.get(`${id}|${sk}`) ?? null, put: async (r: any) => { rows.set(`${r.canonicalId}|${r.fieldGroup}`, r); } };
  };

  it('blocks before HTTP when the user is at the limit, and never counts cache hits', async () => {
    const searchBrand = jest.fn().mockResolvedValue([brand]);
    const quota = { checkQuota: jest.fn().mockResolvedValue(undefined), recordUsage: jest.fn().mockResolvedValue(undefined) };
    const svc = new EnigmaService({ http: { searchBrand }, store: store(), quota });

    await svc.lookupBrandCardRevenue({ website: 'popupbagels.com' }, { userId: 'u1' });
    await svc.lookupBrandCardRevenue({ website: 'popupbagels.com' }, { userId: 'u1' });   // cache hit
    expect(searchBrand).toHaveBeenCalledTimes(1);
    expect(quota.recordUsage).toHaveBeenCalledTimes(1);

    quota.checkQuota.mockRejectedValueOnce(new EnigmaQuotaExceededError(300));
    await expect(svc.lookupBrandCardRevenue({ website: 'other.com' }, { userId: 'u1' })).rejects.toBeInstanceOf(EnigmaQuotaExceededError);
    expect(searchBrand).toHaveBeenCalledTimes(1);
  });

  it('checks the credit budget before HTTP and records what Enigma billed', async () => {
    const billing = {
      id: 'b1',
      names: { edges: [{ node: { name: 'Popup Bagels' } }] },                       // 2 credits
      websites: { edges: [{ node: { website: 'https://popupbagels.com', domain: 'popupbagels', topLevelDomain: 'com' } }] }, // 2
      cardTransactions: { edges: [
        { node: { quantityType: 'card_revenue_amount', period: '12m', projectedQuantity: 401164, periodStartDate: '2025-07-01', periodEndDate: '2026-06-30', platformBrandId: null } },      // 10
        { node: { quantityType: 'card_revenue_yoy_growth', period: '12m', projectedQuantity: 0.0739, periodStartDate: '2025-07-01', periodEndDate: '2026-06-30', platformBrandId: null } },   // 10
        { node: { quantityType: 'card_revenue_yoy_growth', period: '12m', projectedQuantity: 0.2392, periodStartDate: '2025-07-01', periodEndDate: '2026-06-30', platformBrandId: 'p1' } },   // 10, billed though discarded
      ] },
    };
    const searchBrand = jest.fn().mockResolvedValue([billing]);
    const quota = {
      checkQuota: jest.fn().mockResolvedValue(undefined),
      recordUsage: jest.fn().mockResolvedValue(undefined),
      checkCreditBudget: jest.fn().mockResolvedValue(undefined),
      recordCredits: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new EnigmaService({ http: { searchBrand }, store: store(), quota });

    await svc.lookupBrandCardRevenue({ website: 'popupbagels.com' }, { userId: 'u1' });
    expect(quota.recordCredits).toHaveBeenCalledWith(34);

    quota.checkCreditBudget.mockRejectedValueOnce(new EnigmaBudgetExhaustedError(1800));
    await expect(svc.lookupBrandCardRevenue({ website: 'other.com' }, { userId: 'u1' }))
      .rejects.toBeInstanceOf(EnigmaBudgetExhaustedError);
    expect(searchBrand).toHaveBeenCalledTimes(1);
    expect(quota.checkQuota).toHaveBeenCalledTimes(1);   // budget is checked first
  });

  it('Dynamo tracker: this month at budget throws; last month\'s spend does not', async () => {
    let item: any = { month: '2026-09', creditCount: 1800 };
    const dynamodb: any = { get: () => ({ promise: async () => ({ Item: item }) }), update: jest.fn(), put: jest.fn() };
    const tracker = buildEnigmaQuotaTracker(dynamodb, 150, () => new Date('2026-09-15T12:00:00Z'), 1800);

    await expect(tracker.checkCreditBudget!()).rejects.toBeInstanceOf(EnigmaBudgetExhaustedError);
    item = { month: '2026-08', creditCount: 5000 };
    await expect(tracker.checkCreditBudget!()).resolves.toBeUndefined();
  });

  it('Dynamo tracker: at the limit today throws; yesterday\'s count does not', async () => {
    let item: any = { date: '2026-09-15', callCount: 300 };
    const dynamodb: any = { get: () => ({ promise: async () => ({ Item: item }) }), update: jest.fn(), put: jest.fn() };
    const tracker = buildEnigmaQuotaTracker(dynamodb, 300, () => new Date('2026-09-15T12:00:00Z'));

    await expect(tracker.checkQuota('u1')).rejects.toBeInstanceOf(EnigmaQuotaExceededError);
    item = { date: '2026-09-14', callCount: 300 };
    await expect(tracker.checkQuota('u1')).resolves.toBeUndefined();
  });
});

// ─── Waterfall: fail closed + provenance (AC6, AC7) ──────────────────────────

describe('runWaterfall — company_card_revenue', () => {
  it.each([
    ['Enigma not enabled for the run', undefined],
    ['Enigma finds nothing', jest.fn().mockResolvedValue({ kind: 'skipped', reason: 'not_found' })],
    ['Enigma fails', jest.fn().mockResolvedValue({ kind: 'failed', reason: 'error' })],
  ])('never falls through to Apollo, web or LLM tiers when %s', async (_label, fetchEnigmaCardRevenue) => {
    const deps = waterfallDeps(fetchEnigmaCardRevenue ? { fetchEnigmaCardRevenue } : {});

    const result = await runCardGroup(deps);

    expect(result.fields).toEqual([]);
    expect(result.missing).toEqual(CARD_FIELDS);
    expect(deps.fetchApolloOrg).not.toHaveBeenCalled();
    expect(deps.fetchWebForGroup).not.toHaveBeenCalled();
    expect(deps.extractFieldsViaLLM).not.toHaveBeenCalled();
    expect(deps.findUnipileCompany).not.toHaveBeenCalled();
  });

  it('stores string values with Enigma provenance and the as-of date', async () => {
    const fetchEnigmaCardRevenue = jest.fn().mockResolvedValue({
      kind: 'found', adoption: 'mixed', result: found(4_250_000, null),
    });
    const deps = waterfallDeps({ fetchEnigmaCardRevenue });

    const result = await runCardGroup(deps, {
      lead: lead({ customFields: { industry: 'Cleaning' } } as Partial<LeadRecord>),
      refresh: ['lead-1:card_revenue_12m'],
      orgRawJson: { industry: 'consumer services', industries: ['consumer services'] },
    });

    expect(fetchEnigmaCardRevenue).toHaveBeenCalledWith(expect.anything(), {
      industryLabels: ['Cleaning', 'consumer services', 'consumer services'],
      forceRefresh: true,
    });
    const byField = Object.fromEntries(result.fields.map((f) => [f.field, f]));
    expect(byField.card_revenue_12m.value).toBe('4250000');
    expect(byField.card_revenue_period_end.value).toBe('2026-05-31');
    expect(byField.card_revenue_yoy_growth).toBeUndefined();          // null YoY is not written
    expect(result.missing).toEqual(['card_revenue_yoy_growth']);
    expect(byField.card_revenue_12m.meta).toMatchObject({
      source: 'api', provider: 'enigma', confidence: 'medium', asOf: '2026-05-31',
    });
    expect(byField.card_revenue_12m.meta.sourceQuote).toMatch(/Not total revenue.*floor/);
    expect(result.tierFills.enigma).toBe(2);
    expect(deps.fetchWebForGroup).not.toHaveBeenCalled();
  });
});

// ─── No implicit opt-in (AC2) ────────────────────────────────────────────────

describe('enrichment config — card revenue is never switched on implicitly', () => {
  const configDeps = (over: Partial<ConfigServiceDeps> = {}): ConfigServiceDeps => ({
    readListConfig: jest.fn().mockResolvedValue(null),
    writeListConfig: jest.fn().mockResolvedValue(undefined),
    loadListFieldNames: jest.fn().mockResolvedValue([]),
    mergeListFieldNames: jest.fn().mockResolvedValue(undefined),
    llmSuggestTypes: jest.fn().mockResolvedValue([]),
    llmInferAliases: jest.fn().mockResolvedValue({}),
    llmClassifySmartFields: jest.fn().mockResolvedValue({}),
    ...over,
  });
  const field = (name: string, extra: Record<string, unknown> = {}) =>
    ({ name, type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty', ...extra }) as EnrichmentConfig['fields'][number];
  const config = (fields: EnrichmentConfig['fields']): EnrichmentConfig =>
    ({ fields, globalOverwriteDefault: 'fill_if_empty', schemaVersion: 1, updatedAt: '', updatedBy: '' });

  it('a card column already on the list defaults to excluded', async () => {
    const { config: merged } = await getEnrichmentConfig(
      { listId: 'l1', userId: 'u1' },
      configDeps({ loadListFieldNames: jest.fn().mockResolvedValue(['card_revenue_12m', 'industry']) }),
    );
    expect(merged.fields.find((f) => f.name === 'card_revenue_12m')?.include).toBe(false);
    expect(merged.fields.find((f) => f.name === 'industry')?.include).toBe(true);
  });

  it('drops LLM and client aliases onto card fields, and card smart-field dependencies', async () => {
    const deps = configDeps({
      llmInferAliases: jest.fn().mockResolvedValue({ revenue_estimate: 'card_revenue_12m' }),
      llmClassifySmartFields: jest.fn().mockResolvedValue({
        is_big: { isSmartField: true, dependencies: ['card_revenue_12m', 'employee_count'] },
      }),
    });

    const { config: out } = await processEnrichmentConfig({
      listId: 'l1',
      userId: 'u1',
      config: config([
        field('revenue_estimate', { instruction: 'estimated revenue' }),
        field('sales', { aliasFor: 'card_revenue_12m' }),
        field('is_big', { instruction: 'is revenue above $1M and 50+ employees' }),
        field('card_revenue_12m'),
      ]),
    }, deps);

    const byName = Object.fromEntries(out.fields.map((f) => [f.name, f]));
    expect(byName.revenue_estimate.aliasFor).toBeUndefined();
    expect(byName.sales.aliasFor).toBeUndefined();
    expect(byName.is_big.smartDependencies).toEqual(['employee_count']);
    expect(byName.card_revenue_12m.include).toBe(true);          // explicit, exact name: allowed
  });
});

// ENG-1388 AC2: a preview run buys real values from an inline client config,
// so it must get the same sanitising a saved config gets.
describe('stripImplicitCardRevenueRouting (preview path)', () => {
  it('drops aliases onto card fields and card smart-dependencies, keeping exact names', () => {
    const out = stripImplicitCardRevenueRouting({
      fields: [
        { name: 'Revenue', aliasFor: 'card_revenue_12m', include: true },
        { name: 'is_big', smartDependencies: ['card_revenue_12m', 'employee_count'], include: true },
        { name: 'card_revenue_12m', include: true },
      ],
    });

    const byName = Object.fromEntries(out.fields.map((f: any) => [f.name, f]));
    expect(byName.Revenue.aliasFor).toBeUndefined();
    expect(byName.is_big.smartDependencies).toEqual(['employee_count']);
    expect(byName.card_revenue_12m).toEqual({ name: 'card_revenue_12m', include: true });
  });
});

// ─── No cross-customer copy (AC9) and no legacy web fill (AC7) ───────────────

describe('card revenue outside the V3 Enigma tier', () => {
  it('never copies a card field, or any Enigma-provided value, from a sibling lead', () => {
    const sibling = {
      leadId: 'sib-1', listId: 'other-list', userId: 'other-user', updatedAt: new Date().toISOString(),
      customFields: { card_revenue_12m: '9000000', revenue: '9000000' },
      enrichmentMetadata: {
        card_revenue_12m: { source: 'api', provider: 'enigma', enrichedAt: new Date().toISOString() },
        revenue: { source: 'api', provider: 'enigma', enrichedAt: new Date().toISOString() },
      },
    } as any;
    const configFields = [
      { name: 'card_revenue_12m', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
      { name: 'revenue_guess', type: 'string', instruction: '', include: true, overwritePolicy: 'fill_if_empty' },
    ] as EnrichmentConfig['fields'];
    const mapping = { canonical: new Map(), llm: new Map([['revenue_guess', ['revenue', 'card_revenue_12m']]]) };

    const { fills } = copySiblingConfigFields(lead(), [sibling], configFields, mapping);

    expect(fills).toEqual([]);
  });

  it('no legacy V2 LLM unit can be handed a card field, even when a specialist resolved nothing', () => {
    expect(llmEligibleFields(['card_revenue_12m', 'card_revenue_yoy_growth', 'industry'], {})).toEqual(['industry']);
    expect(llmEligibleFields(['card_revenue_12m'], {})).toEqual([]);          // no `no_context` unit is built for it
    expect(llmEligibleFields(['industry', 'funding_stage'], { industry: 'x' })).toEqual(['funding_stage']);   // existing behaviour kept
  });

  it('the legacy V2 web path drops card fields entirely', () => {
    const { byGroup, ungrouped } = splitFieldsByGroup(['card_revenue_12m', 'industry']);
    expect([...byGroup.values()].flat()).toEqual(['industry']);
    expect(ungrouped).toEqual([]);
  });
});
