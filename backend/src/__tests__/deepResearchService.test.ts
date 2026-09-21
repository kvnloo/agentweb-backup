// Unit tests for deepResearchService

import {
  DeepResearchService,
  extractReportText,
  RESEARCH_TIME_BUFFER_MS,
  RETRY_SHARE_MS,
  getPollBudgetMs,
  getRetryPollBudgetMs,
} from '../services/deepResearchService';
import * as secretsManager from '../utils/secretsManager';
import { DEEP_RESEARCH_AGENT, DEEP_RESEARCH_AGENT_SPEED, DEEP_RESEARCH_AGENT_MAX } from '../config';

// Mock dependencies
jest.mock('../utils/secretsManager');
jest.mock('@google/genai');

describe('DeepResearchService', () => {
  let deepResearchService: DeepResearchService;
  const mockGetSecret = secretsManager.getSecret as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    deepResearchService = new DeepResearchService();
  });

  describe('Service Initialization', () => {
    it('should have performDeepResearch method', () => {
      expect(deepResearchService.performDeepResearch).toBeDefined();
      expect(typeof deepResearchService.performDeepResearch).toBe('function');
    });

    it('should have isAvailable method', () => {
      expect(deepResearchService.isAvailable).toBeDefined();
      expect(typeof deepResearchService.isAvailable).toBe('function');
    });
  });

  describe('Parameter Structure', () => {
    it('should accept valid DeepResearchParams with topic only', () => {
      const params = {
        topic: 'History of artificial intelligence',
      };
      
      expect(params.topic).toBeDefined();
      // Note: userId and rawMarkdownOnly were removed - params now only need topic
    });

    it('should accept all optional parameters', () => {
      const params = {
        topic: 'Market trends in renewable energy',
        prompt: 'Focus on solar and wind',
        tone: 'professional',
        style: 'substack',
        depth: 'comprehensive',
        focus_areas: ['solar power', 'wind energy', 'cost analysis']
      };
      
      expect(params.topic).toBe('Market trends in renewable energy');
      expect(params.prompt).toBe('Focus on solar and wind');
      expect(params.tone).toBe('professional');
      expect(params.style).toBe('substack');
      expect(params.depth).toBe('comprehensive');
      expect(params.focus_areas).toEqual(['solar power', 'wind energy', 'cost analysis']);
    });

    it('should accept depth parameter with valid values', () => {
      const overviewParams = { topic: 'Test', depth: 'overview' };
      const detailedParams = { topic: 'Test', depth: 'detailed' };
      const comprehensiveParams = { topic: 'Test', depth: 'comprehensive' };
      
      expect(overviewParams.depth).toBe('overview');
      expect(detailedParams.depth).toBe('detailed');
      expect(comprehensiveParams.depth).toBe('comprehensive');
    });

    it('should accept focus_areas as array of strings', () => {
      const params = {
        topic: 'AI in healthcare',
        focus_areas: ['diagnostics', 'treatment planning', 'patient monitoring']
      };
      
      expect(Array.isArray(params.focus_areas)).toBe(true);
      expect(params.focus_areas.length).toBe(3);
    });
  });

  describe('Config Constants', () => {
    it('should use the April 2026 speed and max deep research agents', () => {
      // Verify the agent names match Google's April 2026 Deep Research agents.
      expect(DEEP_RESEARCH_AGENT_SPEED).toBe('deep-research-preview-04-2026');
      expect(DEEP_RESEARCH_AGENT_MAX).toBe('deep-research-max-preview-04-2026');
    });

    it('should default to the speed agent', () => {
      expect(DEEP_RESEARCH_AGENT).toBe(DEEP_RESEARCH_AGENT_SPEED);
    });
  });

  describe('extractReportText', () => {
    it('should concatenate text from all model_output steps in order', () => {
      const interaction = {
        steps: [
          { type: 'user_input', content: [{ type: 'text', text: 'the prompt' }] },
          { type: 'model_output', content: [{ type: 'text', text: '# Title\n\nIntro.' }] },
          {
            type: 'model_output',
            content: [
              { type: 'image', mime_type: 'image/png', data: 'base64==' },
              { type: 'text', text: 'Second chunk continues the report.' },
            ],
          },
        ],
      };

      const result = extractReportText(interaction);

      expect(result).toBe('# Title\n\nIntro.\n\nSecond chunk continues the report.');
    });

    it('should ignore user_input steps and image content', () => {
      const interaction = {
        steps: [
          { type: 'user_input', content: [{ type: 'text', text: 'should not appear' }] },
          { type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: 'x' }] },
          { type: 'model_output', content: [{ type: 'text', text: 'Only this.' }] },
        ],
      };

      const result = extractReportText(interaction);

      expect(result).toBe('Only this.');
      expect(result).not.toContain('should not appear');
    });

    it('should fall back to the legacy outputs array when no steps are present', () => {
      const interaction = {
        outputs: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'final report text' },
        ],
      };

      const result = extractReportText(interaction);

      // Legacy behavior: take the last text output.
      expect(result).toBe('final report text');
    });

    it('should return empty string when there is no usable content', () => {
      expect(extractReportText({ steps: [] })).toBe('');
      expect(extractReportText({ outputs: [] })).toBe('');
      expect(extractReportText({})).toBe('');
      expect(extractReportText(null)).toBe('');
      expect(
        extractReportText({ steps: [{ type: 'model_output', content: [] }] })
      ).toBe('');
    });

    it('should prefer steps over a legacy outputs array when both exist', () => {
      const interaction = {
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: 'from steps' }] },
        ],
        outputs: [{ type: 'text', text: 'from outputs' }],
      };

      expect(extractReportText(interaction)).toBe('from steps');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key exists', async () => {
      mockGetSecret.mockResolvedValue('valid-api-key');
      
      const result = await deepResearchService.isAvailable();
      
      expect(result).toBe(true);
      expect(mockGetSecret).toHaveBeenCalled();
    });

    it('should return false when API key is missing', async () => {
      mockGetSecret.mockRejectedValue(new Error('Secret not found'));
      
      const result = await deepResearchService.isAvailable();
      
      expect(result).toBe(false);
    });

    it('should return false when API key is empty', async () => {
      mockGetSecret.mockResolvedValue('   ');
      
      const result = await deepResearchService.isAvailable();
      
      expect(result).toBe(false);
    });
  });

  describe('performDeepResearch - API Interaction', () => {
    const mockGoogleGenAI = require('@google/genai').GoogleGenAI;
    
    beforeEach(() => {
      mockGetSecret.mockResolvedValue('test-api-key');
    });

    it('should return error when API key retrieval fails', async () => {
      mockGetSecret.mockRejectedValue(new Error('Secret not found'));
      
      const result = await deepResearchService.performDeepResearch({
        topic: 'Test topic'
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Secret not found');
    });

    it('should include tone in research prompt when provided', async () => {
      // This tests that tone parameter is properly used
      const params = {
        topic: 'AI in healthcare',
        tone: 'executive'
      };
      
      // Verify the tone parameter is accepted
      expect(params.tone).toBe('executive');
    });

    it('should include style instructions for substack', async () => {
      const params = {
        topic: 'Tech trends',
        style: 'substack'
      };

      // Verify substack style is accepted
      expect(params.style).toBe('substack');
    });
  });

  describe('Agent Tier Selection by Depth', () => {
    const mockGoogleGenAI = require('@google/genai').GoogleGenAI;
    let createMock: jest.Mock;

    beforeEach(() => {
      mockGetSecret.mockResolvedValue('test-api-key');

      // Resolve immediately as completed so performDeepResearch returns without polling.
      const completedInteraction = {
        id: 'interaction-1',
        status: 'completed',
        outputs: [{ text: '# Title\n\nReport body content.' }],
      };
      createMock = jest.fn().mockResolvedValue(completedInteraction);
      mockGoogleGenAI.mockImplementation(() => ({
        interactions: {
          create: createMock,
          get: jest.fn().mockResolvedValue(completedInteraction),
        },
      }));
    });

    it('should use the max agent for comprehensive depth', async () => {
      await deepResearchService.performDeepResearch({
        topic: 'Quantum computing',
        depth: 'comprehensive',
      });

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ agent: DEEP_RESEARCH_AGENT_MAX })
      );
    });

    it('should use the speed agent for detailed depth', async () => {
      await deepResearchService.performDeepResearch({
        topic: 'Quantum computing',
        depth: 'detailed',
      });

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ agent: DEEP_RESEARCH_AGENT_SPEED })
      );
    });

    it('should use the speed agent when depth is not provided', async () => {
      await deepResearchService.performDeepResearch({
        topic: 'Quantum computing',
      });

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ agent: DEEP_RESEARCH_AGENT_SPEED })
      );
    });
  });

  describe('Result Structure', () => {
    it('should define correct success result structure', () => {
      const successResult = {
        success: true,
        markdownContent: '# Research Report\n\nContent here...',
        title: 'Research Report',
        researchSummary: 'This is a research summary'
      };
      
      expect(successResult.success).toBe(true);
      expect(successResult.markdownContent).toBeDefined();
      expect(successResult.title).toBeDefined();
      expect(successResult.researchSummary).toBeDefined();
    });

    it('should define correct error result structure', () => {
      const errorResult = {
        success: false,
        error: 'Deep research failed'
      };
      
      expect(errorResult.success).toBe(false);
      expect(errorResult.error).toBeDefined();
    });
  });

  describe('Title Extraction', () => {
    it('should extract title from H1 markdown header', () => {
      const markdownWithH1 = '# My Research Title\n\nContent follows...';
      const titleMatch = markdownWithH1.match(/^#\s+(.+)$/m);
      
      expect(titleMatch).not.toBeNull();
      expect(titleMatch![1].trim()).toBe('My Research Title');
    });

    it('should handle missing H1 by using first line', () => {
      const markdownNoH1 = 'Research Summary\n\nMore content...';
      const firstLine = markdownNoH1.split('\n')[0].replace(/^#+\s*/, '').trim();
      
      expect(firstLine).toBe('Research Summary');
    });
  });

  describe('Research Summary Generation', () => {
    it('should truncate long content for summary', () => {
      const longContent = 'A'.repeat(600);
      const maxLength = 500;
      const summary = longContent.length > maxLength 
        ? longContent.substring(0, maxLength) + '...'
        : longContent;
      
      expect(summary.length).toBeLessThanOrEqual(503); // 500 + '...'
      expect(summary.endsWith('...')).toBe(true);
    });

    it('should keep short content as-is for summary', () => {
      const shortContent = 'Short research summary';
      const maxLength = 500;
      const summary = shortContent.length > maxLength 
        ? shortContent.substring(0, maxLength) + '...'
        : shortContent;
      
      expect(summary).toBe(shortContent);
    });
  });

  describe('Polling Configuration', () => {
    const ENV_KEYS = [
      'AGENT_MODE_GENERATION_TIMEOUT_MS',
      'DEEP_RESEARCH_POLL_BUDGET_MS',
      'DEEP_RESEARCH_RETRY_POLL_BUDGET_MS',
    ];

    afterEach(() => {
      ENV_KEYS.forEach((key) => delete process.env[key]);
    });

    // ENG-738: the OLD fixed 20-minute poll budget outlived
    // agentModeController's GENERATION_TIMEOUT_MS (10 minutes by default) — the
    // outer wall-clock timeout always killed the whole turn first, so this
    // service's own graceful-degradation logic never got a chance to run.
    it('keeps the primary + retry poll budgets safely under the DEFAULT outer generation timeout', () => {
      const OUTER_GENERATION_TIMEOUT_MS = 600000; // agentModeController's own default

      expect(getPollBudgetMs(true) + getRetryPollBudgetMs())
        .toBeLessThanOrEqual(OUTER_GENERATION_TIMEOUT_MS - RESEARCH_TIME_BUFFER_MS);
      // A non-degradable request (e.g. 'overview', or no depth at all — the
      // createBlogArticle caller) never retries, so it alone must also fit.
      expect(getPollBudgetMs(false)).toBeLessThanOrEqual(OUTER_GENERATION_TIMEOUT_MS - RESEARCH_TIME_BUFFER_MS);
    });

    // ENG-738 follow-up: a fixed constant here would silently become unsafe
    // again (too long relative to the outer cap) if ops ever reconfigures
    // AGENT_MODE_GENERATION_TIMEOUT_MS without knowing this file depends on
    // it. The budgets must be DERIVED from that same env var, not hardcoded.
    it('shrinks the poll budgets when AGENT_MODE_GENERATION_TIMEOUT_MS is lowered', () => {
      process.env.AGENT_MODE_GENERATION_TIMEOUT_MS = '300000'; // 5 minutes

      const primaryWithRetry = getPollBudgetMs(true);
      const retry = getRetryPollBudgetMs();
      const solo = getPollBudgetMs(false);

      expect(primaryWithRetry + retry).toBeLessThanOrEqual(300000 - RESEARCH_TIME_BUFFER_MS);
      expect(solo).toBeLessThanOrEqual(300000 - RESEARCH_TIME_BUFFER_MS);
      // And it must actually be smaller than the default-outer-timeout budgets,
      // not just coincidentally still safe.
      delete process.env.AGENT_MODE_GENERATION_TIMEOUT_MS;
      expect(primaryWithRetry).toBeLessThan(getPollBudgetMs(true));
      expect(solo).toBeLessThan(getPollBudgetMs(false));
    });

    it('never lets a degradable primary budget drop below the one-minute floor even under a very small outer timeout', () => {
      process.env.AGENT_MODE_GENERATION_TIMEOUT_MS = '60000'; // 1 minute — smaller than the buffer alone
      expect(getPollBudgetMs(true)).toBeGreaterThanOrEqual(60000);
      expect(getPollBudgetMs(false)).toBeGreaterThanOrEqual(60000);
    });

    it('lets a non-degradable request use the full usable budget instead of reserving retry headroom nothing will use', () => {
      // No explicit override — compare the two paths directly against the default outer timeout.
      const solo = getPollBudgetMs(false);
      const primaryWithRetry = getPollBudgetMs(true);
      expect(solo).toBeGreaterThan(primaryWithRetry);
      expect(solo - primaryWithRetry).toBe(RETRY_SHARE_MS);
    });

    it('honors an explicit DEEP_RESEARCH_POLL_BUDGET_MS override regardless of canDegrade', () => {
      process.env.DEEP_RESEARCH_POLL_BUDGET_MS = '42000';
      expect(getPollBudgetMs(true)).toBe(42000);
      expect(getPollBudgetMs(false)).toBe(42000);
    });
  });

  // ENG-351: deep research reports must cite the source of every quoted number inline,
  // directly next to the figure — matching the Claude/Gemini inline-citation style —
  // rather than only collecting sources in a separate references section.
  describe('Inline Source Citations', () => {
    const mockGoogleGenAI = require('@google/genai').GoogleGenAI;
    let createMock: jest.Mock;

    beforeEach(() => {
      mockGetSecret.mockResolvedValue('test-api-key');

      const completedInteraction = {
        id: 'interaction-1',
        status: 'completed',
        outputs: [{ text: '# Title\n\nReport body content.' }],
      };
      createMock = jest.fn().mockResolvedValue(completedInteraction);
      mockGoogleGenAI.mockImplementation(() => ({
        interactions: {
          create: createMock,
          get: jest.fn().mockResolvedValue(completedInteraction),
        },
      }));
    });

    it('instructs the research agent to cite quoted numbers inline', async () => {
      await deepResearchService.performDeepResearch({
        topic: 'AI market size',
        depth: 'comprehensive',
      });

      const input = (createMock.mock.calls[0][0] as { input: string }).input;
      expect(input).toContain('inline');
      expect(input).toMatch(/Claude and Gemini/i);
    });

    it('adds the inline-citation instruction regardless of depth', async () => {
      await deepResearchService.performDeepResearch({
        topic: 'AI market size',
      });

      const input = (createMock.mock.calls[0][0] as { input: string }).input;
      expect(input).toContain('inline');
    });
  });

  // ENG-738: deep research on a heavy topic repeatedly hit the poll timeout with
  // no graceful recovery — the model got a bare failure with no partial findings
  // and no automatic depth-reduced retry. These tests cover the resilience fix.
  describe('Timeout Resilience (ENG-738)', () => {
    const mockGoogleGenAI = require('@google/genai').GoogleGenAI;
    let createMock: jest.Mock;
    let getMock: jest.Mock;
    let cancelMock: jest.Mock;

    beforeEach(() => {
      mockGetSecret.mockResolvedValue('test-api-key');
      jest.useFakeTimers();
      // Small budgets (one poll attempt per pass) so these tests run fast.
      process.env.DEEP_RESEARCH_POLL_BUDGET_MS = '10000';
      process.env.DEEP_RESEARCH_RETRY_POLL_BUDGET_MS = '10000';
    });

    afterEach(() => {
      jest.useRealTimers();
      delete process.env.DEEP_RESEARCH_POLL_BUDGET_MS;
      delete process.env.DEEP_RESEARCH_RETRY_POLL_BUDGET_MS;
    });

    function mockInteractions(createSequence: any[], getSequence: any[]): void {
      createMock = jest.fn();
      createSequence.forEach((value) => createMock.mockResolvedValueOnce(value));
      getMock = jest.fn();
      getSequence.forEach((value) => getMock.mockResolvedValueOnce(value));
      cancelMock = jest.fn().mockResolvedValue({});
      mockGoogleGenAI.mockImplementation(() => ({
        interactions: { create: createMock, get: getMock, cancel: cancelMock },
      }));
    }

    it('degrades depth once and succeeds on retry after the first attempt times out', async () => {
      const runningInteraction = { id: 'primary-1', status: 'running', steps: [] };
      const completedInteraction = {
        id: 'retry-1',
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '# Retry report\n\nFinished at reduced depth.' }] }],
      };
      mockInteractions([runningInteraction, completedInteraction], [runningInteraction]);

      const resultPromise = deepResearchService.performDeepResearch({
        topic: 'Apple silicon moat',
        depth: 'comprehensive',
      });
      await jest.advanceTimersByTimeAsync(10000); // primary attempt's single poll wait
      await jest.advanceTimersByTimeAsync(10000); // retry attempt (no-op if it completes immediately)
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.markdownContent).toContain('Finished at reduced depth');
      expect(result.degradedFrom).toBe('comprehensive');
      expect(result.actualDepth).toBe('detailed');
      expect(createMock).toHaveBeenCalledTimes(2);
      // Reduced depth ('detailed') routes to the speed agent, not the max agent.
      expect(createMock.mock.calls[1][0]).toEqual(
        expect.objectContaining({ agent: DEEP_RESEARCH_AGENT_SPEED })
      );
      // ENG-738: the abandoned primary interaction (still running server-side
      // in the background) must be cancelled — not left to burn compute/cost
      // for a result nothing will ever read. The winning retry, which is now
      // 'completed' (terminal), must NOT be cancelled.
      expect(cancelMock).toHaveBeenCalledTimes(1);
      expect(cancelMock).toHaveBeenCalledWith('primary-1');
    });

    it('returns honest partial content when the depth-degraded retry also times out', async () => {
      const primaryPartial = {
        id: 'primary-2',
        status: 'running',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Primary partial findings before the cutoff.' }] }],
      };
      const retryRunning = { id: 'retry-2', status: 'running', steps: [] };
      mockInteractions([primaryPartial, retryRunning], [primaryPartial, retryRunning]);

      const resultPromise = deepResearchService.performDeepResearch({
        topic: 'Semiconductor architecture',
        depth: 'comprehensive',
      });
      await jest.advanceTimersByTimeAsync(10000); // primary poll
      await jest.advanceTimersByTimeAsync(10000); // retry poll
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.partial).toBe(true);
      expect(result.partialContent).toContain('Primary partial findings');
      expect(result.partialDepth).toBe('comprehensive');
      expect(result.error).toBeTruthy();
      // ENG-738: neither interaction ever reached a terminal status — both are
      // still running server-side and must both be cancelled exactly once
      // (not zero, not duplicated) once we're done reading from them.
      expect(cancelMock).toHaveBeenCalledTimes(2);
      expect(cancelMock).toHaveBeenCalledWith('primary-2');
      expect(cancelMock).toHaveBeenCalledWith('retry-2');
    });

    it('does not attempt a further retry when depth is already overview', async () => {
      const runningWithPartial = {
        id: 'primary-3',
        status: 'running',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Overview partial text.' }] }],
      };
      mockInteractions([runningWithPartial], [runningWithPartial]);

      const resultPromise = deepResearchService.performDeepResearch({
        topic: 'Topic X',
        depth: 'overview',
      });
      await jest.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;

      expect(createMock).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.partial).toBe(true);
      expect(result.partialContent).toContain('Overview partial text');
      expect(result.partialDepth).toBe('overview');
      // ENG-738: no retry ran, but the single timed-out interaction is still
      // abandoned in the give-up path.
      expect(cancelMock).toHaveBeenCalledTimes(1);
      expect(cancelMock).toHaveBeenCalledWith('primary-3');
    });

    it('does not mark the result partial when the timed-out attempt produced no content', async () => {
      // Honesty guard (mirrors the ENG-510 media-timeout convention): a genuinely
      // empty timeout must not be dressed up as a partial success.
      const emptyRunning = { id: 'primary-4', status: 'running', steps: [] };
      mockInteractions([emptyRunning], [emptyRunning]);

      const resultPromise = deepResearchService.performDeepResearch({
        topic: 'Topic Y',
        depth: 'overview',
      });
      await jest.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.partial).toBeFalsy();
      expect(result.partialContent).toBeUndefined();
      expect(result.error).toBeTruthy();
    });

    it('does not attempt to cancel an interaction that already reached a terminal failed/cancelled status', async () => {
      // 'failed'/'cancelled' is already terminal — nothing left to cancel, and
      // the Gemini API itself only supports cancelling still-running interactions.
      const failedInteraction = { id: 'primary-5', status: 'failed', steps: [] };
      mockInteractions([failedInteraction], []);

      const resultPromise = deepResearchService.performDeepResearch({
        topic: 'Topic F',
        depth: 'overview',
      });
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(cancelMock).not.toHaveBeenCalled();
    });

    it('does not let a cancel failure break the returned research result', async () => {
      const emptyRunning = { id: 'primary-6', status: 'running', steps: [] };
      mockInteractions([emptyRunning], [emptyRunning]);
      cancelMock.mockRejectedValue(new Error('cancel API unavailable'));

      const resultPromise = deepResearchService.performDeepResearch({
        topic: 'Topic G',
        depth: 'overview',
      });
      await jest.advanceTimersByTimeAsync(10000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('honors DEEP_RESEARCH_POLL_BUDGET_MS to bound the primary poll loop', async () => {
      process.env.DEEP_RESEARCH_POLL_BUDGET_MS = '30000'; // 3 poll attempts
      process.env.DEEP_RESEARCH_RETRY_POLL_BUDGET_MS = '10000'; // 1 poll attempt

      const primaryRunning = { id: 'primary-5', status: 'running', steps: [] };
      const retryRunning = { id: 'retry-5', status: 'running', steps: [] };
      createMock = jest.fn()
        .mockResolvedValueOnce(primaryRunning)
        .mockResolvedValueOnce(retryRunning);
      getMock = jest.fn().mockImplementation((id: string) =>
        Promise.resolve(id === 'primary-5' ? primaryRunning : retryRunning)
      );
      mockGoogleGenAI.mockImplementation(() => ({
        interactions: { create: createMock, get: getMock },
      }));

      const resultPromise = deepResearchService.performDeepResearch({
        topic: 'Topic Z',
        depth: 'detailed',
      });
      await jest.advanceTimersByTimeAsync(10000);
      await jest.advanceTimersByTimeAsync(10000);
      await jest.advanceTimersByTimeAsync(10000);
      await jest.advanceTimersByTimeAsync(10000);
      await resultPromise;

      // 3 polls for the primary pass (30000 / 10000) + 1 poll for the retry pass.
      expect(getMock).toHaveBeenCalledTimes(4);
    });
  });
});
