/**
 * Zoma LinkedIn Ads manifest and reads. Invariants only:
 *  - both tools fit the plan-route limits (name 53 chars, schema 32 KiB, description 48 KiB) and the
 *    surface is enforced twice: in the advertised schema and again at call time
 *  - the read tool has no pre-check and no assumption about unlisted ad accounts: LinkedIn's 403
 *    "not configured to access the related advertiser account(s)" becomes a per-endpoint customer
 *    message, a 429 a structured rate_limited result (never a loop), a 401 on a freshly minted token
 *    is retried exactly once
 *  - nothing in a result or an error carries a credential
 * Mock-only: there is no LinkedIn test ad account.
 */
jest.mock('../services/linkedInAdsService', () => ({}));

import {
  assertLinkedInAdsToolkitCall, executeLinkedInAdsRead, getLinkedInAdsToolkitManifest, LINKEDIN_ADS_READ_ACTIONS, LINKEDIN_ADS_WRITES,
  linkedInId, validateTargetingClauses,
} from '../mcp/linkedInAdsToolkitManifest';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { annotateToolkitTools } from '../mcp/toolkitToolAnnotations';
import { LINKEDIN_WRITE_NOT_ENABLED, LINKEDIN_WRITES_NOT_AVAILABLE, linkedInNotEnabledReadResult, linkedInRateLimitedResult, linkedInThrottledResult, type LinkedInAdsSession } from '../mcp/linkedInAdsCall';
import { zomaErrorNextStep, zomaNextStep } from '../mcp/zomaNextStep';

const TOKEN = 'AQV-live-access-token-0123456789';
const sleep = jest.fn().mockResolvedValue(undefined);
const session = (over: Partial<LinkedInAdsSession> = {}): LinkedInAdsSession => ({ accountId: '5001', accessToken: TOKEN, currency: 'USD', freshToken: false, sleep, ...over });
const ok = (elements: any[] = []) => ({ success: true, status: 200, data: { elements } });
const fail = (status: number | undefined, error: string) => ({ success: false, status, error });

/** The raw message the shared service produces for the Development-tier 403 (it rewrites it for AgentWeb staff). */
const ALLOWLIST_403 = fail(
  403,
  'Not enough permissions: not configured to access the related advertiser account(s)\n\nThis is an AgentWeb platform configuration gap, not something the customer can fix. '
    + 'Instead, tell them this ad account (5001) needs to be allowlisted by AgentWeb staff and to contact AgentWeb support',
);

function fakeApi(over: Record<string, jest.Mock> = {}) {
  return {
    listAdAccounts: jest.fn().mockResolvedValue(ok([{ id: 5001, name: 'Acme' }])),
    listCampaignGroups: jest.fn().mockResolvedValue(ok([{ id: 1 }])),
    listCampaigns: jest.fn().mockResolvedValue(ok([{ id: 11 }, { id: 12 }])),
    listCreatives: jest.fn().mockResolvedValue(ok([{ id: 'urn:li:sponsoredCreative:21' }])),
    listTargetingFacets: jest.fn().mockResolvedValue(ok([{ facetName: 'locations' }])),
    searchTargetingEntities: jest.fn().mockResolvedValue(ok([{ urn: 'urn:li:geo:1' }])),
    getAudienceCount: jest.fn().mockResolvedValue({ success: true, status: 200, data: { elements: [{ total: 1000 }] } }),
    getAdAnalytics: jest.fn().mockResolvedValue(ok([{ impressions: 5, clicks: 1, costInLocalCurrency: '2.50' }])),
    resolveTargetingCriteria: jest.fn((p: any) => ({ include: { and: p.targeting_include.map((c: any) => ({ or: { [c.facet_urn]: c.values } })) } })),
    ...over,
  };
}
const read = (args: any, api = fakeApi(), s = session()) => executeLinkedInAdsRead(args, s, api as any);

