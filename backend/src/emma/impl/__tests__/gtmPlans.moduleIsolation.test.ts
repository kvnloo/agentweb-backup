/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books.moduleIsolation.test.ts (see that file for the
 * full write-up): F1's transitive-import lesson
 * (lesson-lazy-require-aws-sdk-modules) was caught only by a broad test run, not
 * by tsc or a self-selected test subset, so this asserts the "does not import
 * agentModeService.ts" property directly instead of relying on a future author
 * noticing.
 *
 * gtmPlans.ts has two lazy-load points beyond the ones books.ts already proved
 * (bookDb/bookContentDb/settingsService): `chatbotService` (createGTMPlan) and,
 * again, `settingsService` (getGTMCommonItems) — both asserted here.
 */

describe('emma/impl/gtmPlans.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/settingsService');
    jest.dontMock('../../../services/chatbotService');
    jest.dontMock('../../../services/db');
    jest.dontMock('../../../services/gtmPlanNotificationService');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/gtmPlans.ts');
      });
      expect(() => require('../gtmPlans')).not.toThrow();
    });
  });

  it('does not construct settingsService/chatbotService/db/gtmPlanNotificationService (AWS clients) at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/settingsService', () => {
        throw new Error('settingsService must be lazily required, not loaded at module scope');
      });
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('chatbotService must be lazily required, not loaded at module scope');
      });
      jest.doMock('../../../services/db', () => {
        throw new Error('db must be lazily imported, not loaded at module scope');
      });
      jest.doMock('../../../services/gtmPlanNotificationService', () => {
        throw new Error('gtmPlanNotificationService must be lazily imported, not loaded at module scope');
      });
      expect(() => require('../gtmPlans')).not.toThrow();
    });
  });
});
