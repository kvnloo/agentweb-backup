/**
 * ENG-2103 F2 — proves the point of the extraction, not just that the code
 * moved. Same rationale as books/gtmPlans/googleDrive/googleDocsSheets/
 * htmlTools/leads/brandMarketStrategy.moduleIsolation.test.ts.
 *
 * This cluster's own distinguishing finding: `chatbotDb` (used by
 * generateVideo/generateImage for session cost/message bookkeeping) was a
 * TOP-LEVEL import in agentModeService.ts, but chatbotService.ts itself
 * top-level-imports aws-sdk (constructs a real client at module scope) — the
 * same transitive-import trap round 2's createGTMPlan hit with
 * chatbotDb.getChatSession. It is lazily `await import()`'d inside
 * generateVideo/generateImage instead — this test proves that lazy treatment
 * actually holds.
 *
 * ENG-2103 (F2 design-decision-list follow-up, Pattern A): describeImage and
 * generateImage moved here too. `enqueueAutoHumanEval`
 * (services/autoHumanEvalService.ts, used by generateImage) statically
 * imports settingsService.ts, which constructs a real
 * AWS.DynamoDB.DocumentClient at module scope (unconditionally, not behind a
 * lazy guard) — a NEW instance of the same established transitive-import
 * trap, lazily `await import()`'d inside generateImage instead of a
 * top-level import.
 */

describe('emma/impl/mediaVideo.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/chatbotService');
    jest.dontMock('../../../services/settingsService');
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
        throw new Error('chatbotService must be lazily required inside generateVideo/generateImage, not loaded at module scope');
      });
      expect(() => require('../mediaVideo')).not.toThrow();
    });
  });

  it('does not construct settingsService (an AWS client) at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/settingsService', () => {
        throw new Error('settingsService must be lazily required (via autoHumanEvalService inside generateImage), not loaded at module scope');
      });
      expect(() => require('../mediaVideo')).not.toThrow();
    });
  });

  it('exposes the describeImage/generateImage cluster entry points', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mediaVideo = require('../mediaVideo');
    expect(typeof mediaVideo.describeImage).toBe('function');
    expect(typeof mediaVideo.generateImage).toBe('function');
    expect(typeof mediaVideo.resolveDescribeImageTimeoutMs).toBe('function');
    expect(typeof mediaVideo.normalizeImageForVision).toBe('function');
    expect(typeof mediaVideo.estimateImageGenerationCost).toBe('function');
    expect(typeof mediaVideo.getImageGenerationFallbackModel).toBe('function');
  });

  it('does NOT export callVisionLLMWithTimeout as part of its public surface', () => {
    // Private helper, confirmed by whole-backend grep to have exactly one
    // caller (describeImage, in this same module) despite living on the
    // class previously.
    const mediaVideo = require('../mediaVideo');
    expect(mediaVideo.callVisionLLMWithTimeout).toBeUndefined();
  });

  it('does NOT export isRetryableMediaToolError as part of its public surface', () => {
    // Exclusive to generateImage, zero test dependency beyond doc comments —
    // deleted from the class outright rather than kept as a wrapper.
    const mediaVideo = require('../mediaVideo');
    expect(mediaVideo.isRetryableMediaToolError).toBeUndefined();
  });
});
