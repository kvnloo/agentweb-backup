/**
 * ENG-3072 — Zoma first-ad count includes Google Ads campaigns.
 * Acceptance criteria (PM-drafted on the issue):
 *   2. Zoma-created + approved live through Zoma + >= 1 lifetime impression at Google is recorded
 *      as the user's first successful ad (write-once, never inferred, provider check first).
 *   3. Not Zoma-created, no confirmed go-live approval, or zero impressions is not counted.
 *      A Google read error is `provider_error` and nothing is recorded.
 *   4. A user with both a Meta and a Google first ad is counted once.
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUsersByIds: jest.fn() } }));

import {
  buildZomaScoreboard, googleFirstAdDeps, verifyZomaFirstAds,
  type FirstAdDeps, type FirstAdProviderDeps, type ZomaUserRecord, type ZomaWriteEvent,
} from '../services/zomaScoreboard';
import { googleWriteKind, handleGoogleToolkitCall, type GoogleToolkitGatewayDeps } from '../mcp/googleToolkitGateway';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();
const CID = '1234567890';
const CAMPAIGN = `customers/${CID}/campaigns/555`;
const AD_GROUP = `customers/${CID}/adGroups/777`;
const gWrite = (ts: string, extra: Partial<ZomaWriteEvent> = {}): ZomaWriteEvent =>
  ({ userId: 'u1', ts, platform: 'google_ads', entityType: 'CAMPAIGN', action: 'CREATE', verification: 'CONFIRMED', objectId: CAMPAIGN, ...extra });
const created = gWrite(daysAgo(3));
const approved = gWrite(daysAgo(2), { action: 'UPDATE', writeKind: 'approve' });

type Provider = { status?: string; impressions?: number; parent?: string | null; fail?: string };
type MockProvider = { [K in keyof FirstAdProviderDeps]: jest.Mock };
const provider = (p: Provider): MockProvider => ({
  readCampaign: jest.fn(async () => { if (p.fail) throw new Error(p.fail); return p.status === undefined ? null : { accountId: CID, effectiveStatus: p.status }; }),
  campaignOf: jest.fn(async () => (p.parent === undefined ? CAMPAIGN : p.parent)),
  campaignImpressions: jest.fn(async () => p.impressions ?? 0),
});

function firstAdDeps(events: ZomaWriteEvent[], google: Provider | null, meta: Provider = {}) {
  const recorded = new Map<string, any>();
  const users: ZomaUserRecord[] = [{ userId: 'u1', email: 'ann@acme.co' }];
  const googleDeps = google ? provider(google) : undefined;
  const deps: FirstAdDeps & { recorded: Map<string, any>; google?: MockProvider } & MockProvider = {
    recorded,
    listWriteEvents: async (start, end) => events.filter((e) => e.ts >= start && e.ts <= end),
    getUser: async (id) => { const u = users.find((x) => x.userId === id); return u && { ...u, ...(recorded.get(id) ? { zomaFirstAdLive: recorded.get(id) } : {}) }; },
    ...provider(meta),
    ...(googleDeps ? { google: googleDeps } : {}),
    recordFirstAd: jest.fn(async (id, rec) => { if (recorded.has(id)) return false; recorded.set(id, rec); return true; }),
    onFirstAd: jest.fn(async () => undefined),
    now: () => NOW,
  };
  return deps;
}

describe('criterion 2: a Google first ad is recorded', () => {
  it('Zoma-created, approved live through Zoma, 1 lifetime impression → recorded with platform google_ads', async () => {
    const deps = firstAdDeps([created, approved], { status: 'ENABLED', impressions: 1 });
    expect(await verifyZomaFirstAds(deps)).toEqual([expect.objectContaining({ userId: 'u1', outcome: 'verified', campaignId: CAMPAIGN, impressions: 1 })]);
    expect(deps.recorded.get('u1')).toEqual({
      at: new Date(NOW).toISOString(), approvedAt: approved.ts, campaignId: CAMPAIGN, platform: 'google_ads',
      effectiveStatus: 'ENABLED', approvedEntity: { type: 'CAMPAIGN', id: CAMPAIGN },
      activationEvidence: ['approval_read_back_active', 'delivered'],
      impressionsScope: 'lifetime', impressions: 1,
    });
    expect(deps.google!.campaignImpressions).toHaveBeenCalledWith('u1', CID, CAMPAIGN);
    // The Meta reads are never used for a Google campaign.
    expect(deps.readCampaign).not.toHaveBeenCalled();
    expect(deps.onFirstAd).toHaveBeenCalledWith('u1', expect.objectContaining({ platform: 'google_ads' }));
  });

  it('an approval on an ad group counts through its Zoma-created campaign', async () => {
    const deps = firstAdDeps([created, gWrite(daysAgo(2), { action: 'UPDATE', writeKind: 'approve', entityType: 'AD_GROUP', objectId: AD_GROUP })], { status: 'ENABLED', impressions: 4 });
    expect((await verifyZomaFirstAds(deps))[0]).toMatchObject({ outcome: 'verified', campaignId: CAMPAIGN });
    expect(deps.google!.campaignOf).toHaveBeenCalledWith('u1', 'AD_GROUP', AD_GROUP);
    expect(deps.recorded.get('u1').approvedEntity).toEqual({ type: 'AD_GROUP', id: AD_GROUP });
  });

  it('is write-once: a second check does not overwrite the record', async () => {
    const deps = firstAdDeps([created, approved], { status: 'ENABLED', impressions: 1 });
    await verifyZomaFirstAds(deps);
    expect((await verifyZomaFirstAds(deps))[0].outcome).toBe('already_recorded');
    expect(deps.recordFirstAd).toHaveBeenCalledTimes(1);
  });

  it('the scoreboard counts a user whose recorded first ad is on Google', async () => {
    const marker: any = { at: daysAgo(1), campaignId: CAMPAIGN, platform: 'google_ads', impressions: 1 };
    const users: ZomaUserRecord[] = [{ userId: 'u1', email: 'ann@acme.co', zomaFirstAdLive: marker }];
    const sb = await buildZomaScoreboard({ listZomaUsers: async () => users, getUser: async () => users[0], listWriteEvents: async () => [], now: () => NOW });
    expect(sb.rows[0].firstAdLive).toEqual(marker);
  });
});

describe('criterion 3: what is not counted', () => {
  it('a Google campaign not created through Zoma is not counted', async () => {
    const deps = firstAdDeps([approved], { status: 'ENABLED', impressions: 50 });
    expect((await verifyZomaFirstAds(deps))[0].outcome).toBe('not_zoma_created');
    expect(deps.recordFirstAd).not.toHaveBeenCalled();
  });

  it('a Meta create with the same id does not make a Google campaign Zoma-created', async () => {
    const deps = firstAdDeps([{ ...created, platform: 'meta' }, approved], { status: 'ENABLED', impressions: 50 });
    const [result] = await verifyZomaFirstAds(deps);
    expect(result.outcome).toBe('not_zoma_created');
    // The admin result names the campaign that was checked.
    expect(result.campaignId).toBe(CAMPAIGN);
  });

  it('a Google update with no approve writeKind (rename, pause, pre-ENG-3072 enable) is not an approval', async () => {
    for (const extra of [{}, { writeKind: 'edit' }, { writeKind: 'pause' }]) {
      const deps = firstAdDeps([created, gWrite(daysAgo(2), { action: 'UPDATE', ...extra })], { status: 'ENABLED', impressions: 50 });
      expect(await verifyZomaFirstAds(deps, { userId: 'u1' })).toEqual([{ userId: 'u1', outcome: 'no_go_live_approval' }]);
      expect(deps.recordFirstAd).not.toHaveBeenCalled();
    }
  });

  it('an approval whose read-back was not CONFIRMED is not an approval', async () => {
    const deps = firstAdDeps([created, { ...approved, verification: 'MISMATCH' }], { status: 'ENABLED', impressions: 50 });
    expect(await verifyZomaFirstAds(deps, { userId: 'u1' })).toEqual([{ userId: 'u1', outcome: 'no_go_live_approval' }]);
  });

  it('zero impressions is not counted', async () => {
    const deps = firstAdDeps([created, approved], { status: 'ENABLED', impressions: 0 });
    expect((await verifyZomaFirstAds(deps))[0].outcome).toBe('no_impressions');
    expect(deps.recordFirstAd).not.toHaveBeenCalled();
  });

  it('a Google read error is provider_error and nothing is recorded', async () => {
    const deps = firstAdDeps([created, approved], { fail: 'PERMISSION_DENIED' });
    expect((await verifyZomaFirstAds(deps))[0]).toMatchObject({ outcome: 'provider_error', error: 'PERMISSION_DENIED' });
    expect(deps.recordFirstAd).not.toHaveBeenCalled();
  });

  it('an impressions read error is provider_error, not zero impressions', async () => {
    const deps = firstAdDeps([created, approved], { status: 'ENABLED' });
    deps.google!.campaignImpressions.mockRejectedValue(new Error('quota exhausted'));
    expect((await verifyZomaFirstAds(deps))[0]).toMatchObject({ outcome: 'provider_error', error: 'quota exhausted' });
    expect(deps.recordFirstAd).not.toHaveBeenCalled();
  });

  it('a campaign Google no longer returns is provider_error', async () => {
    const deps = firstAdDeps([created, approved], {});
    expect((await verifyZomaFirstAds(deps))[0]).toMatchObject({ outcome: 'provider_error', error: expect.stringContaining('Google Ads') });
  });

  it('without Google reads wired, Google approvals are ignored rather than checked against Meta', async () => {
    const deps = firstAdDeps([created, approved], null, { status: 'ACTIVE', impressions: 9 });
    expect(await verifyZomaFirstAds(deps, { userId: 'u1' })).toEqual([{ userId: 'u1', outcome: 'no_go_live_approval' }]);
    expect(deps.readCampaign).not.toHaveBeenCalled();
  });
});

describe('criterion 4: Meta and Google together count once', () => {
  const metaCreated: ZomaWriteEvent = { userId: 'u1', ts: daysAgo(6), platform: 'meta', entityType: 'CAMPAIGN', action: 'CREATE', verification: 'CONFIRMED', objectId: 'c1' };
  const metaApproved: ZomaWriteEvent = { ...metaCreated, ts: daysAgo(5), action: 'UPDATE', writeKind: 'approve' };

  it('records one first ad (the earliest approval) and never a second', async () => {
    const deps = firstAdDeps([metaCreated, metaApproved, created, approved], { status: 'ENABLED', impressions: 3 }, { status: 'ACTIVE', impressions: 2 });
    const results = await verifyZomaFirstAds(deps);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: 'verified', campaignId: 'c1' });
    expect(deps.recorded.get('u1').platform).toBe('meta');
    expect(deps.recordFirstAd).toHaveBeenCalledTimes(1);
    expect(deps.google!.readCampaign).not.toHaveBeenCalled();
    expect((await verifyZomaFirstAds(deps))[0].outcome).toBe('already_recorded');
    expect(deps.recordFirstAd).toHaveBeenCalledTimes(1);
  });

  it('falls through to Google when the earlier Meta campaign never delivered', async () => {
    const deps = firstAdDeps([metaCreated, metaApproved, created, approved], { status: 'ENABLED', impressions: 3 }, { status: 'ACTIVE', impressions: 0 });
    expect((await verifyZomaFirstAds(deps))[0]).toMatchObject({ outcome: 'verified', campaignId: CAMPAIGN });
    expect(deps.recorded.get('u1').platform).toBe('google_ads');
  });
});

describe('Google reads (googleFirstAdDeps) — stubbed GAQL only', () => {
  it('reads status and all-time impressions from the customer named in the resource', async () => {
    const read = jest.fn(async (_u: string, _c: string, gaql: string) => gaql.includes('metrics.impressions')
      ? [{ metrics: { impressions: '12' } }]
      : [{ campaign: { resourceName: CAMPAIGN, status: 'PAUSED' } }]);
    const g = googleFirstAdDeps(read);
    expect(await g.readCampaign('u1', CAMPAIGN)).toEqual({ accountId: CID, effectiveStatus: 'PAUSED' });
    expect(await g.campaignImpressions('u1', CID, CAMPAIGN)).toBe(12);
    for (const [, customerId, gaql] of read.mock.calls) {
      expect(customerId).toBe(CID);
      expect(gaql).not.toMatch(/segments\.date/);
    }
  });

  it('resolves the campaign of an ad group, ad and asset group; a keyword is not a go-live entity', async () => {
    const read = jest.fn(async () => [{ campaign: { resourceName: CAMPAIGN } }]);
    const g = googleFirstAdDeps(read);
    expect(await g.campaignOf('u1', 'AD_GROUP', AD_GROUP)).toBe(CAMPAIGN);
    expect(await g.campaignOf('u1', 'AD', `customers/${CID}/adGroupAds/777~888`)).toBe(CAMPAIGN);
    expect(await g.campaignOf('u1', 'ASSET_GROUP', `customers/${CID}/assetGroups/999`)).toBe(CAMPAIGN);
    expect(await g.campaignOf('u1', 'KEYWORD', `customers/${CID}/adGroupCriteria/777~1`)).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('never queries with an id that is not an exact resource name', async () => {
    const read = jest.fn(async () => [{ campaign: { resourceName: CAMPAIGN } }]);
    const g = googleFirstAdDeps(read);
    expect(await g.readCampaign('u1', `${CAMPAIGN}' OR campaign.id > '0`)).toBeNull();
    expect(await g.campaignOf('u1', 'AD_GROUP', `${AD_GROUP}' OR '1'='1`)).toBeNull();
    await expect(g.campaignImpressions('u1', '999', CAMPAIGN)).rejects.toThrow(/does not belong/);
    expect(read).not.toHaveBeenCalled();
  });

  it('a Google error propagates instead of reading as zero', async () => {
    const g = googleFirstAdDeps(jest.fn(async () => { throw new Error('UNAUTHENTICATED'); }));
    await expect(g.campaignImpressions('u1', CID, CAMPAIGN)).rejects.toThrow('UNAUTHENTICATED');
    await expect(g.readCampaign('u1', CAMPAIGN)).rejects.toThrow('UNAUTHENTICATED');
  });
});

describe('the Google gateway records the go-live approval', () => {
  it('classifies Google writes', () => {
    expect(googleWriteKind({ entity_type: 'CAMPAIGN', action: 'UPDATE', status: 'ENABLED' })).toBe('approve');
    expect(googleWriteKind({ entity_type: 'AD_GROUP', action: 'UPDATE', status: 'ENABLED' })).toBe('approve');
    expect(googleWriteKind({ entity_type: 'KEYWORD', action: 'UPDATE', status: 'ENABLED' })).toBe('edit');
    expect(googleWriteKind({ entity_type: 'CAMPAIGN', action: 'UPDATE', status: 'PAUSED' })).toBe('pause');
    expect(googleWriteKind({ entity_type: 'CAMPAIGN', action: 'UPDATE', name: 'x' })).toBe('edit');
    expect(googleWriteKind({ entity_type: 'CAMPAIGN', action: 'CREATE', status: 'PAUSED' })).toBe('create');
    // Meta's word for live is not Google's.
    expect(googleWriteKind({ entity_type: 'CAMPAIGN', action: 'UPDATE', status: 'ACTIVE' })).toBe('edit');
  });

  it('a confirmed UPDATE status=ENABLED is metered with writeKind approve', async () => {
    const recordWrite = jest.fn(async () => true);
    const deps: GoogleToolkitGatewayDeps = {
      listAccounts: async () => [{ platform: 'google_ads', status: 'active', config: { customer_id: CID, currency: 'USD', refresh_token: 'fixture' } } as any],
      now: () => NOW,
      meter: async () => undefined,
      recordWrite: recordWrite as any,
      executeWrite: async () => ({ success: true, verification: 'CONFIRMED', id: CAMPAIGN, status: 'ENABLED' }),
      accessError: (m) => new Error(m),
    };
    await handleGoogleToolkitCall(
      { userId: 'u1', authMethod: 'oauth' as any },
      { toolName: 'call_google_ads_api', args: { customer_id: CID, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, status: 'ENABLED', confirm: true, preview_token: 't' } },
      deps,
    );
    expect(recordWrite).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'google_ads', entityType: 'CAMPAIGN', action: 'UPDATE', objectId: CAMPAIGN, verification: 'CONFIRMED', writeKind: 'approve',
    }));
  });
});
