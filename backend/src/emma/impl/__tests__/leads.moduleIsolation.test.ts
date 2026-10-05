/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/htmlTools
 * .moduleIsolation.test.ts.
 *
 * emma/impl/leads.ts is the cleanest cluster yet on this axis: `services/db`
 * (the module that constructs a real DynamoDB client at module scope — the
 * transitive-import trap this whole series of tests exists to catch) is
 * ALWAYS reached via `await import('../../services/db')` inside each
 * function body, never imported at the top of the file. Its five top-level
 * static imports (`utils/leadSchema`, `services/crmSenderTypes`,
 * `utils/customFieldsGuard`, `services/agentMode/leadRecovery`,
 * `emma/impl/shared/crmSenders`) are each, in turn, either import-free or
 * only pull in narrow type-only modules — none of them touch
 * agentModeService.ts or services/db themselves.
 */

describe('emma/impl/leads.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/db');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/leads.ts');
      });
      expect(() => require('../leads')).not.toThrow();
    });
  });

  it('does not construct a DynamoDB client at module scope (services/db stays lazy, required inside each function body)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/db', () => {
        throw new Error('services/db must be lazily required inside each function body, not loaded at module scope');
      });
      expect(() => require('../leads')).not.toThrow();
    });
  });
});
