/**
 * ENG-941 — proof the gate is actually wired into the Meta write path.
 *
 * The pure check lives in metaTrackingPreflight.test.ts and the enforcement logic in
 * metaLaunchGate.test.ts. Neither proves the gate is *reached*: a gate that is never
 * called is indistinguishable from no gate at all, and that is the failure mode this
 * file exists to rule out. Here the gate module is mocked and we assert
 * callMetaMarketingApi consults it — and, crucially, that a blocked launch never
 * reaches the Meta write.
 */
jest.mock('../services/metaLaunchGate', () => ({
  isMetaSpendStartingWrite: jest.fn(),
  runMetaTrackingGate: jest.fn(),
  // Real implementation: it is a pure params reader, and stubbing it would hide whether the
  // write path actually passes a creating ad's destination through to the gate.
  collectPendingDestinations: jest.requireActual('../services/metaLaunchGate').collectPendingDestinations,
  collectPendingCreativeIds: jest.requireActual('../services/metaLaunchGate').collectPendingCreativeIds,
  // Real: this is the signing primitive the override binding rests on. A stub would let the
  // binding test pass against a token nothing actually verified.
  computeTrackingOverrideDigest: jest.requireActual('../services/metaLaunchGate').computeTrackingOverrideDigest,
  trackingOverrideTokenMatches: jest.requireActual('../services/metaLaunchGate').trackingOverrideTokenMatches,
}));

import { AgentModeService } from '../services/agentModeService';
import { isMetaSpendStartingWrite, runMetaTrackingGate } from '../services/metaLaunchGate';

const ACCOUNT = '409853340719899';
const CAMPAIGN = '120200000000000';

let service: AgentModeService;
let manageCampaignsSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
  // Credentials and the downstream write are both out of scope here.
  jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: ACCOUNT, accessToken: 'tok' });
  manageCampaignsSpy = jest
    .spyOn(service as any, 'manageMetaAdsCampaigns')
    .mockResolvedValue({ success: true, message: 'campaign updated' });
});

describe('callMetaMarketingApi — ENG-941 gate wiring', () => {
  it('does not reach the Meta write when the gate blocks', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
    (runMetaTrackingGate as jest.Mock).mockResolvedValue({
      proceed: false,
      blockResult: { success: false, blocked: true, reason: 'tracking_preflight', error: 'Launch blocked: ...' },
    });

    const res: any = await service.callMetaMarketingApi(
      'user-1', 'CAMPAIGN', 'UPDATE', ACCOUNT, CAMPAIGN, undefined, undefined, { status: 'ACTIVE', confirm: true }, 'sess-1',
    );

    expect(res).toEqual(expect.objectContaining({ blocked: true, reason: 'tracking_preflight' }));
    expect(manageCampaignsSpy).not.toHaveBeenCalled();
  });

  it('proceeds to the Meta write when the gate passes', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
    (runMetaTrackingGate as jest.Mock).mockResolvedValue({ proceed: true });

    const res: any = await service.callMetaMarketingApi(
      'user-1', 'CAMPAIGN', 'UPDATE', ACCOUNT, CAMPAIGN, undefined, undefined, { status: 'ACTIVE', confirm: true }, 'sess-1',
    );

    expect(runMetaTrackingGate).toHaveBeenCalled();
    expect(manageCampaignsSpy).toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ success: true }));
  });

  it('never runs the gate for a write that does not start spend', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(false);

    await service.callMetaMarketingApi(
      'user-1', 'CAMPAIGN', 'UPDATE', ACCOUNT, CAMPAIGN, undefined, undefined, { status: 'PAUSED', confirm: true }, 'sess-1',
    );

    expect(runMetaTrackingGate).not.toHaveBeenCalled();
    expect(manageCampaignsSpy).toHaveBeenCalled();
  });

  it('passes a DISCLOSED override through and strips it before the Meta write', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
    (runMetaTrackingGate as jest.Mock).mockResolvedValue({ proceed: true });

    // The override only counts once it has been through a preview that disclosed it, so the
    // token that preview issued is what makes this call an approved one.
    const preview: any = await service.callMetaMarketingApi(
      'user-1', 'CAMPAIGN', 'UPDATE', ACCOUNT, CAMPAIGN, undefined, undefined,
      { status: 'ACTIVE', override_tracking_check: true }, 'sess-1',
    );
    await service.callMetaMarketingApi(
      'user-1', 'CAMPAIGN', 'UPDATE', ACCOUNT, CAMPAIGN, undefined, undefined,
      { status: 'ACTIVE', override_tracking_check: true, tracking_override_token: preview.tracking_override_token, confirm: true },
      'sess-1',
    );

    // override reached the gate...
    // Last arg is the ad id, scoped only for AD writes — undefined for a campaign write.
    expect(runMetaTrackingGate).toHaveBeenCalledWith(
      expect.anything(), CAMPAIGN, 'CAMPAIGN_UPDATE', true, 'sess-1', {}, undefined, [], [],
    );
    // ...and never reached Meta, which would reject an unknown field.
    const paramsSent = manageCampaignsSpy.mock.calls[0][4];
    expect(paramsSent).not.toHaveProperty('override_tracking_check');
    expect(paramsSent).not.toHaveProperty('tracking_override_token');
    expect(paramsSent).toEqual(expect.objectContaining({ status: 'ACTIVE' }));
  });

  it('defaults to no override when the flag is absent', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
    (runMetaTrackingGate as jest.Mock).mockResolvedValue({ proceed: true });

    await service.callMetaMarketingApi(
      'user-1', 'CAMPAIGN', 'UPDATE', ACCOUNT, CAMPAIGN, undefined, undefined, { status: 'ACTIVE', confirm: true }, 'sess-1',
    );

    expect(runMetaTrackingGate).toHaveBeenCalledWith(
      expect.anything(), CAMPAIGN, 'CAMPAIGN_UPDATE', false, 'sess-1', {}, undefined, [], [],
    );
  });

  it('gates an ad set activation on the same path', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
    (runMetaTrackingGate as jest.Mock).mockResolvedValue({
      proceed: false,
      blockResult: { success: false, blocked: true, reason: 'tracking_preflight', error: 'blocked' },
    });
    const adSetSpy = jest.spyOn(service as any, 'manageMetaAdsAdSets').mockResolvedValue({ success: true });

    const res: any = await service.callMetaMarketingApi(
      'user-1', 'AD_SET', 'UPDATE', ACCOUNT, CAMPAIGN, 'adset-1', undefined, { status: 'ACTIVE', confirm: true }, 'sess-1',
    );

    expect(res).toEqual(expect.objectContaining({ blocked: true }));
    expect(adSetSpy).not.toHaveBeenCalled();
  });
});

