/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets.moduleIsolation.test.ts.
 *
 * emma/impl/htmlTools.ts pulls in emma/impl/shared/htmlTemplates.ts (lazy
 * settingsService), services/agentMode/brandLogo.ts (already
 * lazy/injectable by its own design), and services/cssExtractor.ts (already
 * lazy-`require`'d inside the function body, matching the original code).
 * `../utils/s3Utils` and `../../services/pdfRenderService` are imported at
 * the top level deliberately (see htmlTools.ts's own doc comment on why that
 * is the established codebase convention, not a lazy-load gap) — so this test
 * only asserts the one property that actually matters: no accidental pull-in
 * of agentModeService.ts itself.
 */

describe('emma/impl/htmlTools.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/settingsService');
    jest.dontMock('../../../services/cssExtractor');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/htmlTools.ts');
      });
      expect(() => require('../htmlTools')).not.toThrow();
    });
  });

  it('does not construct an AWS DynamoDB client at module scope (settingsService, reached transitively via emma/impl/shared/htmlTemplates.ts, stays lazy)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/settingsService', () => {
        throw new Error('settingsService must be lazily required, not loaded at module scope');
      });
      expect(() => require('../htmlTools')).not.toThrow();
    });
  });

  it('does not eagerly require cssExtractor at module scope (it is require()d inside extractCSSFromURL)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/cssExtractor', () => {
        throw new Error('cssExtractor must be lazily required, not loaded at module scope');
      });
      expect(() => require('../htmlTools')).not.toThrow();
    });
  });
});
