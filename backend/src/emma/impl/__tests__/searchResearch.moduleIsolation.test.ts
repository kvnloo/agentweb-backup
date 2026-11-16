/**
 * ENG-2103 F2 — search & research tool cluster (cluster 20). Same rationale
 * as every prior *.moduleIsolation.test.ts in this series: prove something
 * real about the extraction, not just that the code moved.
 *
 * The one real transitive-import trap in this cluster is `deepResearchService.ts`,
 * reached only from `performDeepResearchTool` via a LAZY `await import(...)`
 * (unchanged from the original code — this module doesn't lazy-require it,
 * the original method body already imported it dynamically). `deepResearchService.ts`
 * itself has a STATIC `import { agentModeService } from './agentModeService'`
 * at its own top, so requiring `searchResearch.ts` alone must NOT load either
 * `deepResearchService.ts` or `agentModeService.ts` — the lazy import means
 * neither is pulled in until `performDeepResearchTool` actually runs.
 *
 * Everything else this module imports (YouSearchProvider,
 * csvProvenance, searchFreshness/searchProvider, secretsManager, s3Utils,
 * llmClients) is a static import, exactly matching how `agentModeService.ts`
 * already imported every one of them, and none of those modules reaches
 * `chatbotService.ts` either — asserted here too since it is one of the four
 * standing named traps for this series.
 */

describe('emma/impl/searchResearch.ts transitive-import shape', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/chatbotService');
    jest.dontMock('../../../services/deepResearchService');
  });

  it('does NOT transitively load agentModeService.ts at require time', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts loaded');
      });
      expect(() => require('../searchResearch')).not.toThrow();
    });
  });

  it('does NOT transitively load chatbotService.ts at require time', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('chatbotService.ts loaded');
      });
      expect(() => require('../searchResearch')).not.toThrow();
    });
  });

  it('does NOT transitively load deepResearchService.ts at require time (it is only reached via a lazy await import() inside performDeepResearchTool, unchanged from the original code)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/deepResearchService', () => {
        throw new Error('deepResearchService.ts loaded');
      });
      expect(() => require('../searchResearch')).not.toThrow();
    });
  });

  it('exposes the cluster entry points', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const searchResearch = require('../searchResearch');
    expect(typeof searchResearch.performDataAnalysis).toBe('function');
    expect(typeof searchResearch.youSearchWeb).toBe('function');
    expect(typeof searchResearch.youSearchNews).toBe('function');
    expect(typeof searchResearch.googleSearchWeb).toBe('function');
    expect(typeof searchResearch.performDeepResearchTool).toBe('function');
  });

  it('does NOT export the module-internal helpers as part of its public surface', () => {
    // performYouSearch/performGoogleSearch were public on AgentModeService but
    // had zero callers beyond this cluster (confirmed by whole-backend grep) —
    // demoted to non-exported module-internal functions here.
    const searchResearch = require('../searchResearch');
    expect(searchResearch.performYouSearch).toBeUndefined();
    expect(searchResearch.performGoogleSearch).toBeUndefined();
    expect(searchResearch.searchWithYou).toBeUndefined();
    expect(searchResearch.formatWebSearchResults).toBeUndefined();
    expect(searchResearch.isRetryableSearchError).toBeUndefined();
  });
});
