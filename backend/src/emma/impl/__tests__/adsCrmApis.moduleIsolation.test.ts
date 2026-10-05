/**
 * ENG-2103 F2 — Google Ads + HubSpot/Attio CRM passthrough APIs cluster
 * (cluster 19). Same rationale as every prior *.moduleIsolation.test.ts in
 * this series: prove something real about the extraction, not just that the
 * code moved.
 *
 * Unlike cluster 18's adsApis.ts (which DOES transitively load
 * agentModeService.ts via a static `metaLaunchGate.ts` import), this module
 * lazily `require()`s both `chatbotService.ts` (for `chatbotDb`, inside
 * `guardCreativeAddition`/`runGoogleAdsTrackingGate`) and `metaLaunchGate.ts`
 * (for `computeTrackingOverrideDigest`/`trackingOverrideTokenMatches`,
 * inside `handleCallGoogleAdsApi`) rather than importing them statically —
 * a deliberate choice, not inherited precedent, since this module had no
 * pre-existing reliance on either forcing it. So requiring `adsCrmApis.ts`
 * alone must NOT load `agentModeService.ts` or `chatbotService.ts` at all.
 *
 * It DOES transitively load `services/db.ts` (a real, unavoidable production
 * dependency: `googleAdsService.ts`/`hubspotService.ts`/`attioService.ts`
 * each import `connectedAccountsDb.ts`, which imports `./db` for `userDb`) —
 * this is not new: `agentModeService.ts` already statically imports both
 * `googleAdsService.ts` and `hubspotService.ts` today, so this DynamoDB-
 * client construction already happens on every load of the current file.
 * Not asserted against here since it isn't the trap this test guards.
 */

describe('emma/impl/adsCrmApis.ts transitive-import shape', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/chatbotService');
  });

  it('does NOT transitively load agentModeService.ts at require time', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts loaded');
      });
      expect(() => require('../adsCrmApis')).not.toThrow();
    });
  });

  it('does NOT transitively load chatbotService.ts at require time (chatbotDb is lazily required inside the two functions that use it)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('chatbotService.ts loaded');
      });
      expect(() => require('../adsCrmApis')).not.toThrow();
    });
  });

  it('does NOT transitively load metaLaunchGate.ts at require time (computeTrackingOverrideDigest/trackingOverrideTokenMatches are lazily required inside handleCallGoogleAdsApi)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/metaLaunchGate', () => {
        throw new Error('metaLaunchGate.ts loaded');
      });
      expect(() => require('../adsCrmApis')).not.toThrow();
    });
  });

  it('exposes the cluster entry points', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const adsCrmApis = require('../adsCrmApis');
    expect(typeof adsCrmApis.handleCallGoogleAdsApi).toBe('function');
    expect(typeof adsCrmApis.handleCallGoogleAdsReportingApi).toBe('function');
    expect(typeof adsCrmApis.resolveHubSpotService).toBe('function');
    expect(typeof adsCrmApis.handleHubspotApi).toBe('function');
    expect(typeof adsCrmApis.handleAttioApi).toBe('function');
  });
});
