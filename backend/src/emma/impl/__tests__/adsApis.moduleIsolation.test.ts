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
  });
});
