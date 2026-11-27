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
      objects[`campaign:${CAMPAIGN}`] = { resourceName: CAMPAIGN, status: 'PAUSED', channelType: 'SEARCH', googleSearch: true, searchPartners: false, displayNetwork: false };
      objects[`campaign_locations:${CAMPAIGN}`] = [1007753];
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
    const on = { ...update, target_content_network: undefined, target_search_network: true };
    objects[`campaign:${CAMPAIGN}`] = { ...campaign, searchPartners: false };
    const po: any = await executeGoogleToolkitWrite('u', on, 'INR', d);
    await executeGoogleToolkitWrite('u', { ...on, confirm: true, preview_token: po.preview_token }, 'INR', d);
    // Search partners on needs Google Search on in the same request, or the service refuses it.
    expect((d.dispatch as jest.Mock).mock.calls[1][1]).toMatchObject({ target_search_network: true, target_google_search: true });
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
    })).toBe('EXCESSIVE_CAPITALIZATION (PROHIBITED), PUNCTUATION (PROHIBITED)');
    expect(googleAdsPolicyReasons({ details: { policyViolationDetails: { externalPolicyName: 'Trademarks', key: { policyName: 'trademark', violatingText: 'Acme' } } } }))
      .toBe('trademark');
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

describe('5. Turning off the last biddable conversion goal is warned about', () => {
  const goal = `customers/${CID}/campaignConversionGoals/22~SUBMIT_LEAD_FORM~WEBSITE`;
  const prior = { resourceName: goal, campaign: CAMPAIGN, name: 'Spring', category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true };
  const args = { customer_id: CID, entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', resource_name: goal, biddable: false };
  it('warns in the preview when no other standard goal is biddable (custom goals may still make it valid)', async () => {
    const p: any = await executeGoogleToolkitWrite('u', args, 'INR', deps({ [`campaign_conversion_goal:${goal}`]: prior, [`campaign_conversion_goals:${CAMPAIGN}`]: [prior] }));
    expect(p.preview).toContain('EMPTY_CONVERSION_GOALS');
  });
  it('no warning when another goal still bids', async () => {
    const other = { ...prior, resourceName: `customers/${CID}/campaignConversionGoals/22~PURCHASE~WEBSITE`, category: 'PURCHASE' };
    const p: any = await executeGoogleToolkitWrite('u', args, 'INR', deps({ [`campaign_conversion_goal:${goal}`]: prior, [`campaign_conversion_goals:${CAMPAIGN}`]: [prior, other] }));
    expect(p.preview).not.toContain('Warning');
  });
});

describe('6/8. Read shapes', () => {
  it('a paused campaign is a serving answer, not a failure, and the report is not repeated', () => {
    const report = { state: 'BLOCKED_BY_CAMPAIGN', campaigns: [] };
    const out = shapeGoogleToolkitRead('call_google_ads_reporting_api', { mode: 'serving_chain' }, { success: false, report, error: JSON.stringify(report) });
    expect(out).toEqual({ success: true, report, serving_state: 'BLOCKED_BY_CAMPAIGN', serving: false, ready: false });
  });
  it('a failed serving read stays a failure, in one line', () => {
    const report = { state: 'UNVERIFIED', campaigns: [], blockers: [{ state: 'UNVERIFIED', reason: 'API or permission failure' }] };
    const out = shapeGoogleToolkitRead('call_google_ads_reporting_api', { mode: 'serving_chain' }, { success: false, report, error: JSON.stringify(report) });
    expect(out).toMatchObject({ success: false, serving_state: 'UNVERIFIED', error: 'Serving status could not be verified: API or permission failure.' });
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
    // Both parents are paused: both are named, and enabling the campaign alone is not promised to be enough.
    expect(p.preview).toContain('Its ad group "customers/1234567890/adGroups/33" is PAUSED and its campaign "Spring" is PAUSED, so this alone does not start delivery.');
    expect(p.preview).toContain('only once those are enabled too');
    expect(p.preview).not.toContain('as soon as Google applies it');
  });
  it('names a paused ad group even when the campaign is enabled', async () => {
    const ad = { resourceName: AD, status: 'PAUSED', type: 'RESPONSIVE_SEARCH_AD', adGroup: AD_GROUP };
    const p: any = await executeGoogleToolkitWrite('u', { customer_id: CID, entity_type: 'AD', action: 'UPDATE', ad_resource_name: AD, status: 'ENABLED' }, 'INR', deps({
      [`ad:${AD}`]: ad,
      [`ad_group:${AD_GROUP}`]: { resourceName: AD_GROUP, name: 'AG', status: 'PAUSED', campaign: CAMPAIGN },
      [`campaign:${CAMPAIGN}`]: { resourceName: CAMPAIGN, name: 'Spring', status: 'ENABLED', budget: BUDGET },
      [`budget:${BUDGET}`]: budget,
    }));
    expect(p.preview).toContain('Its ad group "AG" is PAUSED, so this alone does not start delivery.');
    expect(p.preview).toContain('only once that is enabled too');
  });
});

describe('Review findings: bid targets match what is sent and are refused before the preview', () => {
  const b = { [`budget:${BUDGET}`]: budget };
  it.each([
    [{ bidding_strategy: 'TARGET_ROAS', bidding_strategy_target: 0 }, /greater than 0/],
    [{ bidding_strategy: 'TARGET_ROAS' }, /requires bidding_strategy_target/],
    [{ bidding_strategy: 'TARGET_IMPRESSION_SHARE', bidding_strategy_target: 65 }, /fraction in \(0, 1\]/],
    [{ bidding_strategy: 'TARGET_CPA', bidding_strategy_target: 'abc' }, /greater than 0/],
    [{ bidding_strategy: 'MAXIMIZE_CONVERSIONS', cpc_bid_ceiling: 10 }, /cpc_bid_ceiling is not a campaign-level field/],
    [{ bidding_strategy: 'MANUAL_CPC', bidding_strategy_target: 5, cpc_bid_ceiling: undefined }, /not a field of MANUAL_CPC/],
  ])('%o is refused before any I/O', async (extra, error) => {
    const d = deps(b);
    await expect(executeGoogleToolkitWrite('u', { ...create, cpc_bid_ceiling: undefined, ...extra }, 'INR', d)).rejects.toThrow(error as RegExp);
    expect(d.assertReady).not.toHaveBeenCalled();
  });
  it('a CPA in a zero-decimal currency is rounded the same in the preview and the dispatch', async () => {
    const objects: Record<string, any> = { [`budget:${BUDGET}`]: budget };
    const d = deps(objects, () => { objects[`campaign:${CAMPAIGN}`] = { resourceName: CAMPAIGN, status: 'PAUSED', googleSearch: true }; });
    await expect(executeGoogleToolkitWrite('u', { ...create, cpc_bid_ceiling: undefined, bidding_strategy: 'TARGET_CPA', bidding_strategy_target: 150.5 }, 'JPY', d))
      .rejects.toThrow(/bidding_strategy_target/); // JPY has no minor unit: 150.5 is refused, not silently re-rounded
    const args = { ...create, cpc_bid_ceiling: undefined, bidding_strategy: 'TARGET_CPA', bidding_strategy_target: 150 };
    const p: any = await executeGoogleToolkitWrite('u', args, 'JPY', d);
    expect(p.preview).toContain('Bidding: TARGET_CPA (target CPA 150 JPY).');
    await executeGoogleToolkitWrite('u', { ...args, confirm: true, preview_token: p.preview_token }, 'JPY', d);
    expect((d.dispatch as jest.Mock).mock.calls[0][1].bidding_strategy_target).toBe(150);
  });
});

describe('Review findings: network edits and location proof', () => {
  const campaign = { resourceName: CAMPAIGN, name: 'Old', status: 'PAUSED', channelType: 'SEARCH', googleSearch: true, searchPartners: false, displayNetwork: false };
  const update = { customer_id: CID, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN };
  it('refuses non-boolean flags on CREATE and UPDATE', async () => {
    const d = deps({ [`budget:${BUDGET}`]: budget, [`campaign:${CAMPAIGN}`]: campaign });
    await expect(executeGoogleToolkitWrite('u', { ...create, target_content_network: 'true' }, 'INR', d)).rejects.toThrow(/true or false/);
    await expect(executeGoogleToolkitWrite('u', { ...update, target_search_network: 'true' }, 'INR', d)).rejects.toThrow(/true or false/);
  });
  it('refuses a network edit that changes nothing', async () => {
    await expect(executeGoogleToolkitWrite('u', { ...update, target_content_network: false }, 'INR', deps({ [`campaign:${CAMPAIGN}`]: campaign })))
      .rejects.toThrow(/nothing to change/);
  });
  it('turning partners on shows Google Search and is a MISMATCH if the read-back disagrees', async () => {
    const objects: Record<string, any> = { [`campaign:${CAMPAIGN}`]: campaign };
    const d = deps(objects, () => { objects[`campaign:${CAMPAIGN}`] = { ...campaign, searchPartners: false }; });
    const on = { ...update, target_search_network: true };
    const p: any = await executeGoogleToolkitWrite('u', on, 'INR', d);
    expect(p.preview).toContain('Google Search: on → on (search partners require it).');
    const r: any = await executeGoogleToolkitWrite('u', { ...on, confirm: true, preview_token: p.preview_token }, 'INR', d);
    expect(r).toMatchObject({ success: false, verification: 'MISMATCH' });
  });
  it('a campaign whose locations did not attach is not CONFIRMED', async () => {
    const objects: Record<string, any> = { [`budget:${BUDGET}`]: budget };
    const d = deps(objects, () => {
      objects[`campaign:${CAMPAIGN}`] = { resourceName: CAMPAIGN, status: 'PAUSED', channelType: 'SEARCH', googleSearch: true };
      objects[`campaign_locations:${CAMPAIGN}`] = [];
    });
    const p: any = await executeGoogleToolkitWrite('u', create, 'INR', d);
    const r: any = await executeGoogleToolkitWrite('u', { ...create, confirm: true, preview_token: p.preview_token }, 'INR', d);
    expect(r).toMatchObject({ success: false, verification: 'MISMATCH' });
    expect(r.message).toContain('missing 1007753');
    expect(r.message).toContain('every country');
  });
  it('maps location criteria to numeric ids', () => {
    const { mapGoogleReadRows } = jest.requireActual('../mcp/googleToolkitWrites');
    expect(mapGoogleReadRows('campaign_locations', [{ campaignCriterion: { location: { geoTargetConstant: 'geoTargetConstants/1007753' } } }])).toEqual([1007753]);
  });
});

describe('Review findings: goal list is part of the approved state; policy detail', () => {
  it('a goal list that changes between preview and confirm invalidates the token', async () => {
    const goal = `customers/${CID}/campaignConversionGoals/22~SUBMIT_LEAD_FORM~WEBSITE`;
    const prior = { resourceName: goal, campaign: CAMPAIGN, name: 'Spring', category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true };
    const other = { ...prior, resourceName: `customers/${CID}/campaignConversionGoals/22~PURCHASE~WEBSITE`, category: 'PURCHASE' };
    const objects: Record<string, any> = { [`campaign_conversion_goal:${goal}`]: prior, [`campaign_conversion_goals:${CAMPAIGN}`]: [prior, other] };
    const d = deps(objects);
    const args = { customer_id: CID, entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', resource_name: goal, biddable: false };
    const p: any = await executeGoogleToolkitWrite('u', args, 'INR', d);
    objects[`campaign_conversion_goals:${CAMPAIGN}`] = [prior, { ...other, biddable: false }];
    const r: any = await executeGoogleToolkitWrite('u', { ...args, confirm: true, preview_token: p.preview_token }, 'INR', d);
    expect(r.status).toBe('PREVIEW_MISMATCH');
    expect(d.dispatch).not.toHaveBeenCalled();
  });
  it('policy reasons name the failing field but never quote ad copy (it would be misread by error classifiers)', () => {
    const reasons = googleAdsPolicyReasons({
      details: { policyFindingDetails: { policyTopicEntries: [{ topic: 'PUNCTUATION', type: 'PROHIBITED', evidences: [{ textList: { texts: ['Save 500 today, sign in!!!'] } }] }] } },
      trigger: { stringValue: 'Sign in for free' },
      location: { fieldPathElements: [{ fieldName: 'operations', index: 0 }, { fieldName: 'headlines', index: 2 }] },
    });
    expect(reasons).toBe('PUNCTUATION (PROHIBITED), at operations[0].headlines[2]');
    const { classifyToolErrorClass } = jest.requireActual('../utils/toolErrorClassifier');
    const { zomaErrorNextStep } = jest.requireActual('../mcp/zomaNextStep');
    const message = `POLICY_FINDING: The resource has been disapproved. Policy: ${reasons}.`;
    expect(classifyToolErrorClass(new Error(message))).not.toBe('upstream_5xx');
    expect(zomaErrorNextStep(message)).not.toMatch(/^Call zoma_status/);
  });
  it('a failed goal-list read keeps the preview (the warning is advisory)', async () => {
    const goal = `customers/${CID}/campaignConversionGoals/22~SUBMIT_LEAD_FORM~WEBSITE`;
    const prior = { resourceName: goal, campaign: CAMPAIGN, name: 'Spring', category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE', biddable: true };
    const d = deps({ [`campaign_conversion_goal:${goal}`]: prior });
    (d.read as jest.Mock).mockImplementation(async (_u: string, _c: string, kind: string) => { if (kind === 'campaign_conversion_goals') throw new Error('boom'); return prior; });
    const p: any = await executeGoogleToolkitWrite('u', { customer_id: CID, entity_type: 'CAMPAIGN_CONVERSION_GOAL', action: 'UPDATE', resource_name: goal, biddable: false }, 'INR', d);
    expect(p.status).toBe('PREVIEW');
  });
});
