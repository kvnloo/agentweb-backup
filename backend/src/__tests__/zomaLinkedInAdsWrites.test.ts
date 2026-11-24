/**
 * Zoma LinkedIn Ads guarded writes, gateway and token refresh. Invariants only:
 *  - a write without a valid, unused preview token sends nothing
 *  - a create is never live: every create is DRAFT, explicit (nothing from the shared service's
 *    defaults: ACTIVE, 2.00 USD, USD, US/en), and a request that carries a status is refused
 *  - the spend ceiling (keyed by currency; unset = none; unreadable, uncovered or missing currency =
 *    refused) holds, including for what an ACTIVATE unlocks
 *  - read-back is conservative: CONFIRMED only for a well-formed answer that shows the change;
 *    a transport failure, 5xx, 408 or unreadable answer is UNCONFIRMED, never "did not apply"
 *  - LinkedIn's allowlist 403 is a customer message and never "applied"; a 429 is structured
 *  - no credential appears in a result or an error; refreshes are single-flight and saved before use
 * Mock-only: there is no LinkedIn test ad account, so nothing here is live verification.
 */
const mockAxiosFn = jest.fn();
jest.mock('axios', () => {
  const fn = (...args: any[]) => mockAxiosFn(...args);
  (fn as any).post = jest.fn();
  (fn as any).get = jest.fn();
  (fn as any).put = jest.fn().mockResolvedValue({ data: {} });
  return { __esModule: true, default: fn };
});
jest.mock('../config/integrations', () => ({
  INTEGRATION_CONFIG: { linkedinAds: { apiVersion: '202603', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken' } },
}));
jest.mock('../mcp/zomaOnboarding', () => ({
  assertZomaWriteReady: jest.fn(),
  ZomaNotReadyError: class ZomaNotReadyError extends Error {},
}));

import * as realService from '../services/linkedInAdsService';
import {
  amountToMicros, ceilingForCurrency, DEFAULT_LINKEDIN_SPEND_CEILING, defaultLinkedInAdsWriteDeps, executeLinkedInAdsWrite,
  linkedInSpendCeilingFromEnv, validateLinkedInAdsWriteShape, type LinkedInAdsWriteDeps,
} from '../mcp/linkedInAdsToolkitWrites';
import { handleLinkedInAdsToolkitCall, LINKEDIN_ADS_CALLS_PER_MINUTE } from '../mcp/linkedInAdsToolkitGateway';
import { LINKEDIN_WRITE_NOT_ENABLED, LINKEDIN_WRITES_NOT_AVAILABLE, type LinkedInAdsSession } from '../mcp/linkedInAdsCall';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { isZomaPublishWrite } from '../mcp/zomaBilling';
import {
  getFreshLinkedInAdsToken, LinkedInConnectionError, resetLinkedInRefreshesForTests, type LinkedInTokenDeps,
} from '../services/linkedInAdsCredentials';
import { ZomaNotReadyError } from '../mcp/zomaOnboarding';

const NOW = Date.parse('2026-11-20T00:00:00Z');
const START = Date.parse('2026-12-01T09:00:00Z');
const TOKEN = 'AQV-live-access-token-0123456789';
const ok = (data: any = {}): any => ({ success: true, status: 200, data });
const fail = (status: number | undefined, error = 'failed', extra: Record<string, unknown> = {}): any => ({ success: false, status, error, ...extra });
const trailing = (v: unknown) => /(\d+)\D*$/.exec(String(v))?.[1];
const money = (amount: string, currencyCode = 'USD') => ({ amount, currencyCode });

const session = (over: Partial<LinkedInAdsSession> = {}): LinkedInAdsSession => ({
  accountId: '5001', accessToken: TOKEN, currency: 'USD', freshToken: false, scopes: ['r_ads', 'r_ads_reporting', 'rw_ads'], sleep: async () => undefined, ...over,
});

/** A small in-memory LinkedIn ad account behind the same function names as linkedInAdsService. */
function fakeLinkedIn() {
  let seq = 0;
  const groups: Record<string, any> = {
    '7': { id: 7, name: 'Launch', status: 'DRAFT', runSchedule: { start: START }, totalBudget: money('500.00') },
  };
  const campaigns: Record<string, any> = {
    '11': {
      id: 11, name: 'Search', status: 'DRAFT', campaignGroup: 'urn:li:sponsoredCampaignGroup:7', type: 'SPONSORED_UPDATES', costType: 'CPC',
      unitCost: money('5.00'), dailyBudget: money('50.00'), runSchedule: { start: START, end: START + 30 * 86400000 },
    },
    '12': {
      id: 12, name: 'Live one', status: 'ACTIVE', campaignGroup: 'urn:li:sponsoredCampaignGroup:7', type: 'SPONSORED_UPDATES', costType: 'CPC',
      unitCost: money('5.00'), dailyBudget: money('80.00'), runSchedule: { start: START },
    },
  };
  const creatives: Record<string, any> = { '21': { id: 'urn:li:sponsoredCreative:21', intendedStatus: 'DRAFT', campaign: 'urn:li:sponsoredCampaign:11' } };
  const api = {
    getCampaignGroup: jest.fn(async (_t: string, _a: string, id: string) => (groups[id] ? ok({ ...groups[id] }) : fail(404, 'not found'))),
    getCampaign: jest.fn(async (_t: string, _a: string, id: string) => (campaigns[id] ? ok({ ...campaigns[id] }) : fail(404, 'not found'))),
    getCreative: jest.fn(async (_t: string, _a: string, id: string) => (creatives[trailing(id)!] ? ok({ ...creatives[trailing(id)!] }) : fail(404, 'not found'))),
    listCampaigns: jest.fn(async (_t: string, _a: string, p: any) => ok({
      elements: Object.values(campaigns).filter((c) => !p?.campaign_group_id || trailing(c.campaignGroup) === p.campaign_group_id),
    })),
    createCampaignGroup: jest.fn(async (_t: string, _a: string, p: any) => {
      const id = String(900 + ++seq);
      groups[id] = {
        id: Number(id), name: p.name, status: p.status, runSchedule: { start: p.run_schedule_start, ...(p.run_schedule_end ? { end: p.run_schedule_end } : {}) },
        ...(p.total_budget_amount ? { totalBudget: money(p.total_budget_amount, p.total_budget_currency) } : {}),
      };
      return ok({ id });
    }),
    updateCampaignGroup: jest.fn(async (_t: string, _a: string, id: string, p: any) => {
      if (p.status) groups[id].status = p.status;
      if (p.name) groups[id].name = p.name;
      if (p.total_budget_amount) groups[id].totalBudget = money(p.total_budget_amount, p.total_budget_currency);
      return ok({});
    }),
    createCampaign: jest.fn(async (_t: string, _a: string, p: any) => {
      const id = String(950 + ++seq);
      campaigns[id] = {
        id: Number(id), name: p.name, status: p.status, type: p.type, costType: p.cost_type, unitCost: money(p.unit_cost_amount, p.unit_cost_currency),
        dailyBudget: money(p.daily_budget_amount, p.daily_budget_currency), campaignGroup: `urn:li:sponsoredCampaignGroup:${p.campaign_group_id}`,
        runSchedule: { start: p.run_schedule_start, ...(p.run_schedule_end ? { end: p.run_schedule_end } : {}) },
        locale: { country: p.locale_country, language: p.locale_language },
        ...(p.total_budget_amount ? { totalBudget: money(p.total_budget_amount, p.total_budget_currency) } : {}),
      };
      return ok({ id });
    }),
    updateCampaign: jest.fn(async (_t: string, _a: string, id: string, p: any) => {
      const c = campaigns[id];
      if (p.status) c.status = p.status;
      if (p.name) c.name = p.name;
      if (p.daily_budget_amount) c.dailyBudget = money(p.daily_budget_amount, p.daily_budget_currency);
      if (p.total_budget_amount) c.totalBudget = money(p.total_budget_amount, p.total_budget_currency);
      if (p.unit_cost_amount) c.unitCost = money(p.unit_cost_amount, p.unit_cost_currency);
      if (p.run_schedule_start) c.runSchedule = { start: p.run_schedule_start, ...(p.run_schedule_end ? { end: p.run_schedule_end } : {}) };
      return ok({});
    }),
    createCreative: jest.fn(async (_t: string, p: any) => {
      const id = String(980 + ++seq);
      creatives[id] = {
        id: `urn:li:sponsoredCreative:${id}`, intendedStatus: p.status, campaign: `urn:li:sponsoredCampaign:${p.campaign_id}`,
        content: p.post_urn ? { reference: p.post_urn } : { textAd: { headline: p.headline, description: p.description, landingPage: `${p.landing_page}?utm_source=linkedin` } },
      };
      return ok({ id: `urn:li:sponsoredCreative:${id}` });
    }),
    updateCreativeStatus: jest.fn(async (_t: string, _a: string, id: string, status: string) => {
      creatives[trailing(id)!].intendedStatus = status;
      return ok({});
    }),
  };
  const mutating = ['createCampaignGroup', 'updateCampaignGroup', 'createCampaign', 'updateCampaign', 'createCreative', 'updateCreativeStatus'] as const;
  return { api, groups, campaigns, creatives, mutations: () => mutating.reduce((n, k) => n + api[k].mock.calls.length, 0) };
}

function deps(li = fakeLinkedIn(), over: Partial<LinkedInAdsWriteDeps> = {}): LinkedInAdsWriteDeps {
  return {
    api: li.api as any,
    assertReady: jest.fn().mockResolvedValue(undefined),
    spendCeiling: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
    writesEnabled: () => true,
    ...over,
  };
}

const twoStep = async (args: any, d: LinkedInAdsWriteDeps, s = session()) => {
  const preview: any = await executeLinkedInAdsWrite('u1', args, s, d);
  const result: any = await executeLinkedInAdsWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, s, d);
  return { preview, result };
};

const GROUP_CREATE = { entity_type: 'CAMPAIGN_GROUP', action: 'CREATE', name: 'Q4', start_time: '2026-12-01T09:00:00Z', total_budget: 1000 };
const CAMPAIGN_CREATE = {
  entity_type: 'CAMPAIGN', action: 'CREATE', campaign_group_id: '7', name: 'Brand', campaign_type: 'SPONSORED_UPDATES', objective_type: 'WEBSITE_VISIT',
  cost_type: 'CPC', unit_cost: 7.5, daily_budget: 40, start_time: '2026-12-01T09:00:00Z', locale_country: 'US', locale_language: 'en',
  political_intent: 'NOT_POLITICAL', targeting_include: [{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:103644278'] }],
};
const CREATIVE_CREATE = { entity_type: 'CREATIVE', action: 'CREATE', campaign_id: '11', post_urn: 'urn:li:share:7000000001' };

beforeEach(() => { jest.clearAllMocks(); resetLinkedInRefreshesForTests(); });

describe('preview and token', () => {
  it('a preview sends nothing and tells the user nothing is live; a write without a valid token sends nothing', async () => {
    const li = fakeLinkedIn();
    const d = deps(li);
    const preview: any = await executeLinkedInAdsWrite('u1', CAMPAIGN_CREATE, session(), d);
    expect(preview).toMatchObject({ status: 'PREVIEW', success: false, preview_token: expect.stringMatching(/^v1\./) });
    expect(preview.preview).toContain('as DRAFT (it cannot deliver)');
    expect(preview.preview).toContain('bid of 7.50 USD');
    expect(preview.preview).toContain('Daily budget: 40.00 USD');
    expect(li.mutations()).toBe(0);

    await expect(executeLinkedInAdsWrite('u1', { ...CAMPAIGN_CREATE, confirm: true }, session(), d)).rejects.toThrow(/preview_token is missing/);
    await expect(executeLinkedInAdsWrite('u1', { ...CAMPAIGN_CREATE, confirm: true, preview_token: 'v1.9999999999999.forged' }, session(), d)).rejects.toThrow(/preview_token is missing/);
    // A token for different arguments (the daily budget was raised after the preview) does not carry over.
    await expect(executeLinkedInAdsWrite('u1', { ...CAMPAIGN_CREATE, daily_budget: 400, confirm: true, preview_token: preview.preview_token }, session(), d))
      .rejects.toThrow(/does not match these arguments/);
    // Nor does one minted for another user.
    await expect(executeLinkedInAdsWrite('u2', { ...CAMPAIGN_CREATE, confirm: true, preview_token: preview.preview_token }, session(), d)).rejects.toThrow(/preview_token is missing/);
    expect(li.mutations()).toBe(0);
  });

  it('applies exactly once: the same token cannot be used twice', async () => {
    const li = fakeLinkedIn();
    const d = deps(li);
    const { result, preview } = await twoStep(CAMPAIGN_CREATE, d);
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(li.api.createCampaign).toHaveBeenCalledTimes(1);
    await expect(executeLinkedInAdsWrite('u1', { ...CAMPAIGN_CREATE, confirm: true, preview_token: preview.preview_token }, session(), d)).rejects.toThrow(/already used/);
    expect(li.api.createCampaign).toHaveBeenCalledTimes(1);
  });

  it('read mode: the executor itself refuses, before readiness, state or LinkedIn', async () => {
    const li = fakeLinkedIn();
    const d = deps(li, { writesEnabled: () => false });
    await expect(executeLinkedInAdsWrite('u1', GROUP_CREATE, session(), d)).rejects.toThrow(LINKEDIN_WRITES_NOT_AVAILABLE);
    expect(d.assertReady).not.toHaveBeenCalled();
    expect(li.api.getCampaignGroup).not.toHaveBeenCalled();
  });

  it('refuses without the write consent (rw_ads), without payment readiness, and says nothing was sent', async () => {
    const li = fakeLinkedIn();
    await expect(executeLinkedInAdsWrite('u1', GROUP_CREATE, session({ scopes: ['r_ads', 'r_ads_reporting'] }), deps(li))).rejects.toThrow(/without permission to change ads/);
    const unpaid = deps(li, { assertReady: jest.fn().mockRejectedValue(new ZomaNotReadyError('No payment method on file')) });
    await expect(executeLinkedInAdsWrite('u1', GROUP_CREATE, session(), unpaid)).rejects.toThrow(/No payment method/);
    expect(li.api.getCampaignGroup).not.toHaveBeenCalled();
    expect(li.mutations()).toBe(0);
  });
});

describe('a create is never live and never relies on the shared service defaults', () => {
  it('every create is DRAFT and read back as DRAFT; nothing is live afterwards', async () => {
    const li = fakeLinkedIn();
    for (const args of [GROUP_CREATE, CAMPAIGN_CREATE, CREATIVE_CREATE, { ...CREATIVE_CREATE, post_urn: undefined, headline: 'Hello', description: 'World', landing_page: 'https://example.com/lp' }]) {
      const { result } = await twoStep(args, deps(li));
      expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'DRAFT' });
      expect(result.message).toContain('created DRAFT: nothing is live');
    }
    expect(li.api.createCampaignGroup.mock.calls[0][2]).toMatchObject({ status: 'DRAFT' });
    expect(li.api.createCampaign.mock.calls[0][2]).toMatchObject({ status: 'DRAFT' });
    expect(li.api.createCreative.mock.calls.every(([, p]) => p.status === 'DRAFT')).toBe(true);
    const everything = [...Object.values(li.groups), ...Object.values(li.campaigns).filter((c) => c.id > 900), ...Object.values(li.creatives).filter((c) => trailing(c.id)! > '900')];
    expect(everything.filter((e) => (e.status ?? e.intendedStatus) === 'ACTIVE' && Number(trailing(e.id)) > 900)).toEqual([]);
  });

  it('a request that asks for an active create (or carries any status) is refused before anything is read or sent', async () => {
    const li = fakeLinkedIn();
    const d = deps(li);
    for (const extra of [{ status: 'ACTIVE' }, { intended_status: 'ACTIVE' }, { entity_status: 'ACTIVE' }, { status: 'DRAFT' }]) {
      for (const base of [GROUP_CREATE, CAMPAIGN_CREATE, CREATIVE_CREATE]) {
        await expect(executeLinkedInAdsWrite('u1', { ...base, ...extra }, session(), d)).rejects.toThrow(/always created as DRAFT/);
      }
    }
    expect(d.assertReady).not.toHaveBeenCalled();
    expect(li.api.getCampaignGroup).not.toHaveBeenCalled();
    expect(li.mutations()).toBe(0);
  });

  it('every value LinkedIn needs must be given: each missing campaign field is refused with nothing read or sent', async () => {
    const li = fakeLinkedIn();
    const d = deps(li);
    for (const key of [
      'campaign_group_id', 'name', 'campaign_type', 'objective_type', 'cost_type', 'unit_cost', 'daily_budget', 'start_time',
      'locale_country', 'locale_language', 'political_intent', 'targeting_include',
    ]) {
      const { [key]: _omitted, ...args } = CAMPAIGN_CREATE as Record<string, unknown>;
      await expect(executeLinkedInAdsWrite('u1', args, session(), d)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    }
    await expect(executeLinkedInAdsWrite('u1', { ...CAMPAIGN_CREATE, campaign_type: 'DYNAMIC' }, session(), d)).rejects.toThrow(/campaign_type is required/);
    await expect(executeLinkedInAdsWrite('u1', { ...GROUP_CREATE, start_time: undefined }, session(), d)).rejects.toThrow(/start_time/);
    await expect(executeLinkedInAdsWrite('u1', { ...CREATIVE_CREATE, headline: 'x' }, session(), d)).rejects.toThrow(/either post_urn or the text-ad fields/);
    await expect(executeLinkedInAdsWrite('u1', { ...CREATIVE_CREATE, post_urn: undefined, headline: 'x', description: 'y', landing_page: 'http://example.com' }, session(), d)).rejects.toThrow(/https/);
    expect(li.api.getCampaignGroup).not.toHaveBeenCalled();
    expect(li.mutations()).toBe(0);
  });

  it('sent explicitly in the ad account\'s currency: the shared service defaults (2.00 USD, USD, US/en, ACTIVE) are never what goes out', async () => {
    mockAxiosFn.mockReset();
    const posts: Array<{ url: string; body: any }> = [];
    const store: Record<string, any> = {};
    mockAxiosFn.mockImplementation(async (cfg: any) => {
      const url = String(cfg.url).replace('https://api.linkedin.com', '');
      if (cfg.method === 'POST') {
        posts.push({ url, body: cfg.data });
        if (url.endsWith('/adCampaignGroups')) { store.group = { id: 901, name: cfg.data.name, status: cfg.data.status, runSchedule: cfg.data.runSchedule, totalBudget: cfg.data.totalBudget }; return { data: {}, headers: { 'x-restli-id': '901' }, status: 201 }; }
        if (url.endsWith('/adCampaigns')) {
          const b = cfg.data;
          store.campaign = { id: 951, name: b.name, status: b.status, type: b.type, costType: b.costType, unitCost: b.unitCost, dailyBudget: b.dailyBudget, campaignGroup: b.campaignGroup, runSchedule: b.runSchedule, locale: b.locale };
          return { data: {}, headers: { 'x-restli-id': '951' }, status: 201 };
        }
        if (url.endsWith('/creatives')) { store.creative = { id: 'urn:li:sponsoredCreative:981', intendedStatus: cfg.data.intendedStatus, campaign: cfg.data.campaign, content: cfg.data.content }; return { data: {}, headers: { 'x-restli-id': 'urn:li:sponsoredCreative:981' }, status: 201 }; }
      }
      if (url.includes('/adCampaignGroups/901')) return { data: store.group, headers: {}, status: 200 };
      if (url.includes('/adCampaignGroups/7')) return { data: { id: 7, name: 'Launch', status: 'DRAFT' }, headers: {}, status: 200 };
      if (url.includes('/adCampaigns/951')) return { data: store.campaign, headers: {}, status: 200 };
      if (url.includes('/adCampaigns/11')) return { data: { id: 11, name: 'Search', status: 'DRAFT' }, headers: {}, status: 200 };
      if (url.includes('/creatives/')) return { data: store.creative, headers: {}, status: 200 };
      throw new Error(`unexpected ${cfg.method} ${url}`);
    });
    const d = deps(fakeLinkedIn(), { api: realService as any });
    const eur = session({ currency: 'EUR' });
    const results = [
      (await twoStep({ ...GROUP_CREATE, total_budget: 1000 }, d, eur)).result,
      (await twoStep({ ...CAMPAIGN_CREATE, locale_country: 'DE', locale_language: 'de' }, d, eur)).result,
      (await twoStep(CREATIVE_CREATE, d, eur)).result,
    ];
    expect(results.map((r) => r.verification)).toEqual(['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    const [group, campaign, creative] = posts.map((p) => p.body);
    expect(group).toMatchObject({ status: 'DRAFT', totalBudget: { amount: '1000.00', currencyCode: 'EUR' }, runSchedule: { start: START } });
    expect(campaign).toMatchObject({
      status: 'DRAFT', type: 'SPONSORED_UPDATES', costType: 'CPC', unitCost: { amount: '7.50', currencyCode: 'EUR' },
      dailyBudget: { amount: '40.00', currencyCode: 'EUR' }, locale: { country: 'DE', language: 'de' },
      offsiteDeliveryEnabled: false, audienceExpansionEnabled: false, creativeSelection: 'OPTIMIZED', politicalIntent: 'NOT_POLITICAL',
      campaignGroup: 'urn:li:sponsoredCampaignGroup:7', runSchedule: { start: START },
    });
    expect(creative).toMatchObject({ intendedStatus: 'DRAFT', campaign: 'urn:li:sponsoredCampaign:11', content: { reference: 'urn:li:share:7000000001' } });
    expect(JSON.stringify(posts)).not.toMatch(/"ACTIVE"|2\.00|"USD"|"US"/);
  });
});

describe('ACTIVATE and PAUSE are their own previews', () => {
  it('activating shows what it unlocks and only a confirm of that preview activates', async () => {
    const li = fakeLinkedIn();
    const { preview, result } = await twoStep({ entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '11' }, deps(li));
    expect(preview.preview).toContain('DRAFT → ACTIVE');
    expect(preview.preview).toContain('can spend up to 50.00 USD/day');
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'ACTIVE' });
    expect(li.campaigns['11'].status).toBe('ACTIVE');
    const paused = await twoStep({ entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' }, deps(li));
    expect(paused.result).toMatchObject({ verification: 'CONFIRMED', status: 'PAUSED' });
  });

  it('refuses to change what cannot change, and says nothing was sent', async () => {
    const li = fakeLinkedIn();
    li.campaigns['11'].status = 'ARCHIVED';
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '11' }, session(), deps(li))).rejects.toThrow(/ARCHIVED and cannot be activated/);
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '12' }, session(), deps(li))).rejects.toThrow(/already ACTIVE/);
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '999' }, session(), deps(li))).rejects.toThrow(/was not found/);
    expect(li.mutations()).toBe(0);
  });

  it('LinkedIn replaces the whole schedule: a new start carries the stored end over', async () => {
    const li = fakeLinkedIn();
    const end = li.campaigns['11'].runSchedule.end;
    const { result } = await twoStep({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '11', start_time: '2026-12-15T09:00:00Z' }, deps(li));
    expect(li.api.updateCampaign.mock.calls[0][3]).toMatchObject({ run_schedule_start: Date.parse('2026-12-15T09:00:00Z'), run_schedule_end: end });
    expect(result.verification).toBe('CONFIRMED');
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '11', end_time: '2027-01-01T00:00:00Z' }, session(), deps(li))).rejects.toThrow(/needs start_time too/);
  });

  it('ACTIVATE is a publish write for the paywall; a create is not', () => {
    expect(isZomaPublishWrite('linkedin_ads', { entity_type: 'CAMPAIGN', action: 'ACTIVATE' })).toBe(true);
    expect(isZomaPublishWrite('linkedin_ads', { entity_type: 'CAMPAIGN', action: 'CREATE' })).toBe(false);
    expect(isZomaPublishWrite('linkedin_ads', { entity_type: 'CAMPAIGN', action: 'PAUSE' })).toBe(false);
  });
});

