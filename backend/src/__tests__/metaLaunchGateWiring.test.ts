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

  it('passes the override through and strips it before the Meta write', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
    (runMetaTrackingGate as jest.Mock).mockResolvedValue({ proceed: true });

    await service.callMetaMarketingApi(
      'user-1', 'CAMPAIGN', 'UPDATE', ACCOUNT, CAMPAIGN, undefined, undefined,
      { status: 'ACTIVE', override_tracking_check: true, confirm: true }, 'sess-1',
    );

    // override reached the gate...
    // Last arg is the ad id, scoped only for AD writes — undefined for a campaign write.
    expect(runMetaTrackingGate).toHaveBeenCalledWith(
      expect.anything(), CAMPAIGN, 'CAMPAIGN_UPDATE', true, 'sess-1', {}, undefined,
    );
    // ...and never reached Meta, which would reject an unknown field.
    const paramsSent = manageCampaignsSpy.mock.calls[0][4];
    expect(paramsSent).not.toHaveProperty('override_tracking_check');
    expect(paramsSent).toEqual(expect.objectContaining({ status: 'ACTIVE' }));
  });

  it('defaults to no override when the flag is absent', async () => {
    (isMetaSpendStartingWrite as jest.Mock).mockReturnValue(true);
    (runMetaTrackingGate as jest.Mock).mockResolvedValue({ proceed: true });

    await service.callMetaMarketingApi(
      'user-1', 'CAMPAIGN', 'UPDATE', ACCOUNT, CAMPAIGN, undefined, undefined, { status: 'ACTIVE', confirm: true }, 'sess-1',
    );

    expect(runMetaTrackingGate).toHaveBeenCalledWith(
      expect.anything(), CAMPAIGN, 'CAMPAIGN_UPDATE', false, 'sess-1', {}, undefined,
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
    expect.anything(), CAMPAIGN, 'AD_UPDATE', false, 'sess-1', {}, 'ad-42',
  );
});
