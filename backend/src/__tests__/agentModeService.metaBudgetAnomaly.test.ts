import { AgentModeService } from '../services/agentModeService';
import { metaService } from '../services/metaService';
import { computeTrackingOverrideDigest } from '../services/metaLaunchGate';
import { getJwtSecret } from '../config/jwt';
import { metaWriteRateShaper } from '../services/agentMode/metaWriteRateShaper';

jest.mock('../services/metaLaunchGate', () => ({
  ...jest.requireActual('../services/metaLaunchGate'),
  isMetaSpendStartingWrite: jest.fn().mockReturnValue(false),
}));

const ACCOUNT = '123';
let service: AgentModeService;
let write: jest.SpyInstance;
let grant: jest.SpyInstance;
let read: jest.SpyInstance;
const invoke = (params: any, entity = 'CAMPAIGN') => service.callMetaMarketingApi(
  'user', entity as any, 'UPDATE', ACCOUNT, 'campaign', 'adset', undefined, params, 'session',
);

beforeEach(() => {
  metaWriteRateShaper.reset(); // ENG-2280: process-wide shaper; this suite edits one object many times
  service = new AgentModeService();
  jest.spyOn(service as any, 'getMetaCredentials').mockResolvedValue({ accountId: ACCOUNT, accessToken: 'token' });
  jest.spyOn(service as any, 'getLastUserMessageText').mockResolvedValue(undefined);
  grant = jest.spyOn(service as any, 'claimMetaWriteManifestGrant').mockResolvedValue({ granted: true });
  read = jest.spyOn(metaService, 'getCampaign').mockResolvedValue({ id: 'campaign', daily_budget: '10000', spend_cap: '10000' });
  jest.spyOn(metaService, 'getAdSet').mockResolvedValue({ id: 'adset', daily_budget: '10000', lifetime_budget: '10000' });
  jest.spyOn(metaService, 'getAdAccountCurrency').mockResolvedValue('USD');
  write = jest.spyOn(service, 'updateMetaAdsCampaign').mockResolvedValue({ success: true });
  jest.spyOn(service, 'updateMetaAdsAdSet').mockResolvedValue({ success: true });
});
afterEach(() => jest.restoreAllMocks());

