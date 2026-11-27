/**
 * Zoma Google QA (2026-11-27, live on a real account): regressions found by running every
 * Google Ads action through prod Zoma. Each block names the finding it pins.
 */
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({ refuseUnauthorizedScheduledPublish: jest.fn(), attachPublishRevalidation: (_: unknown, c: unknown) => c }));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn() }));
jest.mock('../emma/impl/adsCrmApis', () => ({
  ...jest.requireActual('../emma/impl/adsCrmApis'),
  handleCallGoogleAdsApi: jest.fn(), handleCallGoogleAdsReportingApi: jest.fn(),
}));
import { getGoogleToolkitManifest, shapeGoogleToolkitRead } from '../mcp/googleToolkitManifest';
import { executeGoogleToolkitWrite, mapGoogleReadRow, type GoogleToolkitWriteDeps } from '../mcp/googleToolkitWrites';
import { googleAdsPolicyReasons } from '../emma/impl/adsCrmApis';
import { zomaNextStep } from '../mcp/zomaNextStep';

const CID = '1234567890';
const BUDGET = `customers/${CID}/campaignBudgets/11`;
const CAMPAIGN = `customers/${CID}/campaigns/22`;
const AD = `customers/${CID}/adGroupAds/33~44`;
const AD_GROUP = `customers/${CID}/adGroups/33`;

function deps(objects: Record<string, any>, onDispatch?: (args: any) => void): GoogleToolkitWriteDeps {
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (_u, _c, kind, rn) => objects[`${kind}:${rn}`] ?? null),
    dispatch: jest.fn(async (_u, args) => { onDispatch?.(args); return { success: true, campaignResourceName: CAMPAIGN }; }),
    spendCeilingPolicy: () => null, secret: () => 'test-secret', now: () => 1000, consumedTokens: new Map(),
  };
}

const create = {
  customer_id: CID, entity_type: 'CAMPAIGN', action: 'CREATE', name: 'Spring Search', type: 'SEARCH',
  budget_resource_name: BUDGET, bidding_strategy: 'TARGET_SPEND', cpc_bid_ceiling: 10, location_target_ids: [1007753],
};
const budget = { resourceName: BUDGET, name: 'My budget', amountMicros: 2_000_000, explicitlyShared: false, referenceCount: 0 };

describe('1. Search campaigns are Google Search only unless the caller opts in', () => {
  it('sends search partners and Display Network off, says so in the preview, and verifies them', async () => {
    const objects: Record<string, any> = { [`budget:${BUDGET}`]: budget };
    const d = deps(objects, () => {
      objects[`campaign:${CAMPAIGN}`] = { resourceName: CAMPAIGN, status: 'PAUSED', channelType: 'SEARCH', searchPartners: false, displayNetwork: false };
    });
    const p: any = await executeGoogleToolkitWrite('u', create, 'INR', d);
    expect(p.preview).toContain('Networks: Google Search (off: search partners, Display Network).');
    const r: any = await executeGoogleToolkitWrite('u', { ...create, confirm: true, preview_token: p.preview_token }, 'INR', d);
    expect((d.dispatch as jest.Mock).mock.calls[0][1]).toMatchObject({ target_google_search: true, target_search_network: false, target_content_network: false });
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED' });
  });

  it('a campaign that comes back on the Display Network is a MISMATCH, not success', async () => {
    const objects: Record<string, any> = { [`budget:${BUDGET}`]: budget };
    const d = deps(objects, () => {
      objects[`campaign:${CAMPAIGN}`] = { resourceName: CAMPAIGN, status: 'PAUSED', channelType: 'SEARCH', searchPartners: true, displayNetwork: true };
    });
    const p: any = await executeGoogleToolkitWrite('u', create, 'INR', d);
    const r: any = await executeGoogleToolkitWrite('u', { ...create, confirm: true, preview_token: p.preview_token }, 'INR', d);
    expect(r).toMatchObject({ success: false, verification: 'MISMATCH' });
  });

  it('opting in is explicit and named in the preview', async () => {
    const d = deps({ [`budget:${BUDGET}`]: budget });
    const p: any = await executeGoogleToolkitWrite('u', { ...create, target_content_network: true }, 'INR', d);
    expect(p.preview).toContain('Display Network (ads can also show on websites and apps)');
    await expect(executeGoogleToolkitWrite('u', { ...create, type: 'PERFORMANCE_MAX', target_content_network: true }, 'INR', d)).rejects.toThrow(/SEARCH campaigns only/);
  });

  it('network settings can be turned off on an existing Search campaign, current vs new', async () => {
    const campaign = { resourceName: CAMPAIGN, name: 'Old', status: 'PAUSED', channelType: 'SEARCH', searchPartners: true, displayNetwork: true };
    const objects: Record<string, any> = { [`campaign:${CAMPAIGN}`]: campaign };
    const d = deps(objects, () => { objects[`campaign:${CAMPAIGN}`] = { ...campaign, displayNetwork: false }; });
    const update = { customer_id: CID, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, target_content_network: false };
    const p: any = await executeGoogleToolkitWrite('u', update, 'INR', d);
    expect(p.preview).toContain('Display Network (ads on websites and apps): on → off.');
    const r: any = await executeGoogleToolkitWrite('u', { ...update, confirm: true, preview_token: p.preview_token }, 'INR', d);
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED' });
    objects[`campaign:${CAMPAIGN}`] = { ...campaign, channelType: 'PERFORMANCE_MAX' };
    await expect(executeGoogleToolkitWrite('u', update, 'INR', d)).rejects.toThrow(/Search campaigns only/);
  });

  it('reads network settings with proto3 false omitted', () => {
    expect(mapGoogleReadRow('campaign', { campaign: { resourceName: CAMPAIGN, status: 'PAUSED', networkSettings: { targetContentNetwork: true } } }))
      .toMatchObject({ searchPartners: false, displayNetwork: true });
  });
});

