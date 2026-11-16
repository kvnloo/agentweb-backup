jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({ refuseUnauthorizedScheduledPublish: jest.fn(), attachPublishRevalidation: (_: unknown, c: unknown) => c }));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn() }));
jest.mock('../emma/impl/adsCrmApis', () => ({ handleCallGoogleAdsApi: jest.fn(), handleCallGoogleAdsReportingApi: jest.fn() }));
import { getGoogleToolkitManifest, assertGoogleToolkitCall, isGoogleGuardedWrite } from '../mcp/googleToolkitManifest';
import { executeGoogleToolkitWrite, validateGoogleWriteShape, mapGoogleReadRow, type GoogleToolkitWriteDeps } from '../mcp/googleToolkitWrites';
const cid = '1234567890';
const rn = `customers/${cid}/campaignConversionGoals/77~CONTACT~WEBSITE`;
const args = { customer_id: cid, entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', resource_name: rn, biddable: false };
function fixture() {
  let state: any = { resourceName: rn, campaign: `customers/${cid}/campaigns/77`, name: 'Brand', category: 'CONTACT', origin: 'WEBSITE', biddable: true };
  const deps: GoogleToolkitWriteDeps = {
    assertReady: jest.fn().mockResolvedValue(undefined), read: jest.fn(async () => state && { ...state }),
    dispatch: jest.fn(async () => { state.biddable = false; return { success: true }; }),
    spendCeilingPolicy: () => null, secret: () => 'test-secret', now: () => 1000, consumedTokens: new Map(),
  };
  return { deps, set: (s: any) => { state = s; } };
}
it('advertises only campaign goal LIST/UPDATE and narrowed goal arguments', () => {
  const api = getGoogleToolkitManifest()[0];
  expect(api.inputSchema.properties.entity_type.enum).toContain('CAMPAIGN_CONVERSION_GOAL');
  expect(api.inputSchema.properties.entity_type.enum).not.toContain('CUSTOMER_CONVERSION_GOAL');
  for (const key of ['resource_name', 'biddable', 'campaign_id']) expect(api.inputSchema.properties[key]).toBeDefined();
  expect(api.description).toContain('CAMPAIGN_CONVERSION_GOAL');
  expect(() => assertGoogleToolkitCall('call_google_ads_api', { ...args, action: 'LIST' })).not.toThrow();
  expect(isGoogleGuardedWrite('call_google_ads_api', args)).toBe(true);
  expect(() => assertGoogleToolkitCall('call_google_ads_api', { ...args, entity_type: 'CUSTOMER_CONVERSION_GOAL' })).toThrow();
});
it('validates boolean-only update and customer-scoped composite resource before I/O', async () => {
  expect(validateGoogleWriteShape(args, 'USD').dispatchArgs).toEqual(args);
  for (const bad of [{ biddable: 'false' }, { biddable: undefined }, { resource_name: rn.replace(cid, '999') }, { resource_name: rn.replace('campaignConversionGoals', 'customerConversionGoals') }, { resource_name: rn + "'" }, { campaign_id: '77' }, { status: 'PAUSED' }, { category: 'CONTACT' }]) {
    const { deps } = fixture();
    await expect(executeGoogleToolkitWrite('u', { ...args, ...bad }, 'USD', deps)).rejects.toThrow();
    expect(deps.assertReady).not.toHaveBeenCalled();
  }
});
it('previews identity and current/new biddable, then confirms only by independent read-back', async () => {
  const { deps } = fixture();
  const p: any = await executeGoogleToolkitWrite('u', args, 'USD', deps);
  for (const text of ['Brand', 'CONTACT', 'WEBSITE', 'true → false']) expect(p.preview).toContain(text);
  expect(deps.dispatch).not.toHaveBeenCalled();
  const missing: any = await executeGoogleToolkitWrite('u', { ...args, confirm: true }, 'USD', deps);
  expect(missing.status).toBe('PREVIEW_MISMATCH');
  const result = await executeGoogleToolkitWrite('u', { ...args, confirm: true, preview_token: p.preview_token }, 'USD', deps);
  expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', biddable: false });
  expect(deps.dispatch).toHaveBeenCalledWith('u', args);
});
it.each(['MISMATCH', 'UNCONFIRMED'])('never claims success for %s read-back', async (verification) => {
  const f = fixture();
  const p: any = await executeGoogleToolkitWrite('u', args, 'USD', f.deps);
  (f.deps.dispatch as jest.Mock).mockImplementation(async () => { if (verification === 'UNCONFIRMED') f.set(null); return { success: true }; });
  expect(await executeGoogleToolkitWrite('u', { ...args, confirm: true, preview_token: p.preview_token }, 'USD', f.deps)).toMatchObject({ success: false, verification });
});
it('maps provider goal identity (ENG-2995: omitted proto3 false reads as false)', () => {
  expect(mapGoogleReadRow('campaign_conversion_goal' as any, { campaign: { name: 'Brand' }, campaignConversionGoal: { resourceName: rn, category: 'CONTACT', origin: 'WEBSITE', biddable: false } })).toMatchObject({ name: 'Brand', biddable: false });
});
