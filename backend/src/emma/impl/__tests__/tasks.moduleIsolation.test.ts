/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/
 * htmlTools/leads/brandMarketStrategy/mediaVideo/htmlCreation/htmlUpdate/
 * knowledgeBase/blog/workPlans.moduleIsolation.test.ts.
 *
 * `chatbotService.ts` is the known transitive trap (ENG-1816 F1's
 * `lesson-lazy-require-aws-sdk-modules`): it top-level-imports
 * `agentModeService.ts` back (circular) and constructs a real
 * `AWS.DynamoDB.DocumentClient` at module load. Only `getPreviousTaskResults`
 * uses `chatbotDb`, and it lazy-`require`s it at the top of its own function
 * body rather than importing it at module scope — proven below to NOT
 * happen.
 *
 * `services/db.ts` is NOT one of the four transitive traps this series'
 * brief names explicitly, but it constructs a real
 * `AWS.DynamoDB.DocumentClient()` at its own module scope (line 56) — the
 * same risk shape. Every method in this cluster uses `taskDb`/
 * `taskTemplateDb`, so each one lazily `await import('../../services/db')`s
 * it at the top of its own function body, matching the idiom every
 * DB-touching cluster before this one already established (leads, gtmPlans,
 * knowledgeBase, brandMarketStrategy, htmlCreation) — proven below to NOT be
 * imported at module scope either.
 */

describe('emma/impl/tasks.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/chatbotService');
    jest.dontMock('../../../services/db');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/tasks.ts');
      });
      expect(() => require('../tasks')).not.toThrow();
    });
  });

  it('does not import services/chatbotService.ts at module scope (the transitive agentModeService.ts trap)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('services/chatbotService.ts must be lazily required inside getPreviousTaskResults, not loaded at module scope');
      });
      expect(() => require('../tasks')).not.toThrow();
    });
  });

  it('does not import services/db.ts at module scope (constructs a real AWS.DynamoDB.DocumentClient at load)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/db', () => {
        throw new Error('services/db.ts must be lazily imported inside each function body, not loaded at module scope');
      });
      expect(() => require('../tasks')).not.toThrow();
    });
  });
});
