/**
 * ENG-2902 Zoma launch scoreboard — behavioral contract (Harsha):
 *   active = non-team/test account with >= 1 successful Zoma write (create/edit/pause/approve)
 *            in the rolling 7 days;
 *   first successful ad = first Zoma-created campaign approved for go-live through Zoma, provider
 *            read-back ACTIVE AND >= 1 impression;
 *   team/test accounts excluded from every count.
 */
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUsersByIds: jest.fn() } }));

import {
  buildZomaScoreboard, classifyZomaWrite, verifyZomaFirstAds, zomaWriteKindFor,
  type FirstAdDeps, type ScoreboardDeps, type ZomaUserRecord, type ZomaWriteEvent,
} from '../services/zomaScoreboard';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();
const user = (userId: string, email: string, extra: Partial<ZomaUserRecord> = {}): ZomaUserRecord => ({ userId, email, ...extra });
const write = (userId: string, ts: string, extra: Partial<ZomaWriteEvent> = {}): ZomaWriteEvent =>
  ({ userId, ts, platform: 'meta', entityType: 'CAMPAIGN', action: 'CREATE', verification: 'CONFIRMED', objectId: 'c1', ...extra });

function scoreboardDeps(users: ZomaUserRecord[], events: ZomaWriteEvent[], extraUsers: ZomaUserRecord[] = []): ScoreboardDeps {
  const all = [...users, ...extraUsers];
  return {
    listZomaUsers: async () => users,
    getUser: async (id) => all.find((u) => u.userId === id),
    listWriteEvents: async (start, end) => events.filter((e) => e.ts >= start && e.ts <= end),
    now: () => NOW,
  };
}

describe('active (rolling 7d)', () => {
  it('a customer with one confirmed Zoma write in the last 7 days is active', async () => {
    const sb = await buildZomaScoreboard(scoreboardDeps([user('u1', 'ann@acme.co')], [write('u1', daysAgo(6))]));
    expect(sb.rows[0]).toMatchObject({ userId: 'u1', active7d: true, writes7d: expect.objectContaining({ create: 1, total: 1 }) });
    expect(sb.summary).toEqual({ zomaUsers: 1, activeUsers7d: 1, firstAdUsers: 0, excludedAccounts: 0 });
  });

  it('signup, reads, unconfirmed/mismatched writes and writes older than 7 days never make a user active', async () => {
    const sb = await buildZomaScoreboard(scoreboardDeps(
      [user('u1', 'ann@acme.co', { zomaStage: 'first_read' })],
      [write('u1', daysAgo(8)), write('u1', daysAgo(1), { verification: 'MISMATCH' }), write('u1', daysAgo(1), { verification: 'UNCONFIRMED' })],
    ));
    expect(sb.rows[0]).toMatchObject({ active7d: false, writes7d: expect.objectContaining({ total: 0 }) });
    expect(sb.summary.activeUsers7d).toBe(0);
  });

  it('counts create, edit, pause and approve separately; legacy events fall back on the action', async () => {
    const sb = await buildZomaScoreboard(scoreboardDeps([user('u1', 'ann@acme.co')], [
      write('u1', daysAgo(1)),
      write('u1', daysAgo(1), { action: 'UPDATE', writeKind: 'edit' }),
      write('u1', daysAgo(1), { action: 'UPDATE', writeKind: 'pause' }),
      write('u1', daysAgo(1), { action: 'UPDATE', writeKind: 'approve' }),
      write('u1', daysAgo(1), { action: 'UPDATE' }), // pre-ENG-2902 row: no writeKind
      write('u1', daysAgo(1), { entityType: 'AD_CREATIVE', action: 'UPLOAD_IMAGE' }),
    ]));
    expect(sb.rows[0].writes7d).toEqual({ create: 2, edit: 2, pause: 1, approve: 1, total: 6 });
    expect(sb.rows[0].goLiveApprovalsAwaitingProof).toBe(1);
  });

  it('team and test accounts are listed, flagged and excluded from every count', async () => {
    const sb = await buildZomaScoreboard(scoreboardDeps(
      [user('t1', 'harsha@agentweb.pro'), user('t2', 'qa-user@acme.co'), user('t3', 'boss@acme.co', { isAdmin: true }), user('c1', 'ann@acme.co')],
      [write('t1', daysAgo(1)), write('t2', daysAgo(1)), write('t3', daysAgo(1)), write('c1', daysAgo(1))],
    ));
    expect(sb.rows.find((r) => r.userId === 't1')).toMatchObject({ excluded: 'internal', active7d: false });
    expect(sb.rows.find((r) => r.userId === 't2')).toMatchObject({ excluded: 'test', active7d: false });
    expect(sb.rows.find((r) => r.userId === 't3')).toMatchObject({ excluded: 'internal' });
    expect(sb.summary).toEqual({ zomaUsers: 1, activeUsers7d: 1, firstAdUsers: 0, excludedAccounts: 3 });
    expect(sb.rows[0].userId).toBe('c1'); // counted customers first
  });

  it('a user who wrote through Zoma before attribution existed still appears', async () => {
    const sb = await buildZomaScoreboard(scoreboardDeps([], [write('old', daysAgo(2))], [user('old', 'early@acme.co')]));
    expect(sb.rows.map((r) => r.userId)).toEqual(['old']);
    expect(sb.summary.activeUsers7d).toBe(1);
  });

  it('first ad comes only from the recorded provider-verified marker', async () => {
    const marker = { at: daysAgo(1), approvedAt: daysAgo(2), campaignId: 'c1', platform: 'meta' as const, effectiveStatus: 'ACTIVE' as const, impressions: 12 };
    const sb = await buildZomaScoreboard(scoreboardDeps([user('u1', 'ann@acme.co', { zomaFirstAdLive: marker }), user('u2', 'bo@acme.co')], []));
    expect(sb.summary.firstAdUsers).toBe(1);
    expect(sb.rows.find((r) => r.userId === 'u1')?.firstAdLive).toEqual(marker);
  });
});

