/**
 * ZOMA_LINKEDIN_ADS_ENABLED — one env var, three states, and the product is unchanged while it is off.
 *
 *   unset / anything but "read" or "true": OFF. Nothing is listed, routed, offered in zoma_status,
 *     named in any customer-facing text, or reachable through the connect pages; what the toolkit
 *     advertises and zoma_status returns is exactly what Meta, Google and X alone produce.
 *   "read": linkedin_ads_read, the zoma_status block, the connect pages. linkedin_ads_write is not
 *     listed, not routable and refused at call time (before any account lookup or LinkedIn call).
 *   "true": both tools.
 * Mock-only: there is no LinkedIn test ad account.
 */
import fs from 'fs';
import path from 'path';

jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserIdIncludingOrgShared: jest.fn(),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../services/linkedInAdsService', () => ({
  listAdAccounts: jest.fn(), listCampaignGroups: jest.fn(), listCampaigns: jest.fn(), listCreatives: jest.fn(),
  listTargetingFacets: jest.fn(), searchTargetingEntities: jest.fn(), getAudienceCount: jest.fn(), getAdAnalytics: jest.fn(),
  resolveTargetingCriteria: jest.fn(),
}));

import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { formatZomaStatus, getZomaReadiness } from '../mcp/zomaOnboarding';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { getGoogleToolkitManifest } from '../mcp/googleToolkitManifest';
import { getXAdsToolkitManifest } from '../mcp/xAdsToolkitManifest';
import { annotateToolkitTools } from '../mcp/toolkitToolAnnotations';
import { databricksToolView } from '../mcp/zomaDatabricksReadOnly';
import { adsExperienceQuestionText, zomaAdsExperienceOptions, zomaNewToAdsSteps } from '../mcp/zomaAdsExperience';
import { zomaErrorNextStep } from '../mcp/zomaNextStep';
import { linkedInAdsMode, linkedInAdsToolkitEnabled, linkedInAdsWritesEnabled, zomaToolDefinitions } from '../mcp/zomaToolDefinitions';
import { LINKEDIN_WRITES_NOT_AVAILABLE } from '../mcp/linkedInAdsCall';
import * as linkedInAdsService from '../services/linkedInAdsService';
import { formatZomaUsage } from '../mcp/zomaOnboarding';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toolkitManifest, zomaMcpInstructions, zomaSkillDoc } = require('../routes/metaToolkit');

const NOW = Date.parse('2026-11-20T00:00:00Z');
const LINKEDIN = /linkedin/i;
const doc = fs.readFileSync(path.join(__dirname, '../../docs/meta-toolkit-skill.md'), 'utf-8');

const liAccount = (over: Record<string, unknown> = {}) => ({
  platform: 'linkedin_ads',
  account_id: '5001',
  account_name: 'Acme',
  config: {
    account_type: 'ad_account', currency: 'USD', status: 'ACTIVE', access_token: 'LI-ACCESS-SECRET', refresh_token: 'LI-REFRESH-SECRET',
    token_expires_at: NOW + 40 * 24 * 3600 * 1000, scopes: ['r_ads', 'r_ads_reporting', 'rw_ads'], ...over,
  },
});
const metaAccount = () => ({
  platform: 'meta', account_id: 'act_1', account_name: 'Meta',
  config: { account_type: 'ad_account', ad_account_id: 'act_1', access_token: 'm', token_expires_at: NOW + 1e9 },
});

function gatewayDeps(accounts: any[], over: Partial<MetaToolkitGatewayDeps> = {}): MetaToolkitGatewayDeps {
  return {
    validateApiKey: jest.fn().mockResolvedValue({ userId: 'u-flag', keyId: 'k1' }),
    validateOAuthToken: jest.fn().mockResolvedValue(null),
    listAccounts: jest.fn().mockResolvedValue(accounts),
    execute: jest.fn().mockResolvedValue({ success: true }) as any,
    recordUsage: jest.fn().mockResolvedValue(true) as any,
    recordWrite: jest.fn().mockResolvedValue(true) as any,
    now: () => NOW,
    rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) } as any,
    ...over,
  };
}
const call = (deps: MetaToolkitGatewayDeps, toolName: string, args: any) =>
  handleMetaToolkitCall({ authorization: 'Bearer aw_good', toolName, args }, deps);

/** No LinkedIn service function was called (the service module is mocked wholesale above). */
const expectLinkedInNeverCalled = () => {
  for (const fn of Object.values(linkedInAdsService).filter((f) => typeof f === 'function')) expect(fn).not.toHaveBeenCalled();
};