describe('manifest: limits, annotations, surface', () => {
  const tools = getLinkedInAdsToolkitManifest(true);

  it('lists only the read tool unless writes are on', () => {
    expect(getLinkedInAdsToolkitManifest(false).map((t) => t.name)).toEqual(['linkedin_ads_read']);
    expect(tools.map((t) => t.name)).toEqual(['linkedin_ads_read', 'linkedin_ads_write']);
  });

  it('fits the Claude plan route: name <= 53 characters, schema <= 32 KiB, description <= 48 KiB, object schema', () => {
    const seen = new Set<string>();
    for (const t of tools) {
      expect(t.name.length).toBeLessThanOrEqual(53);
      expect(t.name).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/);
      expect(seen.has(t.name.toLowerCase())).toBe(false);
      seen.add(t.name.toLowerCase());
      expect(Buffer.byteLength(JSON.stringify(t.inputSchema), 'utf8')).toBeLessThanOrEqual(32 * 1024);
      expect(Buffer.byteLength(t.description, 'utf8')).toBeLessThanOrEqual(48 * 1024);
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('annotations are deny-by-default: the read tool is read-only, the write tool is the destructive default', () => {
    const [read, write] = annotateToolkitTools(tools) as any[];
    expect(read.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(write.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });

  it('the advertised write schema has no status argument and the advertised actions match the call-time table', () => {
    const write: any = tools[1];
    expect(Object.keys(write.inputSchema.properties).filter((k) => /status/i.test(k))).toEqual([]);
    expect(write.inputSchema.properties.entity_type.enum).toEqual(Object.keys(LINKEDIN_ADS_WRITES));
    expect((tools[0] as any).inputSchema.properties.action.enum).toEqual([...LINKEDIN_ADS_READ_ACTIONS]);
  });

  it('call time enforces it again: unknown arguments, unknown actions, prototype keys and a status are refused', () => {
    expect(() => assertLinkedInAdsToolkitCall('linkedin_ads_read', { action: 'LIST_CAMPAIGNS', surprise: 1 })).toThrow(/does not accept: surprise/);
    expect(() => assertLinkedInAdsToolkitCall('linkedin_ads_read', { action: 'DELETE_EVERYTHING' })).toThrow(/action must be one of/);
    expect(() => assertLinkedInAdsToolkitCall('linkedin_ads_write', { entity_type: 'CREATIVE', action: 'UPDATE' })).toThrow(/not part of the LinkedIn Ads toolkit surface/);
    expect(() => assertLinkedInAdsToolkitCall('linkedin_ads_write', { entity_type: 'toString', action: 'CREATE' })).toThrow(MetaToolkitRefusal);
    expect(() => assertLinkedInAdsToolkitCall('linkedin_ads_write', { entity_type: 'CAMPAIGN', action: 'CREATE', status: 'ACTIVE' })).toThrow(/always created as DRAFT/);
    expect(() => assertLinkedInAdsToolkitCall('linkedin_ads_write', { entity_type: 'CAMPAIGN', action: 'CREATE', intended_status: 'ACTIVE' })).toThrow(/always created as DRAFT/);
    expect(() => assertLinkedInAdsToolkitCall('other_tool', {})).toThrow(/not part of the LinkedIn Ads toolkit/);
    expect(() => assertLinkedInAdsToolkitCall('linkedin_ads_read', [])).toThrow(/must be an object/);
    for (const action of [['LIST_CAMPAIGNS'], { toString: () => 'LIST_CAMPAIGNS' }, 7, null, undefined]) {
      expect(() => assertLinkedInAdsToolkitCall('linkedin_ads_read', { action })).toThrow(/action must be a string/);
    }
    for (const action of [['ACTIVATE'], { toString: () => 'ACTIVATE' }, 7, null]) {
      expect(() => assertLinkedInAdsToolkitCall('linkedin_ads_write', { entity_type: 'CAMPAIGN', action })).toThrow(/action must be a string/);
    }
    expect(() => assertLinkedInAdsToolkitCall('linkedin_ads_write', { entity_type: ['CAMPAIGN'], action: 'PAUSE' })).toThrow(/entity_type must be a string/);
  });

  it('ids and targeting are validated before they can reach a URL', () => {
    expect(linkedInId('urn:li:sponsoredCampaign:123', 'campaign', 'campaign_id')).toBe('123');
    expect(linkedInId(456, 'group', 'campaign_group_id')).toBe('456');
    for (const bad of ['12 OR 1=1', '../x', '123)),status:(values:List(ACTIVE', 'urn:li:sponsoredCampaign:abc', '', {}]) {
      expect(() => linkedInId(bad, 'campaign', 'campaign_id')).toThrow(MetaToolkitRefusal);
    }
    expect(() => validateTargetingClauses([{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:1'] }], 't', { required: true })).not.toThrow();
    expect(() => validateTargetingClauses([{ facet_urn: 'nope', values: ['urn:li:geo:1'] }], 't', { required: true })).toThrow(MetaToolkitRefusal);
    expect(() => validateTargetingClauses([{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['x),(evil'] }], 't', { required: true })).toThrow(MetaToolkitRefusal);
    expect(() => validateTargetingClauses(undefined, 't', { required: true })).toThrow(/required/);
  });
});

describe('reads', () => {
  it('each action calls its LinkedIn read with the resolved account and the validated filters', async () => {
    const api = fakeApi();
    expect(await read({ action: 'LIST_CAMPAIGNS', campaign_group_id: 'urn:li:sponsoredCampaignGroup:9', status: ['ACTIVE', 'DRAFT'] }, api))
      .toMatchObject({ success: true, account_id: '5001', count: 2 });
    expect(api.listCampaigns).toHaveBeenCalledWith(TOKEN, '5001', { campaign_group_id: '9', status: 'ACTIVE,DRAFT' });
    await read({ action: 'LIST_CREATIVES', campaign_id: '11' }, api);
    expect(api.listCreatives).toHaveBeenCalledWith(TOKEN, '5001', '11');
    await read({
      action: 'GET_ANALYTICS', pivot: 'CAMPAIGN', start_date: '2026-11-01', end_date: '2026-11-07', campaign_ids: ['11'],
    }, api);
    expect(api.getAdAnalytics).toHaveBeenCalledWith(
      TOKEN, '5001', 'CAMPAIGN', 'ALL',
      { start: { year: 2026, month: 11, day: 1 }, end: { year: 2026, month: 11, day: 7 } },
      ['impressions', 'clicks', 'costInLocalCurrency', 'dateRange', 'pivotValues'],
      { campaign_group_ids: undefined, campaign_ids: ['11'], creative_ids: undefined },
    );
    expect(await read({ action: 'ESTIMATE_AUDIENCE', targeting_include: [{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:1'] }] }, api))
      .toMatchObject({ success: true, audience: { elements: [{ total: 1000 }] } });
  });

  it('LIST_ACCOUNTS shows only the ad accounts the caller connected, not the rest of the token owner\'s accounts', async () => {
    const api = fakeApi({ listAdAccounts: jest.fn().mockResolvedValue(ok([{ id: 5001, name: 'Mine' }, { id: 6002, name: 'Teammate other' }, { id: 'urn:li:sponsoredAccount:7003' }])) });
    const result: any = await read({ action: 'LIST_ACCOUNTS' }, api, session({ connectedAccountIds: ['5001', '7003'] }));
    expect(result.data.map((a: any) => a.name ?? a.id)).toEqual(['Mine', 'urn:li:sponsoredAccount:7003']);
    expect((await read({ action: 'LIST_ACCOUNTS' }, api) as any).data).toEqual([{ id: 5001, name: 'Mine' }]);
  });

  it('invalid input is refused before any LinkedIn call', async () => {
    const api = fakeApi();
    for (const args of [
      { action: 'LIST_CAMPAIGNS', campaign_group_id: '1 OR 1=1' },
      { action: 'LIST_CAMPAIGNS', status: ['ACTIVE)),x:(y'] },
      { action: 'LIST_CREATIVES' },
      { action: 'GET_ANALYTICS', pivot: 'CAMPAIGN', start_date: '2026-13-01', end_date: '2026-11-07' },
      { action: 'GET_ANALYTICS', pivot: 'CAMPAIGN', start_date: '2026-11-07', end_date: '2026-11-01' },
      { action: 'GET_ANALYTICS', pivot: 'NOT_A_PIVOT', start_date: '2026-11-01', end_date: '2026-11-07' },
      { action: 'GET_ANALYTICS', pivot: 'CAMPAIGN', start_date: '2026-11-01', end_date: '2026-11-07', fields: ['impressions,evil'] },
      { action: 'SEARCH_TARGETING_ENTITIES', facet_urn: 'urn:li:adTargetingFacet:locations', locale_country: 'usa' },
    ]) {
      await expect(read(args, api)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    }
    for (const fn of Object.values(api).filter((f) => typeof f === 'function')) expect((fn as jest.Mock).mock.calls).toEqual([]);
  });

  it('no pre-check: a read is always attempted, and LinkedIn\'s allowlist 403 becomes a per-endpoint customer message', async () => {
    const api = fakeApi({
      listCampaigns: jest.fn().mockResolvedValue(ALLOWLIST_403),
      listCreatives: jest.fn().mockResolvedValue(ALLOWLIST_403),
      getAudienceCount: jest.fn().mockResolvedValue(ALLOWLIST_403),
    });
    const campaigns: any = await read({ action: 'LIST_CAMPAIGNS' }, api);
    expect(api.listCampaigns).toHaveBeenCalledTimes(1);
    expect(campaigns).toMatchObject({ success: false, error_type: 'ad_account_not_enabled', endpoint: 'campaigns', reporting_available: true });
    expect(campaigns.message).toBe('LinkedIn has not enabled the Zoma app for this ad account yet, so its campaigns cannot be read here. Reporting (GET_ANALYTICS) still works.');
    expect(await read({ action: 'LIST_CREATIVES', campaign_id: '11' }, api)).toMatchObject({ endpoint: 'creatives' });
    expect(await read({ action: 'ESTIMATE_AUDIENCE', targeting_include: [{ facet_urn: 'urn:li:adTargetingFacet:locations', values: ['urn:li:geo:1'] }] }, api))
      .toMatchObject({ endpoint: 'audience count' });
    // What LinkedIn confirmed for such an account (adAnalytics) is returned, not blocked.
    expect(await read({ action: 'GET_ANALYTICS', pivot: 'ACCOUNT', start_date: '2026-11-01', end_date: '2026-11-07' }, api)).toMatchObject({ success: true });
    // Staff-facing text from the shared service never reaches the customer.
    expect(JSON.stringify(campaigns)).not.toMatch(/allowlist|AgentWeb staff|AgentWeb support|platform configuration gap/i);
  });

  it('a 429 is a structured rate_limited result with a retry time; it is never retried or looped', async () => {
    const api = fakeApi({ listCampaigns: jest.fn().mockResolvedValue(fail(429, 'Too Many Requests')) });
    const result: any = await read({ action: 'LIST_CAMPAIGNS' }, api);
    expect(result).toMatchObject({ success: false, error_type: 'rate_limited', retry_after_seconds: 60 });
    expect(result.message).toMatch(/Do not retry in a loop/);
    expect(api.listCampaigns).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a 401 on a freshly minted token is retried exactly once after a short delay', async () => {
    sleep.mockClear();
    const api = fakeApi({ listCampaigns: jest.fn().mockResolvedValueOnce(fail(401, 'revoked')).mockResolvedValueOnce(ok([{ id: 11 }])) });
    expect(await read({ action: 'LIST_CAMPAIGNS' }, api, session({ freshToken: true }))).toMatchObject({ success: true, count: 1 });
    expect(api.listCampaigns).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(0);
    expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(10_000);
  });

  it('a 401 that survives the single retry, or a 401 on an older token, is a reconnect message and nothing more', async () => {
    sleep.mockClear();
    const still = fakeApi({ listCampaigns: jest.fn().mockResolvedValue(fail(401, 'revoked')) });
    await expect(read({ action: 'LIST_CAMPAIGNS' }, still, session({ freshToken: true }))).rejects.toThrow(/needs to be reconnected/);
    expect(still.listCampaigns).toHaveBeenCalledTimes(2);
    const old = fakeApi({ listCampaigns: jest.fn().mockResolvedValue(fail(401, 'revoked')) });
    await expect(read({ action: 'LIST_CAMPAIGNS' }, old, session({ freshToken: false }))).rejects.toThrow(/needs to be reconnected/);
    expect(old.listCampaigns).toHaveBeenCalledTimes(1);
  });

  it('other failures are refusals that say why, with anything shaped like a credential scrubbed', async () => {
    const api = fakeApi({
      listCampaigns: jest.fn().mockResolvedValue(fail(500, `upstream said Bearer ${TOKEN} and https://x/?access_token=${TOKEN}&a=1 {"refresh_token":"RT-SECRET"}`)),
    });
    const error: any = await read({ action: 'LIST_CAMPAIGNS' }, api).catch((e) => e);
    expect(error).toBeInstanceOf(MetaToolkitRefusal);
    expect(error.message).toContain('LinkedIn could not list campaigns');
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('RT-SECRET');
  });

  it('a successful result never carries the access token', async () => {
    const result = await read({ action: 'LIST_CAMPAIGN_GROUPS' }, fakeApi());
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('what the agent is told next', () => {
  it('each LinkedIn failure names its own next step, never the generic setup call', () => {
    const generic = zomaErrorNextStep('some unrelated failure');
    for (const message of [
      linkedInRateLimitedResult('the campaigns read', false).message,
      linkedInThrottledResult(12).message,
      linkedInNotEnabledReadResult('campaigns').message,
      LINKEDIN_WRITE_NOT_ENABLED,
      LINKEDIN_WRITES_NOT_AVAILABLE,
      'LinkedIn rejected the saved connection for this ad account (it was revoked or has expired), so the LinkedIn Ads account needs to be reconnected.',
    ]) {
      expect(zomaErrorNextStep(message)).not.toBe(generic);
    }
    expect(zomaNextStep('linkedin_ads_read', {}, linkedInRateLimitedResult('x', false))).toMatch(/Do not retry in a loop/);
    expect(zomaNextStep('linkedin_ads_read', {}, linkedInNotEnabledReadResult('campaigns'))).toMatch(/offer reporting/);
    expect(zomaErrorNextStep('Multiple LinkedIn Ads accounts are connected; pass account_id.')).toBe('Ask the user which LinkedIn ad account to use, then retry with account_id set to it.');
  });
});
