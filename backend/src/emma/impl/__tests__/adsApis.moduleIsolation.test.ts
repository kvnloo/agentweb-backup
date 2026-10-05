/**
 * ENG-2103 F2 — Meta/LinkedIn ads APIs cluster. Same rationale as
 * books/gtmPlans/googleDrive/googleDocsSheets/htmlTools/leads/
 * brandMarketStrategy/mediaVideo/htmlCreation/htmlUpdate/knowledgeBase/
 * blog.moduleIsolation.test.ts: prove something real about the extraction,
 * not just that the code moved.
 *
 * Unlike every prior module-isolation test in this series, this one does
 * NOT assert full isolation from `agentModeService.ts` — a real, empirically
 * confirmed (via the `jest.doMock`-throws technique below, not just reading
 * import lists) transitive chain exists: `adsApis.ts` statically imports
 * `services/metaLaunchGate.ts` (for `isMetaSpendStartingWrite`/
 * `runMetaTrackingGate`, used by the moved `executeAudienceCampaignLaunch`),
 * and `metaLaunchGate.ts` itself statically imports `chatbotDb` from
 * `services/chatbotService.ts`, which in turn statically imports both
 * `agentModeService.ts` and `services/db.ts` (the real
 * `AWS.DynamoDB.DocumentClient`-constructing module) at its own top level.
 * So requiring `adsApis.ts` does load `agentModeService.ts`'s module body.
 *
 * This is NOT a new circularity introduced by this extraction:
 * `agentModeService.ts` already statically imported `metaLaunchGate.ts`
 * before F2 touched this cluster (it's used by several other Meta-write
 * methods that stay on the class), so the chain
 * `agentModeService.ts -> metaLaunchGate.ts -> chatbotService.ts -> agentModeService.ts`
 * already existed, and Node's CJS loader already resolved it to a
 * partially-initialized module on the cycle in production before this PR.
 * Not fixed here: `metaLaunchGate.ts` is shared infrastructure with ~20
 * other callers well outside this cluster's 9 methods, and lazily importing
 * just the two functions this module needs would not change the practical
 * outcome, since `agentModeService.ts` already loads unconditionally and
 * immediately in every real process today.
 *
 * What IS worth pinning: `adsApis.ts` itself has no OTHER path to
 * `agentModeService.ts` — the only route is through `metaLaunchGate.ts`'s
 * own transitive import. If that upstream trap is ever fixed independently,
 * this module becomes fully standalone with no further changes needed here.
 */

describe('emma/impl/adsApis.ts transitive-import shape', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/metaLaunchGate');
  });

  it('DOES transitively load agentModeService.ts (via metaLaunchGate.ts -> chatbotService.ts) — a known, pre-existing limitation, not a regression', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts loaded');
      });
      expect(() => require('../adsApis')).toThrow('agentModeService.ts loaded');
    });
  });

  it('has no OTHER path to agentModeService.ts of its own — blocking metaLaunchGate.ts alone is enough to load standalone', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/metaLaunchGate', () => ({
        isMetaSpendStartingWrite: jest.fn(),
        runMetaTrackingGate: jest.fn(),
        computeTrackingOverrideDigest: jest.fn(),
        trackingOverrideTokenMatches: jest.fn(),
      }));
      expect(() => require('../adsApis')).not.toThrow();
    });
  });

  it('exposes the 9 cluster entry points plus the exported process-* helpers used by getMetaAdsMetrics', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const adsApis = require('../adsApis');
    expect(typeof adsApis.callMetaAdsInsightsApiWrapper).toBe('function');
    expect(typeof adsApis.listMetaAdsCampaignsNew).toBe('function');
    expect(typeof adsApis.getMetaAdsMetrics).toBe('function');
    expect(typeof adsApis.formatMetricsSummary).toBe('function');
    expect(typeof adsApis.processCampaignData).toBe('function');
    expect(typeof adsApis.processAdSetsData).toBe('function');
    expect(typeof adsApis.processAdsData).toBe('function');
    expect(typeof adsApis.generateCampaignSummary).toBe('function');
    expect(typeof adsApis.processBreakdownData).toBe('function');
    expect(typeof adsApis.callMetaMarketingApi).toBe('function');
    expect(typeof adsApis.launchAudienceCampaign).toBe('function');
    expect(typeof adsApis.launchTargetedAudienceCampaign).toBe('function');
    expect(typeof adsApis.launchRetargetingCampaign).toBe('function');
    expect(typeof adsApis.executeAudienceCampaignLaunch).toBe('function');
    expect(typeof adsApis.computeAudienceCampaignArgsDigest).toBe('function');
    expect(typeof adsApis.buildAudienceCampaignConfirmationSummary).toBe('function');
    expect(typeof adsApis.callLinkedInMarketingApi).toBe('function');
    expect(typeof adsApis.callLinkedInAdsInsightsApi).toBe('function');
    // ENG-2103 (F2 follow-up): resolveOrCreateSeedAudience/getCampaignForAdSetReuseCheck/
    // hashAudienceRows are new real exports, moved in from AgentModeService.
    expect(typeof adsApis.resolveOrCreateSeedAudience).toBe('function');
    expect(typeof adsApis.getCampaignForAdSetReuseCheck).toBe('function');
    expect(typeof adsApis.hashAudienceRows).toBe('function');
  });
});