const onboardingDeps = (accounts: any[]) => ({
  getUser: jest.fn().mockResolvedValue({ userId: 'u1', email: 'a@b.co', zomaAdsExperience: 'runs_ads' }),
  listAccounts: jest.fn().mockResolvedValue(accounts),
  findLiveCustomerId: jest.fn(),
  createCustomerForUser: jest.fn(),
  resolvePaymentMethod: jest.fn().mockResolvedValue({ hasPaymentMethod: true }),
  createPaymentMethodSetupSession: jest.fn(),
  buildMetaConnectUrl: jest.fn().mockResolvedValue('https://facebook.example/connect'),
  buildLinkedInAdsConnectUrl: jest.fn().mockResolvedValue('https://www.linkedin.com/oauth/v2/authorization?state=x'),
  pagesUrl: () => 'https://api.agentweb.pro',
  now: () => NOW,
  getUsage: jest.fn(),
}) as any;

const prev = {
  li: process.env.ZOMA_LINKEDIN_ADS_ENABLED, g: process.env.ZOMA_GOOGLE_ENABLED, x: process.env.ZOMA_X_ADS_ENABLED, pay: process.env.ZOMA_REQUIRE_PAYMENT_METHOD,
};
const restore = (key: string, value: string | undefined) => (value === undefined ? delete process.env[key] : (process.env[key] = value));
afterEach(() => {
  restore('ZOMA_LINKEDIN_ADS_ENABLED', prev.li);
  restore('ZOMA_GOOGLE_ENABLED', prev.g);
  restore('ZOMA_X_ADS_ENABLED', prev.x);
  restore('ZOMA_REQUIRE_PAYMENT_METHOD', prev.pay);
  jest.clearAllMocks();
});

describe('the flag is one variable with three strict states', () => {
  it('only "read" and "true" turn anything on; everything else is off', () => {
    for (const off of [undefined, '', 'false', '1', 'TRUE', 'Read', ' read', 'yes', 'on']) {
      const env = off === undefined ? {} : { ZOMA_LINKEDIN_ADS_ENABLED: off };
      expect(linkedInAdsMode(env)).toBe('off');
      expect(linkedInAdsToolkitEnabled(env)).toBe(false);
      expect(linkedInAdsWritesEnabled(env)).toBe(false);
    }
    expect(linkedInAdsMode({ ZOMA_LINKEDIN_ADS_ENABLED: 'read' })).toBe('read');
    expect(linkedInAdsToolkitEnabled({ ZOMA_LINKEDIN_ADS_ENABLED: 'read' })).toBe(true);
    expect(linkedInAdsWritesEnabled({ ZOMA_LINKEDIN_ADS_ENABLED: 'read' })).toBe(false);
    expect(linkedInAdsMode({ ZOMA_LINKEDIN_ADS_ENABLED: 'true' })).toBe('full');
    expect(linkedInAdsToolkitEnabled({ ZOMA_LINKEDIN_ADS_ENABLED: 'true' })).toBe(true);
    expect(linkedInAdsWritesEnabled({ ZOMA_LINKEDIN_ADS_ENABLED: 'true' })).toBe(true);
  });

  it('the Google and X flags stay strict "true" and do not react to "read"', () => {
    expect(require('../mcp/zomaToolDefinitions').googleToolkitEnabled({ ZOMA_GOOGLE_ENABLED: 'read' })).toBe(false);
    expect(require('../mcp/zomaToolDefinitions').xAdsToolkitEnabled({ ZOMA_X_ADS_ENABLED: 'read' })).toBe(false);
  });
});

