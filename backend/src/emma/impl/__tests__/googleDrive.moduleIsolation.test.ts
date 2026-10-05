/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books.moduleIsolation.test.ts / gtmPlans.moduleIsolation.test.ts.
 *
 * emma/impl/googleDrive.ts pulls in two shared modules
 * (emma/impl/shared/googleDriveAccess.ts, emma/impl/shared/googleDriveErrors.ts)
 * and, transitively, emma/impl/shared/pdfTextRender.ts. None of these may
 * import agentModeService.ts, and none may eagerly construct an AWS/Google
 * client at module scope — every real dependency (googleapis,
 * utils/secretsManager, services/connectedAccountsDb, config/integrations,
 * google-auth-library) is lazily loaded inside the function body that needs it.
 */

describe('emma/impl/googleDrive.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../utils/secretsManager');
    jest.dontMock('../../../services/connectedAccountsDb');
    jest.dontMock('../../../config/integrations');
    jest.dontMock('googleapis');
    jest.dontMock('google-auth-library');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/googleDrive.ts');
      });
      expect(() => require('../googleDrive')).not.toThrow();
    });
  });

  it('does not construct a Google/AWS client at module scope (googleapis, secretsManager, connectedAccountsDb, config/integrations, google-auth-library all stay lazy)', () => {
    jest.isolateModules(() => {
      jest.doMock('googleapis', () => {
        throw new Error('googleapis must be lazily imported, not loaded at module scope');
      });
      jest.doMock('google-auth-library', () => {
        throw new Error('google-auth-library must be lazily imported, not loaded at module scope');
      });
      jest.doMock('../../../utils/secretsManager', () => {
        throw new Error('secretsManager must be lazily imported, not loaded at module scope');
      });
      jest.doMock('../../../services/connectedAccountsDb', () => {
        throw new Error('connectedAccountsDb must be lazily imported, not loaded at module scope');
      });
      jest.doMock('../../../config/integrations', () => {
        throw new Error('config/integrations must be lazily imported, not loaded at module scope');
      });
      expect(() => require('../googleDrive')).not.toThrow();
    });
  });
});