describe('first successful ad (provider-verified)', () => {
  function firstAdDeps(events: ZomaWriteEvent[], provider: { status?: string; impressions?: number; parent?: string | null } = {}, users: ZomaUserRecord[] = [user('u1', 'ann@acme.co')]) {
    const recorded = new Map<string, any>();
    const deps: FirstAdDeps & { recorded: Map<string, any> } = {
      recorded,
      listWriteEvents: async (start, end) => events.filter((e) => e.ts >= start && e.ts <= end),
      getUser: async (id) => { const u = users.find((x) => x.userId === id); return u && { ...u, ...(recorded.get(id) ? { zomaFirstAdLive: recorded.get(id) } : {}) }; },
      readCampaign: jest.fn(async () => (provider.status === undefined ? null : { accountId: '111', effectiveStatus: provider.status })),
      campaignOf: jest.fn(async () => (provider.parent === undefined ? 'c1' : provider.parent)),
      campaignImpressions: jest.fn(async () => provider.impressions ?? 0),
      recordFirstAd: jest.fn(async (id, rec) => { if (recorded.has(id)) return false; recorded.set(id, rec); return true; }),
      onFirstAd: jest.fn(async () => undefined),
      now: () => NOW,
    };
    return deps;
  }
  const created = write('u1', daysAgo(3), { objectId: 'c1' });
  const approved = write('u1', daysAgo(2), { action: 'UPDATE', writeKind: 'approve', objectId: 'c1' });

  it('records the first ad when a Zoma-created campaign approved through Zoma reads back ACTIVE with >= 1 impression', async () => {
    const deps = firstAdDeps([created, approved], { status: 'ACTIVE', impressions: 1 });
    expect(await verifyZomaFirstAds(deps)).toEqual([expect.objectContaining({ userId: 'u1', outcome: 'verified', campaignId: 'c1', impressions: 1 })]);
    expect(deps.recorded.get('u1')).toEqual({ at: new Date(NOW).toISOString(), approvedAt: approved.ts, campaignId: 'c1', platform: 'meta', effectiveStatus: 'ACTIVE', impressions: 1 });
    expect(deps.onFirstAd).toHaveBeenCalledTimes(1);
  });

  it('ACTIVE with zero impressions is not a first ad', async () => {
    const deps = firstAdDeps([created, approved], { status: 'ACTIVE', impressions: 0 });
    expect((await verifyZomaFirstAds(deps))[0].outcome).toBe('no_impressions');
    expect(deps.recordFirstAd).not.toHaveBeenCalled();
  });

  it('an approved campaign the provider reports as not ACTIVE (paused, in review, rejected) is not a first ad', async () => {
    for (const status of ['PAUSED', 'PENDING_REVIEW', 'DISAPPROVED']) {
      const deps = firstAdDeps([created, approved], { status, impressions: 50 });
      expect((await verifyZomaFirstAds(deps))[0]).toMatchObject({ outcome: 'not_active', effectiveStatus: status });
      expect(deps.recordFirstAd).not.toHaveBeenCalled();
    }
  });

  it('a campaign not created through Zoma never counts, even when live with impressions', async () => {
    const deps = firstAdDeps([approved], { status: 'ACTIVE', impressions: 99 });
    expect((await verifyZomaFirstAds(deps))[0].outcome).toBe('not_zoma_created');
    expect(deps.readCampaign).not.toHaveBeenCalled();
  });

  it('a live Zoma-created campaign without a Zoma go-live approval is not checked or counted', async () => {
    const deps = firstAdDeps([created], { status: 'ACTIVE', impressions: 99 });
    expect(await verifyZomaFirstAds(deps)).toEqual([]);
    expect(await verifyZomaFirstAds(deps, { userId: 'u1' })).toEqual([{ userId: 'u1', outcome: 'no_go_live_approval' }]);
    expect(deps.recordFirstAd).not.toHaveBeenCalled();
  });

  it('an ad-set / ad approval resolves to its campaign through the provider', async () => {
    const adApproval = write('u1', daysAgo(2), { entityType: 'AD', action: 'UPDATE', writeKind: 'approve', objectId: 'ad9' });
    const deps = firstAdDeps([created, adApproval], { status: 'ACTIVE', impressions: 3, parent: 'c1' });
    expect((await verifyZomaFirstAds(deps))[0]).toMatchObject({ outcome: 'verified', campaignId: 'c1' });
    expect(deps.campaignOf).toHaveBeenCalledWith('u1', 'AD', 'ad9');
  });

  it('is write-once: a second verification does not overwrite or re-emit', async () => {
    const deps = firstAdDeps([created, approved], { status: 'ACTIVE', impressions: 5 });
    await verifyZomaFirstAds(deps);
    expect((await verifyZomaFirstAds(deps))[0].outcome).toBe('already_recorded');
    expect(deps.recordFirstAd).toHaveBeenCalledTimes(1);
    expect(deps.onFirstAd).toHaveBeenCalledTimes(1);
  });

  it('a provider failure is reported, not thrown, and records nothing', async () => {
    const deps = firstAdDeps([created, approved], { status: 'ACTIVE' });
    (deps.campaignImpressions as jest.Mock).mockRejectedValue(new Error('rate limited'));
    expect((await verifyZomaFirstAds(deps))[0]).toMatchObject({ outcome: 'provider_error', error: 'rate limited' });
    expect(deps.recordFirstAd).not.toHaveBeenCalled();
  });

  it('recorded users do not use a check slot; users beyond the cap are deferred, not dropped', async () => {
    const users = ['u1', 'u2', 'u3'].map((id) => user(id, `${id}@acme.co`));
    const events = users.flatMap(({ userId }) => [write(userId, daysAgo(3)), write(userId, daysAgo(2), { action: 'UPDATE', writeKind: 'approve' })]);
    const deps = firstAdDeps(events, { status: 'ACTIVE', impressions: 0 }, users);
    deps.recorded.set('u1', { campaignId: 'c1' });
    const out = await verifyZomaFirstAds(deps, { maxUsers: 1 });
    expect(out.map((r) => [r.userId, r.outcome])).toEqual([['u1', 'already_recorded'], ['u2', 'no_impressions'], ['u3', 'deferred']]);
  });

  it('a failed parent lookup is a provider error, not "not created through Zoma"', async () => {
    const adApproval = write('u1', daysAgo(2), { entityType: 'AD', action: 'UPDATE', writeKind: 'approve', objectId: 'ad9' });
    const deps = firstAdDeps([created, adApproval], { status: 'ACTIVE', impressions: 3 });
    (deps.campaignOf as jest.Mock).mockRejectedValue(new Error('meta 500'));
    expect((await verifyZomaFirstAds(deps))[0]).toMatchObject({ outcome: 'provider_error', error: 'meta 500' });
  });

  it('stops before the next provider call once the time budget is spent', async () => {
    let t = NOW;
    const second = write('u1', daysAgo(1), { action: 'UPDATE', writeKind: 'approve', objectId: 'c1' });
    const deps = firstAdDeps([created, approved, second], { status: 'PAUSED' });
    deps.now = () => t;
    (deps.readCampaign as jest.Mock).mockImplementation(async () => { t += 50_000; return { accountId: '111', effectiveStatus: 'PAUSED' }; });
    expect((await verifyZomaFirstAds(deps))[0].outcome).toBe('deferred');
    expect(deps.readCampaign).toHaveBeenCalledTimes(1);
  });

  it('a failing ad_live emit does not fail the check once the marker is written', async () => {
    const deps = firstAdDeps([created, approved], { status: 'ACTIVE', impressions: 2 });
    (deps.onFirstAd as jest.Mock).mockRejectedValue(new Error('posthog down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await verifyZomaFirstAds(deps))[0].outcome).toBe('verified');
    expect(deps.recorded.get('u1')).toEqual(expect.objectContaining({ campaignId: 'c1' }));
    warn.mockRestore();
  });

  it('unconfirmed approvals and Google writes are ignored', async () => {
    const deps = firstAdDeps([
      created,
      write('u1', daysAgo(2), { action: 'UPDATE', writeKind: 'approve', verification: 'UNCONFIRMED' }),
      write('u1', daysAgo(2), { action: 'UPDATE', writeKind: 'approve', platform: 'google_ads' }),
    ], { status: 'ACTIVE', impressions: 5 });
    expect(await verifyZomaFirstAds(deps)).toEqual([]);
  });
});

describe('write kind classification', () => {
  it('status ACTIVE is the go-live approval and PAUSED is a pause', () => {
    expect(zomaWriteKindFor('UPDATE', { status: 'ACTIVE' })).toBe('approve');
    expect(zomaWriteKindFor('UPDATE', { status: 'PAUSED' })).toBe('pause');
    expect(zomaWriteKindFor('UPDATE', { daily_budget: 500 })).toBe('edit');
    expect(zomaWriteKindFor('CREATE', { status: 'ACTIVE' })).toBe('create');
    expect(zomaWriteKindFor('ARCHIVE', {})).toBe('edit');
    expect(classifyZomaWrite({ action: 'UPDATE', writeKind: 'nonsense' })).toBe('edit');
  });

  it('the Meta toolkit gateway records writeKind=approve on a confirmed status→ACTIVE write', async () => {
    const recordWrite = jest.fn().mockResolvedValue(true);
    const deps: MetaToolkitGatewayDeps = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1' }),
      validateOAuthToken: jest.fn(),
      listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: '111', config: { account_type: 'ad_account', ad_account_id: '111', access_token: 't' } }]),
      execute: jest.fn() as any,
      recordUsage: jest.fn().mockResolvedValue(true) as any,
      now: () => Date.now(),
      executeWrite: jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', id: 'c1' }),
      recordWrite: recordWrite as any,
    };
    await handleMetaToolkitCall({
      authorization: 'Bearer aw_k', toolName: 'call_meta_marketing_api',
      args: { entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_id: 'c1', params: { status: 'ACTIVE' } },
    }, deps);
    expect(recordWrite).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'CAMPAIGN', action: 'UPDATE', objectId: 'c1', writeKind: 'approve' }));
  });
});