describe('flag OFF: the product is exactly what Meta, Google and X alone produce', () => {
  beforeEach(() => {
    delete process.env.ZOMA_LINKEDIN_ADS_ENABLED;
    process.env.ZOMA_GOOGLE_ENABLED = 'true';
    process.env.ZOMA_X_ADS_ENABLED = 'true';
    delete process.env.ZOMA_REQUIRE_PAYMENT_METHOD;
  });

  it('the advertised tool list equals the Meta + Google + X list, and names LinkedIn nowhere', () => {
    const advertised = toolkitManifest(false);
    const expected = annotateToolkitTools([...getMetaToolkitManifest(), ...getGoogleToolkitManifest(), ...getXAdsToolkitManifest()]);
    expect(JSON.stringify(advertised)).toBe(JSON.stringify(expected));
    expect(JSON.stringify(advertised)).not.toMatch(LINKEDIN);
    expect(advertised.map((t: any) => t.name)).not.toEqual(expect.arrayContaining(['linkedin_ads_read']));
    expect(JSON.stringify(zomaToolDefinitions())).not.toMatch(LINKEDIN);
  });

  it('zoma_status has no linkedin_ads block and the same fields as before', async () => {
    const r: any = await getZomaReadiness('u1', onboardingDeps([metaAccount()]));
    expect(Object.keys(r).sort()).toEqual(
      ['ads_experience', 'blocker', 'docs_url', 'email', 'google_ads', 'meta', 'next_step', 'payment', 'writes_enabled', 'x_ads'],
    );
    expect(JSON.stringify(r)).not.toMatch(LINKEDIN);
    const none: any = await getZomaReadiness('u1', onboardingDeps([]));
    expect(JSON.stringify(none)).not.toMatch(LINKEDIN);
    expect(formatZomaStatus(none)).not.toMatch(LINKEDIN);
  });

  it('no link is minted for LinkedIn and a LinkedIn connection already stored changes nothing', async () => {
    const deps = onboardingDeps([liAccount()]);
    const r: any = await getZomaReadiness('u1', deps);
    expect(deps.buildLinkedInAdsConnectUrl).not.toHaveBeenCalled();
    expect(r).not.toHaveProperty('linkedin_ads');
    expect(r.meta.ready).toBe(false);
  });

  it('customer-facing text never names LinkedIn: instructions, guide, experience, steps, hints, usage', () => {
    expect(zomaMcpInstructions()).not.toMatch(LINKEDIN);
    expect(zomaSkillDoc(doc)).not.toMatch(LINKEDIN);
    expect(zomaSkillDoc(doc)).not.toContain('zoma-linkedin');
    expect(JSON.stringify(zomaAdsExperienceOptions())).not.toMatch(LINKEDIN);
    expect(adsExperienceQuestionText('zoma_status')).not.toMatch(LINKEDIN);
    expect(zomaNewToAdsSteps().join('\n')).not.toMatch(LINKEDIN);
    expect(zomaErrorNextStep('Multiple Meta ad accounts are connected; pass account_id.')).not.toMatch(LINKEDIN);
    const usage: any = {
      start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z', toolCalls: 1,
      writes: { total: 1, confirmed: 1, mismatch: 0, unconfirmed: 0 },
      recentWrites: [{ ts: '2026-11-02T10:00:00.000Z', platform: 'linkedin_ads', action: 'CREATE', entityType: 'CAMPAIGN', verification: 'CONFIRMED', objectId: '9' }],
    };
    expect(formatZomaUsage(usage)).not.toMatch(LINKEDIN);
  });

  it('a LinkedIn tool call is not routed: it falls to the Meta path, and LinkedIn is never called', async () => {
    const deps = gatewayDeps([metaAccount(), liAccount()], { execute: jest.fn().mockRejectedValue(new MetaToolkitRefusal('not part of the toolkit')) as any });
    for (const tool of ['linkedin_ads_read', 'linkedin_ads_write']) {
      await expect(call(deps, tool, { action: 'LIST_CAMPAIGNS' })).rejects.toBeInstanceOf(MetaToolkitRefusal);
    }
    expect(deps.recordUsage).not.toHaveBeenCalled();
    expectLinkedInNeverCalled();
  });
});

