/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/
 * htmlTools/leads.moduleIsolation.test.ts.
 *
 * This cluster's own distinguishing finding: `resolveOrgProfileField` and
 * `populateEmptyBrandGuidelines` were TOP-LEVEL imports in
 * agentModeService.ts, but orgProfileResolver.ts and
 * brandGuidelinesPopulation.ts each top-level-import services/db.ts (the
 * module that constructs a real DynamoDB client at module scope — the
 * transitive-import trap this whole series watches for). A top-level import
 * of either here would have silently reintroduced exactly the coupling this
 * extraction exists to remove, so both are lazily `await import()`'d inside
 * the function bodies that use them instead — this test proves that lazy
 * treatment actually holds.
 */

describe('emma/impl/brandMarketStrategy.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/db');
    jest.dontMock('../../../services/orgProfileResolver');
    jest.dontMock('../../../services/brandGuidelinesPopulation');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/brandMarketStrategy.ts');
      });
      expect(() => require('../brandMarketStrategy')).not.toThrow();
    });
  });

  it('does not construct a DynamoDB client at module scope (services/db stays lazy, required inside each function body)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/db', () => {
        throw new Error('services/db must be lazily required inside each function body, not loaded at module scope');
      });
      expect(() => require('../brandMarketStrategy')).not.toThrow();
    });
  });

  it('does not eagerly require orgProfileResolver.ts at module scope (it top-level-imports services/db.ts itself)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/orgProfileResolver', () => {
        throw new Error('orgProfileResolver must be lazily required inside each function body, not loaded at module scope');
      });
      expect(() => require('../brandMarketStrategy')).not.toThrow();
    });
  });

  it('does not eagerly require brandGuidelinesPopulation.ts at module scope (it top-level-imports services/db.ts itself)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/brandGuidelinesPopulation', () => {
        throw new Error('brandGuidelinesPopulation must be lazily required inside updateMarketStrategy, not loaded at module scope');
      });
      expect(() => require('../brandMarketStrategy')).not.toThrow();
    });
  });
});