describe('spend ceiling (LINKEDIN_ADS_TOOLKIT_SPEND_CEILING, keyed by currency, micros)', () => {
  const ceiling = (value: unknown) => () => linkedInSpendCeilingFromEnv(typeof value === 'string' ? value : JSON.stringify(value));
  const usd100 = { USD: { maxDailyBudget: 100_000_000 } };

  it('unset or empty is the built-in default (USD only, 50.00 a day, 2x), never "no limit"; nothing new is required', async () => {
    expect(linkedInSpendCeilingFromEnv(undefined)).toBe(DEFAULT_LINKEDIN_SPEND_CEILING);
    expect(linkedInSpendCeilingFromEnv('')).toBe(DEFAULT_LINKEDIN_SPEND_CEILING);
    expect(DEFAULT_LINKEDIN_SPEND_CEILING).toEqual({ byCurrency: { USD: { maxDailyBudget: 50_000_000, maxChangeRatio: 2 } } });
    // the real deps read the env var at call time
    const saved = process.env.LINKEDIN_ADS_TOOLKIT_SPEND_CEILING;
    delete process.env.LINKEDIN_ADS_TOOLKIT_SPEND_CEILING;
    expect(defaultLinkedInAdsWriteDeps.spendCeiling()).toBe(DEFAULT_LINKEDIN_SPEND_CEILING);
    process.env.LINKEDIN_ADS_TOOLKIT_SPEND_CEILING = '{"EUR":{"maxDailyBudget":1000000}}';
    expect(defaultLinkedInAdsWriteDeps.spendCeiling()).toEqual({ byCurrency: { EUR: { maxDailyBudget: 1_000_000 } } });
    if (saved === undefined) delete process.env.LINKEDIN_ADS_TOOLKIT_SPEND_CEILING; else process.env.LINKEDIN_ADS_TOOLKIT_SPEND_CEILING = saved;
  });

  it('with the env var unset the default blocks a 51 USD daily budget and lets 50 through', async () => {
    const unset = () => linkedInSpendCeilingFromEnv(undefined);
    const li = fakeLinkedIn();
    await expect(executeLinkedInAdsWrite('u1', { ...CAMPAIGN_CREATE, daily_budget: 51 }, session(), deps(li, { spendCeiling: unset }))).rejects.toThrow(/exceeds this account's max daily budget of 50000000/);
    expect(li.mutations()).toBe(0);
    expect((await twoStep({ ...CAMPAIGN_CREATE, daily_budget: 50 }, deps(li, { spendCeiling: unset }))).result.verification).toBe('CONFIRMED');
    // and what an ACTIVATE unlocks: the live campaign at 80.00/day is over the default
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '11' }, session(), deps(li, { spendCeiling: unset }))).resolves.toMatchObject({ status: 'PREVIEW' });
    li.campaigns['11'].dailyBudget = money('80.00');
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '11' }, session(), deps(li, { spendCeiling: unset }))).rejects.toThrow(/Activating would start spend/);
  });

  it('with the env var unset a non-USD account is refused (the default covers USD only); the env var replaces the default', async () => {
    const unset = () => linkedInSpendCeilingFromEnv(undefined);
    const li = fakeLinkedIn();
    await expect(executeLinkedInAdsWrite('u1', CAMPAIGN_CREATE, session({ currency: 'EUR' }), deps(li, { spendCeiling: unset }))).rejects.toThrow(/does not cover EUR.*\(it covers USD\)/);
    expect(li.mutations()).toBe(0);
    const eurOnly = () => linkedInSpendCeilingFromEnv('{"EUR":{"maxDailyBudget":100000000}}');
    expect((await twoStep(CAMPAIGN_CREATE, deps(li, { spendCeiling: eurOnly }), session({ currency: 'EUR' }))).result.verification).toBe('CONFIRMED');
    await expect(executeLinkedInAdsWrite('u1', CAMPAIGN_CREATE, session({ currency: 'USD' }), deps(li, { spendCeiling: eurOnly }))).rejects.toThrow(/does not cover USD.*\(it covers EUR\)/);
  });

  it('maxChangeRatio: raising a live campaign, a total budget or a group total beyond the ratio is refused (the stored budgets are the prior)', async () => {
    const ratio = ceiling({ USD: { maxChangeRatio: 2 } });
    const li = fakeLinkedIn();
    li.campaigns['11'].totalBudget = money('1000.00');
    const d = () => deps(li, { spendCeiling: ratio });
    // daily: campaign 12 is ACTIVE at 80.00
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '12', daily_budget: 200 }, session(), d())).rejects.toThrow(/max single-change ratio of 2x/);
    expect((await twoStep({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '12', daily_budget: 160 }, d())).result.verification).toBe('CONFIRMED');
    // total on a campaign (1000.00 stored)
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '11', total_budget: 2500 }, session(), d())).rejects.toThrow(/lifetime_budget change 1000000000 -> 2500000000/);
    expect((await twoStep({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '11', total_budget: 2000 }, d())).result.verification).toBe('CONFIRMED');
    // total on a group (500.00 stored)
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN_GROUP', action: 'UPDATE', campaign_group_id: '7', total_budget: 1500 }, session(), d())).rejects.toThrow(/max single-change ratio of 2x/);
    expect((await twoStep({ entity_type: 'CAMPAIGN_GROUP', action: 'UPDATE', campaign_group_id: '7', total_budget: 1000 }, d())).result.verification).toBe('CONFIRMED');
  });

  it('a daily budget above the account currency\'s ceiling is refused with nothing sent; one at or under it passes', async () => {
    const li = fakeLinkedIn();
    await expect(executeLinkedInAdsWrite('u1', { ...CAMPAIGN_CREATE, daily_budget: 150 }, session(), deps(li, { spendCeiling: ceiling(usd100) }))).rejects.toThrow(/exceeds this account's max daily budget/);
    expect(li.mutations()).toBe(0);
    const { result } = await twoStep({ ...CAMPAIGN_CREATE, daily_budget: 100 }, deps(li, { spendCeiling: ceiling(usd100) }));
    expect(result.verification).toBe('CONFIRMED');
  });

  it('malformed input fails closed for every budget write (and a flat, unkeyed policy is malformed)', async () => {
    for (const raw of ['not json', '[]', '{"maxDailyBudget":100000000}', '{"usd":{"maxDailyBudget":1}}', '{"USD":5}', '{}', '{"USD":{"maxDailyBudget":"lots"}}']) {
      const li = fakeLinkedIn();
      await expect(executeLinkedInAdsWrite('u1', { ...CAMPAIGN_CREATE, daily_budget: 1 }, session(), deps(li, { spendCeiling: ceiling(raw) }))).rejects.toBeInstanceOf(MetaToolkitRefusal);
      expect(li.mutations()).toBe(0);
    }
    // A write that sets no budget is not a budget write.
    const li = fakeLinkedIn();
    const { result } = await twoStep({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '11', name: 'Renamed' }, deps(li, { spendCeiling: ceiling('not json') }));
    expect(result.verification).toBe('CONFIRMED');
  });

  it('refuses a budget write when the account currency is missing or not covered by the policy', async () => {
    const eurOnly = ceiling({ EUR: { maxDailyBudget: 100_000_000 } });
    const li = fakeLinkedIn();
    await expect(executeLinkedInAdsWrite('u1', CAMPAIGN_CREATE, session({ currency: 'USD' }), deps(li, { spendCeiling: eurOnly }))).rejects.toThrow(/does not cover USD/);
    await expect(executeLinkedInAdsWrite('u1', CAMPAIGN_CREATE, session({ currency: '' }), deps(li, { spendCeiling: () => null }))).rejects.toThrow(/no currency on record/);
    expect(ceilingForCurrency(linkedInSpendCeilingFromEnv(JSON.stringify(usd100)), '').refusal).toMatch(/no currency on record/);
    expect(ceilingForCurrency(linkedInSpendCeilingFromEnv(JSON.stringify(usd100)), 'JPY').refusal).toMatch(/does not cover JPY/);
    expect(li.mutations()).toBe(0);
  });

  it('an ACTIVATE is checked against the daily budget it unlocks (campaign, group and creative)', async () => {
    const li = fakeLinkedIn();
    const at = (max: number) => deps(li, { spendCeiling: ceiling({ USD: { maxDailyBudget: max * 1_000_000 } }) });
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '11' }, session(), at(40))).rejects.toThrow(/Activating would start spend/);
    // Group: its ACTIVE campaigns together (12 = 80); the DRAFT one (50) spends only after its own ACTIVATE.
    li.groups['7'].status = 'PAUSED';
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN_GROUP', action: 'ACTIVATE', campaign_group_id: '7' }, session(), at(70))).rejects.toThrow(/Activating would start spend/);
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CREATIVE', action: 'ACTIVATE', creative_id: '21' }, session(), at(40))).rejects.toThrow(/Activating would start spend/);
    expect(li.mutations()).toBe(0);
    const group = await twoStep({ entity_type: 'CAMPAIGN_GROUP', action: 'ACTIVATE', campaign_group_id: '7' }, at(100));
    expect(group.preview.preview).toContain('can spend up to 80.00 USD/day together');
    expect(group.result.verification).toBe('CONFIRMED');
    // With a ceiling set, a budget that cannot be bounded is refused rather than assumed small.
    delete li.campaigns['12'].dailyBudget;
    li.groups['7'].status = 'PAUSED';
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN_GROUP', action: 'ACTIVATE', campaign_group_id: '7' }, session(), at(1000))).rejects.toThrow(/cannot be bounded/);
  });

  it('money helpers: major units to micros and back, never a silent default', () => {
    expect(amountToMicros('12.50')).toBe(12_500_000);
    expect(amountToMicros('x')).toBeUndefined();
    expect(amountToMicros(undefined)).toBeUndefined();
    expect(() => validateLinkedInAdsWriteShape({ ...CAMPAIGN_CREATE, daily_budget: 10.123 }, 'USD')).toThrow(/more decimals/);
    expect(() => validateLinkedInAdsWriteShape({ ...CAMPAIGN_CREATE, daily_budget: 0 }, 'USD')).toThrow(/greater than 0/);
  });
});