describe('2. Google policy rejections name the policy', () => {
  it('carries policy topics and violating text', () => {
    expect(googleAdsPolicyReasons({
      details: { policyFindingDetails: { policyTopicEntries: [{ topic: 'EXCESSIVE_CAPITALIZATION', type: 'PROHIBITED' }, { topic: 'PUNCTUATION', type: 'PROHIBITED' }] } },
      trigger: { stringValue: 'BUY NOW!!!' },
    })).toBe('EXCESSIVE_CAPITALIZATION (PROHIBITED), PUNCTUATION (PROHIBITED), triggered by "BUY NOW!!!"');
    expect(googleAdsPolicyReasons({ details: { policyViolationDetails: { externalPolicyName: 'Trademarks', key: { violatingText: 'Acme' } } } }))
      .toBe('Trademarks on "Acme"');
    expect(googleAdsPolicyReasons({ message: 'no policy' })).toBeUndefined();
  });
});

describe('3. Display is not offered (Zoma cannot create Display ads)', () => {
  it('refuses DISPLAY campaigns and DISPLAY_STANDARD ad groups before any I/O', async () => {
    const d = deps({});
    await expect(executeGoogleToolkitWrite('u', { ...create, type: 'DISPLAY', bidding_strategy: 'MANUAL_CPC', cpc_bid_ceiling: undefined }, 'INR', d)).rejects.toThrow(/Display campaigns are not available/);
    await expect(executeGoogleToolkitWrite('u', { customer_id: CID, entity_type: 'AD_GROUP', action: 'CREATE', name: 'x', campaign_resource_name: CAMPAIGN, type: 'DISPLAY_STANDARD' }, 'INR', d)).rejects.toThrow(/Display ad groups are not available/);
    expect(d.assertReady).not.toHaveBeenCalled();
  });
});

describe('4. Campaign create preview names what matters', () => {
  it('shows locations, the max CPC cap and the budget rename', async () => {
    const p: any = await executeGoogleToolkitWrite('u', create, 'INR', deps({ [`budget:${BUDGET}`]: budget }));
    expect(p.preview).toContain('Bidding: TARGET_SPEND (max CPC cap 10.00 INR).');
    expect(p.preview).toContain('Locations: 1007753 (Google location ids) — people in, or showing interest in, these locations');
    expect(p.preview).toContain('Google renames this (unshared) budget to "Spring Search"');
  });
  it('says when there is no location at all', async () => {
    const p: any = await executeGoogleToolkitWrite('u', { ...create, location_target_ids: undefined }, 'INR', deps({ [`budget:${BUDGET}`]: budget }));
    expect(p.preview).toContain('Locations: none set — the campaign can serve in every country.');
  });
});

