/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/
 * htmlTools/leads/brandMarketStrategy/mediaVideo.moduleIsolation.test.ts.
 *
 * This is the cleanest cluster yet on the transitive-import axis: every
 * dependency this module top-level-imports (crypto's randomUUID,
 * utils/templateParser.ts, utils/agentModeErrors.ts, and the ENG-2103-round-1
 * shared emma/impl/shared/toolUsageMetering.ts) has zero imports of its own
 * (or only type-only ones), so none of them needed new lazy treatment —
 * unlike every prior round, which each found at least one real
 * transitive-import-trap dependency to fix. `services/db.ts`,
 * `orgShareService.ts`, and `settingsService.ts` (which DOES top-level-import
 * aws-sdk) were already lazily `await import()`'d inline in the original
 * source for createHtmlTemplate — kept exactly as-is, so this test still
 * asserts they stay lazy.
 */

describe('emma/impl/htmlCreation.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/settingsService');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/htmlCreation.ts');
      });
      expect(() => require('../htmlCreation')).not.toThrow();
    });
  });

  it('does not eagerly require settingsService.ts at module scope (it top-level-imports aws-sdk; createHtmlTemplate already required it lazily in the original source)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/settingsService', () => {
        throw new Error('settingsService must be lazily required inside createHtmlTemplate, not loaded at module scope');
      });
      expect(() => require('../htmlCreation')).not.toThrow();
    });
  });
});