describe('read-back (never exercised against a real LinkedIn account): conservative verdicts', () => {
  const PAUSE = { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' };
  /** Make the read-back (the GET after the write) answer `answer`; the preview GET answers normally. */
  const afterWrite = (li: ReturnType<typeof fakeLinkedIn>, answer: (real: any) => any) => {
    const real = li.api.getCampaign.getMockImplementation()!;
    li.api.updateCampaign.mockImplementation(async (...a: any[]) => {
      li.api.getCampaign.mockImplementation(async (...g: any[]) => answer(await real(...(g as [string, string, string]))));
      return ok({});
    });
  };

  it('CONFIRMED only when the answer shows the change', async () => {
    const { result } = await twoStep(PAUSE, deps());
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', id: '12' });
  });

  it('MISMATCH when LinkedIn accepted the write but its own answer shows a different value', async () => {
    const li = fakeLinkedIn();
    li.api.updateCampaign.mockResolvedValue(ok({})); // accepted, never applied
    const { result } = await twoStep(PAUSE, deps(li));
    expect(result).toMatchObject({ success: false, verification: 'MISMATCH', mismatched_fields: ['status'] });
  });

  it('UNCONFIRMED, never CONFIRMED, for a failed read, a missing field, a different object or an unexpected shape', async () => {
    const answers: Array<(row: any) => any> = [
      () => fail(503, 'unavailable'),
      () => fail(401, 'revoked'),
      (r) => ({ ...r, data: (({ status, ...rest }) => rest)(r.data) }),
      (r) => ({ ...r, data: { ...r.data, status: { value: 'PAUSED' } } }),
      (r) => ({ ...r, data: { ...r.data, id: 99999 } }),
      () => ok('<html>maintenance</html>'),
      () => ok(null),
      () => ok([]),
    ];
    for (const answer of answers) {
      const li = fakeLinkedIn();
      afterWrite(li, answer);
      const { result } = await twoStep(PAUSE, deps(li));
      expect(result.verification).toBe('UNCONFIRMED');
      expect(result.success).toBe(false);
      expect(result.message).toContain('did not confirm');
    }
  });

  it('a field LinkedIn does not echo is unreadable (UNCONFIRMED), not assumed; amounts compare as numbers', async () => {
    const li = fakeLinkedIn();
    afterWrite(li, (r) => ({ ...r, data: { ...r.data, dailyBudget: { amount: '60.0', currencyCode: 'USD' } } }));
    const { result } = await twoStep({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '11', daily_budget: 60 }, deps(li));
    expect(result.verification).toBe('CONFIRMED');
    const li2 = fakeLinkedIn();
    afterWrite(li2, (r) => ({ ...r, data: { ...r.data, dailyBudget: undefined } }));
    const second = await twoStep({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '11', daily_budget: 60 }, deps(li2));
    expect(second.result).toMatchObject({ verification: 'UNCONFIRMED', unreadable_fields: ['dailyBudget.amount', 'dailyBudget.currencyCode'] });
  });

  it('a create whose answer carries no id is UNCONFIRMED and says to list before retrying (never "did not apply")', async () => {
    const li = fakeLinkedIn();
    li.api.createCampaign.mockResolvedValue(ok({}));
    const { result } = await twoStep(CAMPAIGN_CREATE, deps(li));
    expect(result).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
    expect(result.message).toMatch(/returned no id/);
  });

  it('no response, 5xx and 408 on the write are UNCONFIRMED and say it may have applied; they are never reported as "did not apply"', async () => {
    for (const status of [undefined, 500, 502, 503, 408]) {
      const li = fakeLinkedIn();
      li.api.updateCampaign.mockResolvedValue(fail(status, status ? 'upstream trouble' : 'no response'));
      const { result } = await twoStep(PAUSE, deps(li));
      expect(result).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
      expect(result.message).toMatch(/may have applied/);
      expect(result.message).not.toMatch(/nothing was changed|did not apply/i);
    }
  });

  it('the service\'s own update read-back is carried through: a field that did not land is MISMATCH, an unreadable one UNCONFIRMED', async () => {
    const li = fakeLinkedIn();
    li.api.updateCampaign.mockResolvedValue(fail(200, 'unsupported_field: x', { errorType: 'unsupported_field', fields: ['status'] }));
    expect((await twoStep(PAUSE, deps(li))).result).toMatchObject({ verification: 'MISMATCH', mismatched_fields: ['status'] });
    const li2 = fakeLinkedIn();
    li2.api.updateCampaign.mockResolvedValue(fail(503, 'read_back_failed: x', { errorType: 'read_back_failed' }));
    expect((await twoStep(PAUSE, deps(li2))).result).toMatchObject({ verification: 'UNCONFIRMED' });
  });

  it('a definite rejection (4xx) says nothing was changed', async () => {
    const li = fakeLinkedIn();
    li.api.updateCampaign.mockResolvedValue(fail(400, 'runSchedule.start must be in the future'));
    const preview: any = await executeLinkedInAdsWrite('u1', PAUSE, session(), deps(li));
    await expect(executeLinkedInAdsWrite('u1', { ...PAUSE, confirm: true, preview_token: preview.preview_token }, session(), deps(li))).rejects.toThrow(/nothing was changed: runSchedule\.start/);
  });
});

describe('LinkedIn refusing the write', () => {
  const STAFF_403 = fail(
    403,
    'not configured to access the related advertiser account(s)\n\nThis is an AgentWeb platform configuration gap. Tell them this ad account (5001) needs to be allowlisted by AgentWeb staff',
  );

  it('the Development-tier 403 on the write is the customer message; it never says applied and never shows the staff text', async () => {
    const li = fakeLinkedIn();
    li.api.updateCampaign.mockResolvedValue(STAFF_403);
    const preview: any = await executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' }, session(), deps(li));
    const error: any = await executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12', confirm: true, preview_token: preview.preview_token }, session(), deps(li)).catch((e) => e);
    expect(error).toBeInstanceOf(MetaToolkitRefusal);
    expect(error.message).toBe(LINKEDIN_WRITE_NOT_ENABLED);
    expect(error.message).toMatch(/not enabled for this ad account yet.*nothing was changed.*reporting.*still works/i);
    expect(error.message).not.toMatch(/AgentWeb staff|allowlist/i);
    expect(li.campaigns['12'].status).toBe('ACTIVE');
  });

  it('the same 403 while reading the state for a preview gives the same message, and nothing is sent', async () => {
    const li = fakeLinkedIn();
    li.api.getCampaign.mockResolvedValue(STAFF_403);
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' }, session(), deps(li))).rejects.toThrow(LINKEDIN_WRITE_NOT_ENABLED);
    expect(li.mutations()).toBe(0);
  });

  it('a 429 on the write is a structured rate_limited result (nothing changed, no verification, no loop)', async () => {
    const li = fakeLinkedIn();
    li.api.updateCampaign.mockResolvedValue(fail(429, 'Too Many Requests'));
    const { result } = await twoStep({ entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' }, deps(li));
    expect(result).toMatchObject({ success: false, error_type: 'rate_limited', retry_after_seconds: 60 });
    expect(result).not.toHaveProperty('verification');
    expect(result.message).toMatch(/nothing was changed/);
    expect(li.api.updateCampaign).toHaveBeenCalledTimes(1);
  });

  it('a 401 on a fresh token is retried once before the write is refused with a reconnect message', async () => {
    const li = fakeLinkedIn();
    const sleep = jest.fn().mockResolvedValue(undefined);
    li.api.updateCampaign.mockResolvedValueOnce(fail(401, 'revoked')).mockImplementationOnce(async (...a: any[]) => { li.campaigns['12'].status = 'PAUSED'; return ok({}); });
    const { result } = await twoStep({ entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' }, deps(li), session({ freshToken: true, sleep }));
    expect(result.verification).toBe('CONFIRMED');
    expect(sleep).toHaveBeenCalledTimes(1);
    const li2 = fakeLinkedIn();
    li2.api.updateCampaign.mockResolvedValue(fail(401, 'revoked'));
    const preview: any = await executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' }, session({ freshToken: true, sleep }), deps(li2));
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12', confirm: true, preview_token: preview.preview_token }, session({ freshToken: true, sleep }), deps(li2)))
      .rejects.toThrow(/needs to be reconnected.*Nothing was changed/);
    expect(li2.api.updateCampaign).toHaveBeenCalledTimes(2);
  });
});

describe('the ceiling compares money in the account\'s own currency', () => {
  const usdCeiling = () => linkedInSpendCeilingFromEnv('{"USD":{"maxDailyBudget":1000000000,"maxChangeRatio":10}}');
  const d = (li: ReturnType<typeof fakeLinkedIn>) => deps(li, { spendCeiling: usdCeiling });

  it('an ACTIVATE whose budget is in another currency, or in none, is refused before the ceiling is applied', async () => {
    for (const code of ['EUR', undefined]) {
      const li = fakeLinkedIn();
      li.campaigns['11'].dailyBudget = { amount: '10.00', currencyCode: code };
      await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '11' }, session(), d(li))).rejects.toThrow(/cannot be checked against the spend ceiling/);
      // group: one of its live campaigns; creative: its campaign
      const g = fakeLinkedIn();
      g.campaigns['12'].dailyBudget = { amount: '10.00', currencyCode: code };
      g.groups['7'].status = 'PAUSED';
      await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN_GROUP', action: 'ACTIVATE', campaign_group_id: '7' }, session(), d(g))).rejects.toThrow(/cannot be checked against the spend ceiling/);
      const c = fakeLinkedIn();
      c.campaigns['11'].dailyBudget = { amount: '10.00', currencyCode: code };
      await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CREATIVE', action: 'ACTIVATE', creative_id: '21' }, session(), d(c))).rejects.toThrow(/cannot be checked against the spend ceiling/);
      expect(li.mutations() + g.mutations() + c.mutations()).toBe(0);
    }
  });

  it('an update compared against a stored budget in another currency is refused; the same currency (any letter case) passes', async () => {
    const li = fakeLinkedIn();
    li.campaigns['12'].dailyBudget = money('80.00', 'EUR');
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '12', daily_budget: 90 }, session(), d(li))).rejects.toThrow(/in EUR, but this ad account's currency is USD/);
    li.campaigns['12'].dailyBudget = money('80.00', 'USD');
    expect((await twoStep({ entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '12', daily_budget: 90 }, d(li))).result.verification).toBe('CONFIRMED');
  });
});

