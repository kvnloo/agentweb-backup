/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/
 * htmlTools/leads/brandMarketStrategy.moduleIsolation.test.ts.
 *
 * This cluster's own distinguishing finding: `chatbotDb` (used by
 * generateVideo for session cost/message bookkeeping) was a TOP-LEVEL import
 * in agentModeService.ts, but chatbotService.ts itself top-level-imports
 * aws-sdk (constructs a real client at module scope) — the same
 * transitive-import trap round 2's createGTMPlan hit with
 * chatbotDb.getChatSession. It is lazily `await import()`'d inside
 * generateVideo instead — this test proves that lazy treatment actually
 * holds.
 */

describe('emma/impl/mediaVideo.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/chatbotService');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/mediaVideo.ts');
      });
      expect(() => require('../mediaVideo')).not.toThrow();
    });
  });

  it('does not eagerly require chatbotService.ts at module scope (it top-level-imports aws-sdk)', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('chatbotService must be lazily required inside generateVideo, not loaded at module scope');
      });
      expect(() => require('../mediaVideo')).not.toThrow();
    });
  });
});
