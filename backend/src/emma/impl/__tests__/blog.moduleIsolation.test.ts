/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/
 * htmlTools/leads/brandMarketStrategy/mediaVideo/htmlCreation/htmlUpdate/
 * knowledgeBase.moduleIsolation.test.ts.
 *
 * `services/blogPublishers.ts` is a NEW transitive-import trap found and
 * fixed during this extraction (not a problem in the original file, which
 * could afford a static import because everything already lived in one
 * file): it statically imports `controllers/blog.ts` (for
 * `getWebflowConfig`/`getWordPressConfig`), and `controllers/blog.ts` itself
 * has a static `import { agentModeService } from '../services/agentModeService'`
 * at its own top. A static top-level import of blogPublishers.ts here would
 * therefore transitively load agentModeService.ts on every import of this
 * module — proven below to NOT happen, since `publishBlogArticle` only ever
 * reaches it via a lazy `await import(...)` inside its own function body.
 *
 * `controllers/blog.ts` (used by createBlogArticle for
 * generateBlogContent/generateBlogHtml/generateBlogImage/restyleContent) and
 * `services/deepResearchService.ts` (createBlogArticle's deep-research
 * branch) were both ALREADY lazily imported in the original class method —
 * preserved that way here, and independently worth guarding since
 * `deepResearchService.ts` itself has a static
 * `import { agentModeService } from './agentModeService'` at its own top, the
 * same shape of hazard as blogPublishers.ts above.
 */

describe('emma/impl/blog.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/blogPublishers');
    jest.dontMock('../../../controllers/blog');
    jest.dontMock('../../../services/deepResearchService');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/blog.ts');
      });
      expect(() => require('../blog')).not.toThrow();
    });
  });

  it('does not import services/blogPublishers.ts at module scope (the transitive agentModeService.ts trap)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/blogPublishers', () => {
        throw new Error('services/blogPublishers.ts must be lazily required inside publishBlogArticle, not loaded at module scope');
      });
      expect(() => require('../blog')).not.toThrow();
    });
  });

  it('does not import controllers/blog.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../controllers/blog', () => {
        throw new Error('controllers/blog.ts must be lazily required inside createBlogArticle, not loaded at module scope');
      });
      expect(() => require('../blog')).not.toThrow();
    });
  });

  it('does not import services/deepResearchService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/deepResearchService', () => {
        throw new Error('services/deepResearchService.ts must be lazily required inside createBlogArticle, not loaded at module scope');
      });
      expect(() => require('../blog')).not.toThrow();
    });
  });
});