describe('a 401 on the service\'s own read-back after an update is not "nothing was changed"', () => {
  it('is UNCONFIRMED, is not retried (no second POST) and does not claim nothing changed', async () => {
    const li = fakeLinkedIn();
    const sleep = jest.fn().mockResolvedValue(undefined);
    li.api.updateCampaign.mockResolvedValue(fail(401, 'read_back_failed: LinkedIn accepted the update but the read-back request failed', { errorType: 'read_back_failed' }));
    const { result } = await twoStep({ entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '11' }, deps(li), session({ freshToken: true, sleep }));
    expect(result).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
    expect(result.message).toMatch(/accepted by LinkedIn but the read-back request failed/);
    expect(result.message).not.toMatch(/nothing was changed|reconnect/i);
    expect(li.api.updateCampaign).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('while a 401 on the update itself is still a reconnect refusal (and is the only one retried)', async () => {
    const li = fakeLinkedIn();
    li.api.updateCampaign.mockResolvedValue(fail(401, 'revoked'));
    const preview: any = await executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '11' }, session(), deps(li));
    await expect(executeLinkedInAdsWrite('u1', { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '11', confirm: true, preview_token: preview.preview_token }, session(), deps(li))).rejects.toThrow(/needs to be reconnected.*Nothing was changed/);
  });
});

