/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/
 * htmlTools/leads/brandMarketStrategy/mediaVideo/htmlCreation/htmlUpdate/
 * knowledgeBase/blog/workPlans/tasks.moduleIsolation.test.ts.
 *
 * None of this series' four originally-named transitive traps
 * (`chatbotService.ts`, `settingsService.ts`, `orgProfileResolver.ts`,
 * `brandGuidelinesPopulation.ts`) are referenced anywhere in this cluster, so
 * there is nothing to prove about them here.
 *
 * `services/db.ts` was checked too, but NOT for the usual "stays lazy"
 * property every other DB-touching cluster in this series could prove:
 * `linkedInOutreachService.ts` (a static, module-scope import here — used by
 * listConnectedAccounts, and confirmed NOT to import agentModeService.ts
 * back) itself statically imports `services/db.ts`. That was already true of
 * `agentModeService.ts` before this extraction (it already had a static,
 * top-level `import { linkedInOutreachService } from
 * './linkedInOutreachService'`, used by the out-of-scope LinkedIn-posting
 * methods too) — so this module transitively loading `services/db.ts` at
 * require time is inherited, pre-existing behavior, not a new regression or
 * a new circular-import risk (`services/db.ts` does not import
 * `agentModeService.ts`). An earlier version of this test incorrectly
 * asserted `services/db.ts` never loads at module scope here; that assertion
 * was wrong and has been removed rather than "fixed" by weakening the mock,
 * since the transitive load is real and expected.
 */

describe('emma/impl/socialAccounts.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/socialAccounts.ts');
      });
      expect(() => require('../socialAccounts')).not.toThrow();
    });
  });
});