/**
 * The ENG-600 named launch flows create their ad set directly rather than going through
 * callMetaMarketingApi, so they need their own hook — without it they are the way around
 * the gate. These assert the hook exists and that a block prevents any audience or ad set
 * from being created.
 */
describe('ENG-600 launch flows — ENG-941 gate wiring', () => {
  let seedSpy: jest.SpyInstance;

  beforeEach(() => {
    seedSpy = jest
      .spyOn(service as any, 'resolveOrCreateSeedAudience')
      .mockResolvedValue({ audience: { id: 'aud-1' } });
  });

  const run = (adSetParams: any, extra: any = {}) =>
    (service as any).executeAudienceCampaignLaunch(
      'user-1',
      { account_id: ACCOUNT, campaign_id: CAMPAIGN, ad_set_params: adSetParams, session_id: 'sess-1', ...extra },
      'targeted_audience',
      { type: 'csv', csvUrl: 'https://x/y.csv' },
    );

  it('blocks an ACTIVE launch before any audience is created', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
    (runMetaTrackingGate as jest.Mock).mockResolvedValue({
      proceed: false,
      blockResult: { success: false, blocked: true, reason: 'tracking_preflight', error: 'blocked' },
    });

    const res: any = await run({ status: 'ACTIVE' });

    expect(res).toEqual(expect.objectContaining({ blocked: true, reason: 'tracking_preflight' }));
    expect(seedSpy).not.toHaveBeenCalled();
  });

  it('does not gate a launch whose ad set is not being activated', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(false);
    await run({ status: 'PAUSED' }).catch(() => undefined);
    expect(runMetaTrackingGate).not.toHaveBeenCalled();
  });

  it('passes the campaign, override and session through to the gate', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
    (runMetaTrackingGate as jest.Mock).mockResolvedValue({ proceed: true });

    await run({ status: 'ACTIVE' }, { override_tracking_check: true }).catch(() => undefined);

    expect(runMetaTrackingGate).toHaveBeenCalledWith(
      expect.anything(), CAMPAIGN, 'TARGETED_AUDIENCE_LAUNCH', true, 'sess-1',
    );
  });
});