describe('ENG-2279 budget anomaly confirmation', () => {
  it('1.9x passes under an existing grant', async () => {
    expect((await invoke({ budget_amount: 190 })).success).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
  });
  it.each([210, 1010, 10000])('%s dollars requires fresh confirmation, including 100x', async amount => {
    const result: any = await invoke({ budget_amount: amount, confirm: true });
    expect(result.awaitingUserConfirmation).toBe(true);
    expect(result.budgetAnomaly.severity).toBe(amount > 1000 ? 'critical' : 'warning');
    if (amount > 1000) expect(result.message).toContain('PAUSE_AND_VERIFY');
    expect(write).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });
  it.each([['CAMPAIGN', 'spend_cap', 210], ['AD_SET', 'daily_budget', 210], ['AD_SET', 'lifetime_budget', 210]])(
    '%s %s compares both sides in minor units', async (entity, field, amount) => {
      const result: any = await invoke({ [field]: amount }, entity as string);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(result.budgetAnomaly.changes[0]).toMatchObject({ prior: 10000, proposed: 21000, ratio: 2.1 });
      expect(service.updateMetaAdsAdSet).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    },
  );
  it('ENG-2913: adding a spend cap to an uncapped campaign is a normal change, not unverifiable', async () => {
    read.mockResolvedValue({ id: 'campaign', daily_budget: '10000' });
    const result: any = await invoke({ spend_cap: 500 });
    expect(result.success).toBe(true);
    expect(write).toHaveBeenCalledWith('user', 'campaign', { spend_cap: 500 }, ACCOUNT);
  });
  it('ENG-2913: a failed read-back still blocks a spend cap as unverifiable', async () => {
    read.mockResolvedValue(null);
    const result: any = await invoke({ spend_cap: 500 });
    expect(result.reason).toBe('meta_budget_prior_unavailable');
    expect(write).not.toHaveBeenCalled();
  });
  it('a valid tracking override cannot bypass the anomaly', async () => {
    const params: any = { budget_amount: 210, override_tracking_check: true };
    params.tracking_override_token = computeTrackingOverrideDigest(getJwtSecret(), {
      entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: ACCOUNT,
      campaign_id: 'campaign', ad_set_id: 'adset', ad_id: undefined, params,
    });
    expect((await invoke(params) as any).awaitingUserConfirmation).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it('a fresh preview requires its own grant and then can execute', async () => {
    const preview: any = await invoke({ budget_amount: 210 });
    expect(preview.metaWriteDispatch.params.budget_confirmation_token).toEqual(expect.any(String));
    grant.mockResolvedValueOnce({ granted: false });
    expect((await invoke(preview.metaWriteDispatch.params) as any).awaitingUserConfirmation).toBe(true);
    expect(write).not.toHaveBeenCalled();
    expect((await invoke(preview.metaWriteDispatch.params)).success).toBe(true);
    expect(write).toHaveBeenCalledWith('user', 'campaign', { budget_amount: 210 }, ACCOUNT);
  });
  it('reconfirms if the prior value changes after preview', async () => {
    const preview: any = await invoke({ budget_amount: 210 });
    read.mockResolvedValue({ id: 'campaign', daily_budget: '5000' });
    expect((await invoke(preview.metaWriteDispatch.params) as any).awaitingUserConfirmation).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it('the direct approval-deck dispatch cannot silently apply 100x', async () => {
    const result = await (service as any).dispatchAuthorizedMetaWrite(
      'user', 'CAMPAIGN', 'UPDATE', ACCOUNT, 'campaign', 'adset', undefined,
      { budget_amount: 10000 }, true, 'session',
    );
    expect(result.awaitingUserConfirmation).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it('does not record a halted deck write as applied', async () => {
    const preview = await invoke({ budget_amount: 10000 });
    const verification = await (AgentModeService as any).verifyMetaWriteDispatchResult({ dispatchResult: preview });
    expect(verification.verified).toBe(false);
    expect(verification.error).toContain('PAUSE_AND_VERIFY');
  });
  it('allows direct deck dispatch after the anomaly preview was approved', async () => {
    const preview: any = await invoke({ budget_amount: 210 });
    const result = await (service as any).dispatchAuthorizedMetaWrite(
      'user', 'CAMPAIGN', 'UPDATE', ACCOUNT, 'campaign', 'adset', undefined,
      preview.metaWriteDispatch.params, false, 'session',
    );
    expect(result.success).toBe(true);
    expect(write).toHaveBeenCalledWith('user', 'campaign', { budget_amount: 210 }, ACCOUNT);
  });
  it('offers pause first when the user flags a spend concern, even below 2x', async () => {
    (service as any).getLastUserMessageText.mockResolvedValue('I am worried about spend. It is spending too much.');
    const result: any = await invoke({ budget_amount: 190 });
    expect(result.awaitingUserConfirmation).toBe(true);
    expect(result.budgetAnomaly.suggestedAction).toBe('PAUSE_AND_VERIFY');
    expect(result.confirmationDetail).toMatch(/pause.*first/i);
    expect(write).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, [], true, 'garbage', -1, Infinity])('fails closed on malformed prior %p', async prior => {
    read.mockResolvedValue({ id: 'campaign', daily_budget: prior });
    const result: any = await invoke({ budget_amount: 210 });
    expect(result.blocked).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it('fails closed when the prior read fails', async () => {
    read.mockRejectedValue(new Error('unavailable'));
    expect((await invoke({ budget_amount: 210 }) as any).blocked).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it('does not block a pause-only write', async () => {
    expect((await invoke({ status: 'PAUSED' })).success).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