/**
 * ENG-2103 (F2 follow-up) — same rationale as htmlUpdate.moduleIsolation.test.ts's
 * "self-import makes internal calls spy-observable" block. `resolveOrCreateSeedAudience`
 * and `getCampaignForAdSetReuseCheck` were kept unmoved on `AgentModeService` through
 * cluster 18 purely because tests jest.spyOn them directly. Moving them into THIS
 * module means `executeAudienceCampaignLaunch`/`launchAudienceCampaign` (already here)
 * now call sibling functions in the same module — a bare in-module call to a sibling
 * `export function` does NOT go through the exports-namespace object (TS/CommonJS
 * compiles it to a direct local reference), so without the `import * as self from
 * './adsApis'` indirection, `agentModeService.audienceCampaignWorkflows.test.ts`'s and
 * `metaLaunchGateWiring.test.ts`'s retargeted `jest.spyOn(adsApisImpl, '<fn>')` calls
 * would silently stop being exercised. This test proves the indirection actually works,
 * not just that it compiles — verified directly by temporarily removing the `self.`
 * prefix and confirming this exact test (and 24 others across the two files above) fail.
 */
describe('emma/impl/adsApis.ts self-import makes internal calls spy-observable', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('a jest.spyOn on the module namespace intercepts executeAudienceCampaignLaunch\'s own internal resolveOrCreateSeedAudience AND getCampaignForAdSetReuseCheck calls', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const adsApisImpl = require('../adsApis');

    const seedSpy = jest.spyOn(adsApisImpl, 'resolveOrCreateSeedAudience').mockResolvedValue({
      plannedAction: 'create',
      audience: { id: 'aud-mock-1', name: 'Mock Audience' },
      created: true,
      sourceSummary: 'CSV upload (mock)',
      failures: [],
    });
    const campaignSpy = jest.spyOn(adsApisImpl, 'getCampaignForAdSetReuseCheck').mockResolvedValue({});

    const deps = {
      getMetaCredentials: jest.fn().mockResolvedValue({ accountId: 'act_test', accessToken: 'tok' }),
      manageMetaCustomAudiences: jest.fn(),
      resolveHubSpotService: jest.fn(),
      listMetaAdsAdSets: jest.fn().mockResolvedValue({ success: true, adSets: [] }),
      createMetaAdsAdSet: jest.fn().mockResolvedValue({ success: true, adSet: { id: 'adset-1', name: 'Ad Set' } }),
      normalizeMetaMoneyParams: jest.fn().mockResolvedValue({ params: {}, currency: 'USD', confirmation: '' }),
    };

    const result = await adsApisImpl.executeAudienceCampaignLaunch(
      'user-1',
      {
        account_id: 'act_test',
        campaign_id: 'camp_test',
        audience_name: 'Mock Audience',
        // Explicit non-ACTIVE status so isMetaSpendStartingWrite short-circuits the
        // Meta tracking gate — not what this test is about.
        ad_set_params: { name: 'Ad Set', status: 'PAUSED', targeting: {} },
      },
      'targeted_audience',
      { type: 'csv', csvUrl: 'https://example.com/a.csv' },
      deps as any,
    );

    // If the self-import indirection were missing, executeAudienceCampaignLaunch would
    // call the REAL resolveOrCreateSeedAudience/getCampaignForAdSetReuseCheck (which
    // would call the bare jest.fn() deps above and either throw or return undefined)
    // instead of these mocks — this call would fail rather than return the mocked ledger.
    expect(seedSpy).toHaveBeenCalledWith(
      'user-1', 'act_test', 'Mock Audience', { type: 'csv', csvUrl: 'https://example.com/a.csv' }, { dryRun: false },
      expect.objectContaining({ manageMetaCustomAudiences: deps.manageMetaCustomAudiences, resolveHubSpotService: deps.resolveHubSpotService }),
    );
    expect(campaignSpy).toHaveBeenCalledWith(
      'user-1', 'act_test', 'camp_test',
      expect.objectContaining({ getMetaCredentials: deps.getMetaCredentials }),
    );
    expect(result.success).toBe(true);
    expect(result.ledger.audience).toEqual({ id: 'aud-mock-1', name: 'Mock Audience', created: true, subtype: 'CUSTOM' });
  });
});
