jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({ refuseUnauthorizedScheduledPublish: jest.fn(), attachPublishRevalidation: (_: unknown, c: unknown) => c }));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn() }));
jest.mock('../emma/impl/adsCrmApis', () => ({ handleCallGoogleAdsApi: jest.fn(), handleCallGoogleAdsReportingApi: jest.fn() }));
import { executeGoogleToolkitWrite, mapGoogleReadRow, type GoogleToolkitWriteDeps } from '../mcp/googleToolkitWrites';

// ENG-2995: Google Ads REST omits `biddable` when it is false (proto3 JSON default omission).
const cid = '3677555497';
const rn = `customers/${cid}/campaignConversionGoals/24035153990~PHONE_CALL_LEAD~CALL_FROM_ADS`;
const rawRow = (biddable?: boolean) => ({
  campaign: { name: 'Search' },
  campaignConversionGoal: { resourceName: rn, campaign: `customers/${cid}/campaigns/24035153990`, category: 'PHONE_CALL_LEAD', origin: 'CALL_FROM_ADS', ...(biddable ? { biddable: true } : {}) },
});

function fixture(initial: boolean) {
  let row: any = rawRow(initial);
  const deps: GoogleToolkitWriteDeps = {
    assertReady: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (_u, _c, kind) => mapGoogleReadRow(kind, row)),
    dispatch: jest.fn(async (_u, a: any) => { row = rawRow(a.biddable); return { success: true }; }),
    spendCeilingPolicy: () => null, secret: () => 'test-secret', now: () => 1000, consumedTokens: new Map(),
  };
  return { deps, drop: () => { row = null; } };
}

const update = (biddable: boolean) => ({ customer_id: cid, entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', resource_name: rn, biddable });

it('maps a goal row with omitted biddable as biddable=false', () => {
  expect(mapGoogleReadRow('campaign_conversion_goal' as any, rawRow())).toMatchObject({ resourceName: rn, biddable: false });
  expect(mapGoogleReadRow('campaign_conversion_goal' as any, { campaignConversionGoal: { resourceName: rn, biddable: 'yes' } })).toBeNull();
});

it('UPDATE biddable=true on a non-biddable goal previews and dispatches instead of refusing not-found', async () => {
  const { deps } = fixture(false);
  const p: any = await executeGoogleToolkitWrite('u', update(true), 'USD', deps);
  expect(p.preview).toContain('false → true');
  const r = await executeGoogleToolkitWrite('u', { ...update(true), confirm: true, preview_token: p.preview_token }, 'USD', deps);
  expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', biddable: true });
  expect(deps.dispatch).toHaveBeenCalledTimes(1);
});

it('UPDATE biddable=false confirms when the read-back omits the field', async () => {
  const { deps } = fixture(true);
  const p: any = await executeGoogleToolkitWrite('u', update(false), 'USD', deps);
  const r = await executeGoogleToolkitWrite('u', { ...update(false), confirm: true, preview_token: p.preview_token }, 'USD', deps);
  expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', biddable: false });
});

it('still refuses not-found when the goal row is absent', async () => {
  const f = fixture(false);
  f.drop();
  await expect(executeGoogleToolkitWrite('u', update(true), 'USD', f.deps)).rejects.toThrow(/was not found/);
  expect(f.deps.dispatch).not.toHaveBeenCalled();
});
