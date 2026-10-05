/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/
 * htmlTools/leads/brandMarketStrategy/mediaVideo/htmlCreation/htmlUpdate
 * .moduleIsolation.test.ts.
 *
 * `services/chatbotService.ts` is the KNOWN trap named in this round's brief:
 * it constructs a real AWS DynamoDB client AND has a circular import back to
 * agentModeService.ts. It is reached only via a lazy `await import(...)`
 * inside searchKnowledgeBase, never a static top-level import — proven below.
 * Likewise `services/orgShareService.ts` and `utils/s3Utils.ts` are only ever
 * lazily `await import()`'d (inside listKnowledgeBaseFiles/
 * readSingleKnowledgeBaseFile and materializeKnowledgeBaseAsset
 * respectively).
 *
 * `services/db.ts` and `utils/secretsManager.ts` do NOT get the same
 * isolation guarantee here, and that is a deliberate, typechecked finding,
 * not an oversight: `services/clickupService.ts` (statically imported, used
 * by the ClickUp readers) itself statically imports `services/db.ts`, and
 * `services/foreplayService.ts` (also static, used by the Foreplay readers)
 * statically imports `utils/secretsManager.ts` — both already construct real
 * AWS clients at module scope on their OWN account, independent of anything
 * this cluster's functions do. Requiring emma/impl/knowledgeBase.ts therefore
 * transitively loads both regardless of this module's own (correctly lazy)
 * `await import('../../services/db')` / `await import('../../utils/secretsManager')`
 * call sites — a real difference from `services/chatbotService.ts`, which
 * carries an actual circular-import hazard back to agentModeService.ts that
 * neither clickupService.ts nor foreplayService.ts has.
 */

describe('emma/impl/knowledgeBase.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/chatbotService');
    jest.dontMock('../../../services/orgShareService');
    jest.dontMock('../../../utils/s3Utils');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/knowledgeBase.ts');
      });
      expect(() => require('../knowledgeBase')).not.toThrow();
    });
  });

  it('does not import chatbotService.ts at module scope (the known circular-import/AWS-client trap)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('chatbotService.ts must be lazily required inside searchKnowledgeBase, not loaded at module scope');
      });
      expect(() => require('../knowledgeBase')).not.toThrow();
    });
  });

  it('does not import services/orgShareService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/orgShareService', () => {
        throw new Error('services/orgShareService.ts must be lazily required, not loaded at module scope');
      });
      expect(() => require('../knowledgeBase')).not.toThrow();
    });
  });

  it('does not import utils/s3Utils.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../utils/s3Utils', () => {
        throw new Error('utils/s3Utils.ts must be lazily required inside materializeKnowledgeBaseAsset, not loaded at module scope');
      });
      expect(() => require('../knowledgeBase')).not.toThrow();
    });
  });
});