it('scopes an AD activation to that ad, so a sibling\'s untracked page cannot block it', async () => {
  (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
  (runMetaTrackingGate as jest.Mock).mockResolvedValue({ proceed: true });
  jest.spyOn(service as any, 'manageMetaAdsAds').mockResolvedValue({ success: true });

  await service.callMetaMarketingApi(
    'user-1', 'AD', 'UPDATE', ACCOUNT, CAMPAIGN, 'adset-1', 'ad-42', { status: 'ACTIVE', confirm: true }, 'sess-1',
  );

  expect(runMetaTrackingGate).toHaveBeenCalledWith(
    expect.anything(), CAMPAIGN, 'AD_UPDATE', false, 'sess-1', {}, 'ad-42', [], [],
  );
});

/*
 * Greptile P1, round 3, security ("Confirmed replay can add override"). The preview warns
 * about an override that is present when the preview is built — but the confirmed call is a
 * FRESH call with fresh params, so a model could preview a plain activation, let the user
 * approve that, and then add `override_tracking_check` to the replay. A flag the model can
 * set on the replay is not user-granted, whatever the tool description says.
 *
 * Bound the same way ENG-600's launch confirmation is: the preview issues an HMAC over the
 * exact call it described, and the override only counts when the replay presents that token
 * back. The secret is server-only, so the token cannot be minted by the caller.
 */
describe('override must be bound to the approved preview (ENG-941)', () => {
  const activate = (params: any) =>
    service.callMetaMarketingApi(
      'user-1', 'CAMPAIGN', 'UPDATE', ACCOUNT, CAMPAIGN, undefined, undefined, params, 'sess-1',
    );

  beforeEach(() => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
    (runMetaTrackingGate as jest.Mock).mockResolvedValue({ proceed: true });
  });

  it('refuses an override introduced on the confirmed replay, and re-previews instead of running', async () => {
    const res: any = await activate({ status: 'ACTIVE', override_tracking_check: true, confirm: true });

    expect(res).toEqual(expect.objectContaining({ requiresConfirmation: true, awaitingUserConfirmation: true }));
    expect(runMetaTrackingGate).not.toHaveBeenCalled();
    expect(manageCampaignsSpy).not.toHaveBeenCalled();
  });

  it('discloses the override in that re-preview and issues a token for it', async () => {
    const res: any = await activate({ status: 'ACTIVE', override_tracking_check: true, confirm: true });

    expect(res.summary).toContain('SKIP the tracking pre-flight check');
    expect(typeof res.tracking_override_token).toBe('string');
    expect(res.tracking_override_token.length).toBeGreaterThan(0);
  });

  it('honours the override when the replay presents the token from its own preview', async () => {
    const preview: any = await activate({ status: 'ACTIVE', override_tracking_check: true });
    const res: any = await activate({
      status: 'ACTIVE', override_tracking_check: true, tracking_override_token: preview.tracking_override_token, confirm: true,
    });

    expect(res).toEqual(expect.objectContaining({ success: true }));
    expect((runMetaTrackingGate as jest.Mock).mock.calls[0][3]).toBe(true);
  });

  it('rejects a token minted for a DIFFERENT call — approving one launch does not approve another', async () => {
    const preview: any = await activate({ status: 'ACTIVE', override_tracking_check: true, daily_budget: 500 });
    const res: any = await activate({
      status: 'ACTIVE', override_tracking_check: true, daily_budget: 50000,
      tracking_override_token: preview.tracking_override_token, confirm: true,
    });

    expect(res).toEqual(expect.objectContaining({ requiresConfirmation: true }));
    expect(manageCampaignsSpy).not.toHaveBeenCalled();
  });

  it('rejects a forged token', async () => {
    const res: any = await activate({
      status: 'ACTIVE', override_tracking_check: true, tracking_override_token: 'a'.repeat(64), confirm: true,
    });
    expect(res).toEqual(expect.objectContaining({ requiresConfirmation: true }));
    expect(manageCampaignsSpy).not.toHaveBeenCalled();
  });

  it('leaves an ordinary confirmed activation untouched — no token needed when nothing is being waived', async () => {
    const res: any = await activate({ status: 'ACTIVE', confirm: true });
    expect(res).toEqual(expect.objectContaining({ success: true }));
    expect((runMetaTrackingGate as jest.Mock).mock.calls[0][3]).toBe(false);
  });
});

/*
 * Same hole on the named ENG-600 launch path, closed with the mechanism already there:
 * `preview_token` is an HMAC over the args that define the launch, and the override was
 * simply not among them — so it could be added after the preview without changing the
 * digest. Including it means adding it invalidates the approval, which is the point.
 */
describe('audience launch preview token covers the override (ENG-941)', () => {
  const baseArgs = {
    account_id: ACCOUNT,
    campaign_id: CAMPAIGN,
    audience_name: 'Test audience',
    audience_source: { csv_url: 'https://x/y.csv' },
    ad_set_params: { status: 'ACTIVE' },
  };

  it('produces a different digest once the override is added', () => {
    const without = (service as any).computeAudienceCampaignArgsDigest(baseArgs);
    const with_ = (service as any).computeAudienceCampaignArgsDigest({ ...baseArgs, override_tracking_check: true });
    expect(with_).not.toEqual(without);
  });

  it('is stable for the same args, so a genuine confirmation still matches', () => {
    expect((service as any).computeAudienceCampaignArgsDigest({ ...baseArgs, override_tracking_check: true }))
      .toEqual((service as any).computeAudienceCampaignArgsDigest({ ...baseArgs, override_tracking_check: true }));
  });
});
