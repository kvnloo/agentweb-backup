/**
 * ENG-2103 F2 — video tools cluster (cluster 21). Same rationale as every
 * prior *.moduleIsolation.test.ts in this series: prove something real about
 * the extraction, not just that the code moved.
 *
 * `video.ts` lazy-`require`s `settingsService` inside `getVideoApiDefaultModel`
 * (settingsService.ts constructs a real AWS.DynamoDB.DocumentClient at module
 * load) — asserted here, same idiom as `books.ts`/`gtmPlans.ts`. It has no
 * other DB/AWS-backed dependency: `describeVideo`'s Gemini client comes from a
 * lazy `await import('../../utils/llmClients')`, unchanged from the original
 * code, so that's not a NEW lazy-load point this extraction introduced.
 */

describe('emma/impl/video.ts loads standalone', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../../services/agentModeService');
    jest.dontMock('../../../services/chatbotService');
    jest.dontMock('../../../services/settingsService');
  });

  it('does not import agentModeService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/agentModeService', () => {
        throw new Error('agentModeService.ts must not be imported at module scope by emma/impl/video.ts');
      });
      expect(() => require('../video')).not.toThrow();
    });
  });

  it('does not import chatbotService.ts at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/chatbotService', () => {
        throw new Error('chatbotService.ts must not be imported at module scope by emma/impl/video.ts');
      });
      expect(() => require('../video')).not.toThrow();
    });
  });

  it('does not construct settingsService (an AWS client) at module scope', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../services/settingsService', () => {
        throw new Error('settingsService must be lazily required, not loaded at module scope');
      });
      expect(() => require('../video')).not.toThrow();
    });
  });

  it('exposes the cluster entry points', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const video = require('../video');
    expect(typeof video.getVideoApiDefaultModel).toBe('function');
    expect(typeof video.describeVideo).toBe('function');
    expect(typeof video.parseTimecodeToSeconds).toBe('function');
  });

  it('does NOT export waitForGeminiFileActive as part of its public surface', () => {
    // waitForGeminiFileActive was public on AgentModeService but had exactly
    // one caller (describeVideo, in this same cluster) — confirmed by
    // whole-backend grep — demoted to a non-exported module-internal function.
    const video = require('../video');
    expect(video.waitForGeminiFileActive).toBeUndefined();
  });
});