describe('5. The last biddable conversion goal cannot be turned off', () => {
  const goal = `customers/${CID}/campaignConversionGoals/22~SUBMIT_LEAD_FORM~WEBSITE`;
  const prior = { resourceName: goal, campaign: CAMPAIGN, name: 'Spring', category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true };
  const args = { customer_id: CID, entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', resource_name: goal, biddable: false };
  it('refuses before sending when no other goal is biddable', async () => {
    const d = deps({ [`campaign_conversion_goal:${goal}`]: prior, [`campaign_conversion_goals:${CAMPAIGN}`]: [prior] });
    await expect(executeGoogleToolkitWrite('u', args, 'INR', d)).rejects.toThrow(/only conversion goal/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });
  it('previews normally when another goal still bids', async () => {
    const other = { ...prior, resourceName: `customers/${CID}/campaignConversionGoals/22~PURCHASE~WEBSITE`, category: 'PURCHASE' };
    const p: any = await executeGoogleToolkitWrite('u', args, 'INR', deps({ [`campaign_conversion_goal:${goal}`]: prior, [`campaign_conversion_goals:${CAMPAIGN}`]: [prior, other] }));
    expect(p.status).toBe('PREVIEW');
  });
});

describe('6/8. Read shapes', () => {
  it('a paused campaign is a serving answer, not a failure, and the report is not repeated', () => {
    const report = { state: 'BLOCKED_BY_CAMPAIGN', campaigns: [] };
    const out = shapeGoogleToolkitRead('call_google_ads_reporting_api', { mode: 'serving_chain' }, { success: false, report, error: JSON.stringify(report) });
    expect(out).toEqual({ success: true, report, serving_state: 'BLOCKED_BY_CAMPAIGN', serving: false, ready: false });
  });
  it('conversion actions drop tag snippets but keep the conversion tag ids', () => {
    const out = shapeGoogleToolkitRead('call_google_ads_api', { entity_type: 'CONVERSION_ACTION', action: 'LIST' },
      { success: true, conversionActions: [{ id: '1', tagSnippets: [{ globalSiteTag: '<script>…</script>' }], tag: { sendTo: 'AW-1/x' } }] });
    expect(out.conversionActions).toEqual([{ id: '1', tag: { sendTo: 'AW-1/x' } }]);
  });
});

describe('7. Guidance names only what Zoma offers', () => {
  it('Google answers point at the Google report, not the Meta-only zoma_ads_report', () => {
    expect(zomaNextStep('call_google_ads_api', { entity_type: 'CAMPAIGN', action: 'LIST' }, { success: true })).toContain('call_google_ads_reporting_api');
    expect(zomaNextStep('call_google_ads_api', { entity_type: 'CAMPAIGN', action: 'LIST' }, { success: true })).not.toContain('zoma_ads_report');
  });
  it('advertised parameters mention no action or tool outside the Zoma surface', () => {
    const text = JSON.stringify(getGoogleToolkitManifest());
    for (const gone of ['list_connected_accounts', 'audit_ad_utm_coverage', 'RETAG_UTM', 'BUDGET REMOVE', 'AD UPDATE/REMOVE', 'PAUSE/RESUME', 'ADD_PROXIMITY', 'DISPLAY_STANDARD']) {
      expect(text).not.toContain(gone);
    }
  });
});

describe('8. Enabling a child of a paused campaign is worded consistently', () => {
  it('does not also claim it can start spending now', async () => {
    const ad = { resourceName: AD, status: 'PAUSED', type: 'RESPONSIVE_SEARCH_AD', adGroup: AD_GROUP };
    const p: any = await executeGoogleToolkitWrite('u', { customer_id: CID, entity_type: 'AD', action: 'UPDATE', ad_resource_name: AD, status: 'ENABLED' }, 'INR', deps({
      [`ad:${AD}`]: ad,
      [`ad_group:${AD_GROUP}`]: { resourceName: AD_GROUP, status: 'PAUSED', campaign: CAMPAIGN },
      [`campaign:${CAMPAIGN}`]: { resourceName: CAMPAIGN, name: 'Spring', status: 'PAUSED', budget: BUDGET },
      [`budget:${BUDGET}`]: budget,
    }));
    expect(p.preview).toContain('so this alone does not start delivery');
    expect(p.preview).toContain('it starts delivery and spending once its campaign is also enabled');
    expect(p.preview).not.toContain('as soon as Google applies it');
  });
});
