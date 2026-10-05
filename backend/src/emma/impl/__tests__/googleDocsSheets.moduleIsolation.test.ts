/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive.moduleIsolation.test.ts.
 *
 * emma/impl/googleDocsSheets.ts pulls in emma/impl/shared/htmlEscaping.ts (pure,
 * no lazy deps needed) and emma/impl/shared/googleDriveAccess.ts /
 * googleDriveErrors.ts (already proven standalone by the Google Drive round's
 * own moduleIsolation test). This file only needs to prove ITS OWN module
 * scope doesn't import agentModeService.ts or eagerly construct `googleapis`
 * (its own direct dependency, lazily loaded inside each tool function).
 */

describe('emma/impl/googleDocsSheets.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('googleapis');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/googleDocsSheets.ts');
      });
      expect(() => require('../googleDocsSheets')).not.toThrow();
    });
  });

  it('does not construct a Google client at module scope (googleapis stays lazy)', () => {
    jest.isolateModules(() => {
      jest.doMock('googleapis', () => {
        throw new Error('googleapis must be lazily imported, not loaded at module scope');
      });
      expect(() => require('../googleDocsSheets')).not.toThrow();
    });
  });
});
