/**
 * ENG-2840 (W2-1) — same rationale as leads/books/gtmPlans/htmlTools .moduleIsolation.test.ts.
 *
 * emma/impl/memory.ts reaches `services/db` (which builds a DynamoDB client at module scope) and `utils/embeddings` (which pulls in the
 * LLM clients) only through `await import(...)` inside its function bodies. Its static imports are `utils/memoryCategories` (no
 * imports), `utils/memoryContentLimit` (no imports) and `services/orgAuthz` (a type-only import of the db module).
 */

describe('emma/impl/memory.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/db');
    jest.dontMock('../../../utils/embeddings');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/memory.ts');
      });
      expect(() => require('../memory')).not.toThrow();
    });
  });

  it('does not construct a DynamoDB client at module scope (services/db stays lazy)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/db', () => {
        throw new Error('services/db must be lazily required inside each function body, not loaded at module scope');
      });
      expect(() => require('../memory')).not.toThrow();
    });
  });

  it('does not load the embedding and LLM clients at module scope (utils/embeddings stays lazy)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../utils/embeddings', () => {
        throw new Error('utils/embeddings must be lazily required inside the save path, not loaded at module scope');
      });
      expect(() => require('../memory')).not.toThrow();
    });
  });
});