describe('flag "read": reads on, writes not listed, not routable, refused', () => {
  beforeEach(() => { process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'read'; });

  it('lists linkedin_ads_read (read-only) and not linkedin_ads_write; a Databricks view keeps the read tool only', () => {
    const tools: any[] = toolkitManifest(false);
    expect(tools.map((t) => t.name)).toContain('linkedin_ads_read');
    expect(tools.map((t) => t.name)).not.toContain('linkedin_ads_write');
    expect(tools.find((t) => t.name === 'linkedin_ads_read').annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const names = databricksToolView(tools).map((t) => t.name);
    expect(names).toContain('linkedin_ads_read');
    expect(names).not.toContain('linkedin_ads_write');
  });

  it('linkedin_ads_write is refused at call time, before any account lookup, scope check or LinkedIn call', async () => {
    const deps = gatewayDeps([liAccount()]);
    const args = { entity_type: 'CAMPAIGN', action: 'ACTIVATE', campaign_id: '77' };
    await expect(call(deps, 'linkedin_ads_write', args)).rejects.toThrow(LINKEDIN_WRITES_NOT_AVAILABLE);
    await expect(call(deps, 'linkedin_ads_write', { ...args, confirm: true, preview_token: 'v1.9999999999999.x' })).rejects.toThrow(/Standard-tier/);
    expect(deps.listAccounts).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
    expect(deps.recordWrite).not.toHaveBeenCalled();
    expectLinkedInNeverCalled();
  });

  it('a read runs on the caller\'s account with the stored token, metered once as linkedin_ads, and no token is returned', async () => {
    (linkedInAdsService.listCampaigns as jest.Mock).mockResolvedValue({
      success: true, status: 200, data: { elements: [{ id: 11, name: 'C', status: 'ACTIVE', access_token: 'LEAK', refresh_token: 'LEAK2' }] },
    });
    const deps = gatewayDeps([liAccount()]);
    const result: any = await call(deps, 'linkedin_ads_read', { action: 'LIST_CAMPAIGNS' });
    expect(result).toMatchObject({ success: true, account_id: '5001', count: 1 });
    expect(linkedInAdsService.listCampaigns).toHaveBeenCalledWith('LI-ACCESS-SECRET', '5001', {});
    expect(deps.recordUsage).toHaveBeenCalledTimes(1);
    expect(deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'linkedin_ads_read', platform: 'linkedin_ads' }));
    expect(JSON.stringify(result)).not.toMatch(/LEAK|LI-ACCESS-SECRET|LI-REFRESH-SECRET/);
  });

  it('zoma_status: writes are off with the pending reason, the wording is honest, and no token appears', async () => {
    const r: any = await getZomaReadiness('u1', onboardingDeps([liAccount({ scopes: ['r_ads', 'r_ads_reporting'] })]));
    expect(r.linkedin_ads).toMatchObject({
      available: true, ready: true, writes_enabled: false, reason: 'linkedin_standard_tier_pending',
      accounts: [{ account_id: '5001', currency: 'USD' }],
    });
    const text = formatZomaStatus(r);
    expect(text).toContain('[x] LinkedIn Ads account connected (5001, USD)');
    expect(text).toContain('Creating or editing needs LinkedIn Standard-tier approval and only works on accounts LinkedIn has enabled for the app');
    expect(JSON.stringify(r)).not.toMatch(/LI-ACCESS-SECRET|LI-REFRESH-SECRET/);
  });

  it('zoma_status with no LinkedIn connection mints the connect link and offers it', async () => {
    const deps = onboardingDeps([]);
    const r: any = await getZomaReadiness('u1', deps);
    expect(r.linkedin_ads).toMatchObject({ available: true, ready: false, writes_enabled: false, link: expect.stringContaining('linkedin.com') });
    expect(r.next_step).toContain('LinkedIn Ads account');
    expect(deps.buildLinkedInAdsConnectUrl).toHaveBeenCalledTimes(1);
  });

  it('the guide serves the LinkedIn section without the part about changes', () => {
    const served = zomaSkillDoc(doc);
    expect(served).toContain('## LinkedIn Ads (when enabled for the account)');
    expect(served).toContain('linkedin_ads_read');
    expect(served).not.toContain('linkedin_ads_write');
    expect(served).not.toContain('zoma-linkedin');
  });
});

describe('flag "true": both tools', () => {
  beforeEach(() => { process.env.ZOMA_LINKEDIN_ADS_ENABLED = 'true'; });

  it('lists both; the write tool is the destructive default', () => {
    const tools: any[] = toolkitManifest(false);
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['linkedin_ads_read', 'linkedin_ads_write']));
    expect(tools.find((t) => t.name === 'linkedin_ads_write').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(databricksToolView(tools).map((t) => t.name)).not.toContain('linkedin_ads_write');
  });

  it('the write tool is routed to the LinkedIn gateway (its own surface check answers, not the Meta path)', async () => {
    const deps = gatewayDeps([liAccount()]);
    await expect(call(deps, 'linkedin_ads_write', { entity_type: 'CAMPAIGN', action: 'DELETE' }))
      .rejects.toThrow('CAMPAIGN DELETE is not part of the LinkedIn Ads toolkit surface.');
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('zoma_status: writes follow payment and a connected account that has the write consent', async () => {
    const full: any = await getZomaReadiness('u1', onboardingDeps([liAccount()]));
    expect(full.linkedin_ads).toMatchObject({ ready: true, writes_enabled: true });
    expect(full.linkedin_ads).not.toHaveProperty('reason');
    // A connection made in read mode has no rw_ads: it must be reconnected before anything can change.
    const readOnlyConsent: any = await getZomaReadiness('u1', onboardingDeps([liAccount({ scopes: ['r_ads', 'r_ads_reporting'] })]));
    expect(readOnlyConsent.linkedin_ads).toMatchObject({ ready: true, writes_enabled: false, reason: 'linkedin_reconnect_for_changes', link: expect.any(String) });
    expect(formatZomaStatus(readOnlyConsent)).toContain('reconnect LinkedIn Ads');
  });

  it('the guide serves the part about changes too', () => {
    const served = zomaSkillDoc(doc);
    expect(served).toContain('linkedin_ads_write');
    expect(served).not.toContain('zoma-linkedin');
    expect(zomaMcpInstructions()).toContain('Meta (and LinkedIn)');
  });
});