describe('the preview echoes every value that will be sent', () => {
  const preview = async (li: ReturnType<typeof fakeLinkedIn>, args: any) => ((await executeLinkedInAdsWrite('u1', args, session(), deps(li))) as any).preview as string;
  const seededCreative = () => {
    const li = fakeLinkedIn();
    li.creatives['21'].content = { textAd: { headline: 'Seed headline', description: 'Seed description', landingPage: 'https://seed.example/lp?utm_source=linkedin', image: 'urn:li:image:SEEDIMG' } };
    return li;
  };
  const cases: Array<{ name: string; li?: () => ReturnType<typeof fakeLinkedIn>; args: any; values: string[] }> = [
    { name: 'CAMPAIGN_GROUP CREATE', args: { ...GROUP_CREATE, end_time: '2027-03-01T00:00:00Z' }, values: ['Q4', '2026-12-01T09:00:00Z', '2027-03-01T00:00:00Z', '1000'] },
    {
      name: 'CAMPAIGN CREATE',
      args: {
        ...CAMPAIGN_CREATE, total_budget: 900, end_time: '2027-01-01T00:00:00Z',
        targeting_exclude: [{ facet_urn: 'urn:li:adTargetingFacet:seniorities', values: ['urn:li:seniority:2', 'urn:li:seniority:3'] }],
      },
      values: [
        '7', 'Launch', 'Brand', 'SPONSORED_UPDATES', 'WEBSITE_VISIT', 'CPC', '7.5', '40', '900', '2026-12-01T09:00:00Z', '2027-01-01T00:00:00Z', 'US', 'en',
        'NOT_POLITICAL', 'urn:li:adTargetingFacet:locations', 'urn:li:geo:103644278', 'urn:li:adTargetingFacet:seniorities', 'urn:li:seniority:2', 'urn:li:seniority:3',
      ],
    },
    { name: 'CREATIVE CREATE (post)', args: CREATIVE_CREATE, values: ['11', 'Search', 'urn:li:share:7000000001'] },
    {
      name: 'CREATIVE CREATE (text ad)',
      args: { ...CREATIVE_CREATE, post_urn: undefined, headline: 'Hello there', description: 'A longer description', landing_page: 'https://example.com/lp?x=1', image_urn: 'urn:li:image:C4E10AQabc' },
      values: ['11', 'Hello there', 'A longer description', 'https://example.com/lp?x=1', 'urn:li:image:C4E10AQabc'],
    },
    { name: 'CAMPAIGN_GROUP UPDATE', args: { entity_type: 'CAMPAIGN_GROUP', action: 'UPDATE', campaign_group_id: '7', name: 'Renamed group', total_budget: 450 }, values: ['7', 'Launch', 'Renamed group', '450'] },
    {
      name: 'CAMPAIGN UPDATE',
      args: { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: '11', name: 'Renamed', daily_budget: 45, total_budget: 700, unit_cost: 6.25, start_time: '2026-12-20T09:00:00Z', end_time: '2027-02-01T00:00:00Z' },
      values: ['11', 'Search', 'Renamed', '45', '700', '6.25', '2026-12-20T09:00:00Z', '2027-02-01T00:00:00Z'],
    },
    { name: 'CAMPAIGN_GROUP PAUSE', args: { entity_type: 'CAMPAIGN_GROUP', action: 'PAUSE', campaign_group_id: '7' }, values: ['7', 'Launch', 'PAUSED'] },
    { name: 'CAMPAIGN_GROUP ACTIVATE', args: { entity_type: 'CAMPAIGN_GROUP', action: 'ACTIVATE', campaign_group_id: '7' }, values: ['7', 'Launch', 'ACTIVE', 'Search', 'Live one', '80.00'] },
    { name: 'CAMPAIGN PAUSE', args: { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' }, values: ['12', 'Live one', 'PAUSED'] },
    { name: 'CAMPAIGN ACTIVATE', args: { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '11', start_time: '2026-12-15T09:00:00Z' }, values: ['11', 'Search', 'ACTIVE', '2026-12-15T09:00:00Z', '50.00'] },
    {
      name: 'CREATIVE PAUSE', li: seededCreative, args: { entity_type: 'CREATIVE', action: 'PAUSE', creative_id: '21' },
      values: ['21', 'PAUSED', 'Seed headline', 'Seed description', 'https://seed.example/lp?utm_source=linkedin', 'urn:li:image:SEEDIMG'],
    },
    {
      name: 'CREATIVE ACTIVATE (shows what goes live)', li: seededCreative, args: { entity_type: 'CREATIVE', action: 'ACTIVATE', creative_id: '21' },
      values: ['21', 'ACTIVE', 'Seed headline', 'Seed description', 'https://seed.example/lp?utm_source=linkedin', 'urn:li:image:SEEDIMG', 'Search'],
    },
  ];

  it.each(cases)('$name: each submitted value is in the preview', async ({ li, args, values }) => {
    const text = await preview((li ?? fakeLinkedIn)(), args);
    for (const value of values) expect(text).toContain(value);
  });

  it('a creative that references a post shows the post on ACTIVATE', async () => {
    const li = fakeLinkedIn();
    li.creatives['21'].content = { reference: 'urn:li:share:555' };
    expect(await preview(li, { entity_type: 'CREATIVE', action: 'ACTIVATE', creative_id: '21' })).toContain('urn:li:share:555');
  });

  it('the token is bound to what the preview showed: a creative whose content changed since cannot be activated with the old token', async () => {
    const li = seededCreative();
    const args = { entity_type: 'CREATIVE', action: 'ACTIVATE', creative_id: '21' };
    const first: any = await executeLinkedInAdsWrite('u1', args, session(), deps(li));
    li.creatives['21'].content.textAd.landingPage = 'https://evil.example/phish';
    await expect(executeLinkedInAdsWrite('u1', { ...args, confirm: true, preview_token: first.preview_token }, session(), deps(li))).rejects.toThrow(/does not match these arguments/);
    expect(li.mutations()).toBe(0);
  });
});

describe('no credential in any output', () => {
  it('previews, results and errors across success, mismatch and failure never contain the access token', async () => {
    const outputs: string[] = [];
    const run = async (li: ReturnType<typeof fakeLinkedIn>, args: any) => {
      try {
        const { preview, result } = await twoStep(args, deps(li));
        outputs.push(JSON.stringify(preview), JSON.stringify(result));
      } catch (error) {
        outputs.push(String((error as Error).message));
      }
    };
    await run(fakeLinkedIn(), CAMPAIGN_CREATE);
    const mismatch = fakeLinkedIn(); mismatch.api.updateCampaign.mockResolvedValue(ok({}));
    await run(mismatch, { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' });
    const leaky = fakeLinkedIn(); leaky.api.updateCampaign.mockResolvedValue(fail(400, `bad request Bearer ${TOKEN} access_token=${TOKEN}`));
    await run(leaky, { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' });
    const gone = fakeLinkedIn(); gone.api.updateCampaign.mockResolvedValue(fail(502, `gateway ${TOKEN}`));
    await run(gone, { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' });
    expect(outputs.length).toBeGreaterThanOrEqual(6);
    for (const out of outputs) expect(out).not.toContain(TOKEN);
  });
});

describe('gateway', () => {
  const account = (over: Record<string, unknown> = {}) => ({
    platform: 'linkedin_ads', account_id: '5001', account_name: 'Acme',
    config: { account_type: 'ad_account', currency: 'USD', access_token: TOKEN, refresh_token: 'RT-SECRET', token_expires_at: NOW + 40 * 86400000, scopes: ['rw_ads'] },
    ...over,
  });
  const gw = (accounts: any[], over: Record<string, any> = {}) => {
    const d: any = {
      listAccounts: jest.fn().mockResolvedValue(accounts),
      now: () => NOW,
      meter: jest.fn().mockResolvedValue(true),
      recordWrite: jest.fn().mockResolvedValue(true),
      accessError: (m: string) => Object.assign(new Error(m), { status: 403 }),
      writesEnabled: () => true,
      throttle: { check: jest.fn().mockReturnValue({ allowed: true, resetInMs: 0 }) },
      executeRead: jest.fn().mockResolvedValue({ success: true, data: [] }),
      executeWrite: jest.fn().mockResolvedValue({ status: 'PREVIEW', success: false, preview_token: 'v1.1.x' }),
      ...over,
    };
    return d;
  };
  const caller = { userId: 'u1', authMethod: 'api_key' as const };
  const READ = { toolName: 'linkedin_ads_read', args: { action: 'LIST_CAMPAIGNS' } };
  const WRITE = { toolName: 'linkedin_ads_write', args: { entity_type: 'CAMPAIGN', action: 'PAUSE', campaign_id: '12' } };

  it('a preview is metered as a call but is not a write event; a write with a read-back verdict is recorded once as linkedin_ads', async () => {
    const d = gw([account()]);
    await handleLinkedInAdsToolkitCall(caller, WRITE, d);
    expect(d.recordWrite).not.toHaveBeenCalled();
    expect(d.meter).toHaveBeenCalledTimes(1);
    d.executeWrite.mockResolvedValue({ success: true, verification: 'CONFIRMED', id: '12' });
    await handleLinkedInAdsToolkitCall(caller, WRITE, d);
    expect(d.recordWrite).toHaveBeenCalledTimes(1);
    expect(d.recordWrite).toHaveBeenCalledWith(expect.objectContaining({ platform: 'linkedin_ads', entityType: 'CAMPAIGN', action: 'PAUSE', verification: 'CONFIRMED', objectId: '12' }));
    // A metering failure never turns an executed write into a failure that invites a retry.
    d.recordWrite.mockRejectedValue(new Error('db down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await handleLinkedInAdsToolkitCall(caller, WRITE, d)).toMatchObject({ verification: 'CONFIRMED', metering: expect.stringContaining('failed') });
  });

  it('the session handed to the executors carries the stored token and currency, and the result is returned as is', async () => {
    const d = gw([account()]);
    await handleLinkedInAdsToolkitCall(caller, READ, d);
    expect(d.executeRead.mock.calls[0][1]).toMatchObject({ accountId: '5001', accessToken: TOKEN, currency: 'USD', scopes: ['rw_ads'] });
  });

  it('read mode: the write tool is refused before the account list is read', async () => {
    const d = gw([account()], { writesEnabled: () => false });
    await expect(handleLinkedInAdsToolkitCall(caller, WRITE, d)).rejects.toThrow(LINKEDIN_WRITES_NOT_AVAILABLE);
    expect(d.listAccounts).not.toHaveBeenCalled();
    expect(d.executeWrite).not.toHaveBeenCalled();
  });

  it('Zoma\'s per-user throttle answers rate_limited without touching accounts or LinkedIn', async () => {
    expect(LINKEDIN_ADS_CALLS_PER_MINUTE).toBeGreaterThan(0);
    const d = gw([account()], { throttle: { check: jest.fn().mockReturnValue({ allowed: false, resetInMs: 12_300 }) } });
    const result: any = await handleLinkedInAdsToolkitCall(caller, READ, d);
    expect(result).toMatchObject({ success: false, error_type: 'rate_limited', retry_after_seconds: 13 });
    expect(d.listAccounts).not.toHaveBeenCalled();
    expect(d.executeRead).not.toHaveBeenCalled();
    expect(d.meter).toHaveBeenCalledWith(result); // audited as a failed call, which is not billable
  });

  it('account resolution: ambiguous, not connected, no usable connection', async () => {
    await expect(handleLinkedInAdsToolkitCall(caller, READ, gw([account(), account({ account_id: '5002' })]))).rejects.toThrow('Multiple LinkedIn Ads accounts are connected; pass account_id.');
    await expect(handleLinkedInAdsToolkitCall(caller, { ...READ, args: { ...READ.args, account_id: '9' } }, gw([account()]))).rejects.toThrow("LinkedIn Ads account 9 isn't connected; connected: 5001.");
    const noToken = account({ config: { account_type: 'ad_account', currency: 'USD' } });
    await expect(handleLinkedInAdsToolkitCall(caller, READ, gw([noToken]))).rejects.toMatchObject({ status: 403 });
    const urn = await handleLinkedInAdsToolkitCall(caller, { ...READ, args: { ...READ.args, account_id: 'urn:li:sponsoredAccount:5001' } }, gw([account()]));
    expect(urn).toMatchObject({ success: true });
  });

  it('an org-shared account is refreshed on its owner\'s record, and a connection that cannot be renewed is a 403', async () => {
    const getToken = jest.fn().mockResolvedValue({ accessToken: 'fresh', fresh: true });
    const d = gw([account({ userId: 'owner-9' })], { getToken });
    await handleLinkedInAdsToolkitCall(caller, READ, d);
    expect(getToken).toHaveBeenCalledWith('owner-9', expect.objectContaining({ account_id: '5001' }));
    expect(d.executeRead.mock.calls[0][1]).toMatchObject({ accessToken: 'fresh', freshToken: true });
    const broken = gw([account()], { getToken: jest.fn().mockRejectedValue(new LinkedInConnectionError('reconnect', 'Reconnect LinkedIn Ads.')) });
    await expect(handleLinkedInAdsToolkitCall(caller, READ, broken)).rejects.toMatchObject({ status: 403, message: 'Reconnect LinkedIn Ads.' });
  });
});

describe('token refresh: single flight, saved before use, no secret in an error', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    platform: 'linkedin_ads', account_id: '5001', account_name: 'Acme',
    config: { account_type: 'ad_account', access_token: 'old-access', refresh_token: 'RT-1', token_expires_at: NOW - 1000, ...over },
  }) as any;
  const tokenDeps = (over: Partial<LinkedInTokenDeps> = {}) => {
    const events: string[] = [];
    const d: LinkedInTokenDeps = {
      now: () => NOW,
      loadOAuthConfig: jest.fn().mockResolvedValue({ clientId: 'cid', clientSecret: 'CLIENT-SECRET' }),
      refresh: jest.fn(async () => { events.push('refresh'); await new Promise((r) => setImmediate(r)); return { access_token: 'new-access', refresh_token: 'RT-2', expires_in: 5183944 }; }),
      saveTokens: jest.fn(async () => { await new Promise((r) => setImmediate(r)); events.push('save'); }),
      ...over,
    };
    return { d, events };
  };

  it('a good stored token is used as is; an expired one is refreshed and saved to the owner before it is returned', async () => {
    const { d, events } = tokenDeps();
    const good = await getFreshLinkedInAdsToken('u1', stored({ token_expires_at: NOW + 40 * 86400000 }), d);
    expect(good.accessToken).toBe('old-access');
    expect(d.refresh).not.toHaveBeenCalled();
    const renewed = await getFreshLinkedInAdsToken('owner-9', stored(), d);
    events.push('returned');
    expect(renewed).toEqual({ accessToken: 'new-access', fresh: true });
    expect(events).toEqual(['refresh', 'save', 'returned']);
    expect(d.saveTokens).toHaveBeenCalledWith('owner-9', '5001', { access_token: 'new-access', refresh_token: 'RT-2', token_expires_at: NOW + 5183944 * 1000 });
  });

  it('concurrent calls for one account share one refresh and one save; another account refreshes on its own', async () => {
    const { d } = tokenDeps();
    const results = await Promise.all([
      getFreshLinkedInAdsToken('u1', stored(), d), getFreshLinkedInAdsToken('u1', stored(), d), getFreshLinkedInAdsToken('u1', stored(), d),
      getFreshLinkedInAdsToken('u1', { ...stored(), account_id: '5002' }, d),
    ]);
    expect(results.every((r) => r.accessToken === 'new-access')).toBe(true);
    expect(d.refresh).toHaveBeenCalledTimes(2);
    expect(d.saveTokens).toHaveBeenCalledTimes(2);
  });

  it('a token minted minutes ago is "fresh" (a first 401 is retried once); an old one is not', async () => {
    const { d } = tokenDeps();
    const justMinted = await getFreshLinkedInAdsToken('u1', stored({ token_expires_at: NOW + 60 * 86400000 - 60_000 }), d);
    expect(justMinted.fresh).toBe(true);
    const old = await getFreshLinkedInAdsToken('u1', stored({ token_expires_at: NOW + 20 * 86400000 }), d);
    expect(old.fresh).toBe(false);
  });

  it('refuses to use a token it could not save, and a rejected refresh asks for a reconnect without any secret', async () => {
    const saveFails = tokenDeps({ saveTokens: jest.fn().mockRejectedValue(new Error('ConnectedAccountChanged')) });
    await expect(getFreshLinkedInAdsToken('u1', stored(), saveFails.d)).rejects.toMatchObject({ kind: 'temporary' });
    resetLinkedInRefreshesForTests();
    const secretError = Object.assign(new Error('Request failed with status code 400 client_secret=CLIENT-SECRET refresh_token=RT-1'), { response: { status: 400 } });
    const rejected = tokenDeps({ refresh: jest.fn().mockRejectedValue(secretError) });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const error: any = await getFreshLinkedInAdsToken('u1', stored(), rejected.d).catch((e) => e);
    expect(error).toBeInstanceOf(LinkedInConnectionError);
    expect(error).toMatchObject({ kind: 'reconnect' });
    expect(error.message).not.toMatch(/CLIENT-SECRET|RT-1/);
    expect(rejected.d.saveTokens).not.toHaveBeenCalled();
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(/CLIENT-SECRET|RT-1/);
    await expect(getFreshLinkedInAdsToken('u1', stored({ refresh_token: undefined }), tokenDeps().d)).rejects.toMatchObject({ kind: 'reconnect' });
    const network = tokenDeps({ refresh: jest.fn().mockRejectedValue(new Error('ECONNRESET')) });
    resetLinkedInRefreshesForTests();
    await expect(getFreshLinkedInAdsToken('u1', stored(), network.d)).rejects.toMatchObject({ kind: 'temporary' });
  });

  it('a failed refresh is not remembered: the next call tries again', async () => {
    const refresh = jest.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce({ access_token: 'second-try', expires_in: 3600 });
    const { d } = tokenDeps({ refresh });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(getFreshLinkedInAdsToken('u1', stored(), d)).rejects.toBeInstanceOf(LinkedInConnectionError);
    expect((await getFreshLinkedInAdsToken('u1', stored(), d)).accessToken).toBe('second-try');
  });
});
