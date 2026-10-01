const mockCallLLM = jest.fn();
const mockGetOpenRouterClient = jest.fn();

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    callLLM: (...args: any[]) => mockCallLLM(...args),
    getOpenRouterClient: (...args: any[]) => mockGetOpenRouterClient(...args),
  },
}));

import { DeepResearchService } from '../services/deepResearchService';

describe('DeepResearchService OpenRouter cutover', () => {
  let service: DeepResearchService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DeepResearchService();
    mockGetOpenRouterClient.mockResolvedValue({});
    mockCallLLM.mockResolvedValue({
      choices: [{ message: { content: '# Research title\n\nA cited report body.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.02 },
    });
  });

  it('routes research through the internal Sonar model and content-generation task class', async () => {
    await service.performDeepResearch({ topic: 'AI infrastructure', userId: 'user-1' });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(mockCallLLM.mock.calls[0][0]).toBe('openrouter/perplexity/sonar-deep-research');
    expect(mockCallLLM.mock.calls[0][2]).toEqual(expect.objectContaining({
      taskClass: 'content_generation',
      timeoutMs: 9 * 60 * 1000,
      usageContext: { userId: 'user-1', feature: 'content_gen' },
      fallbackModels: ['openrouter/perplexity/sonar-pro-search'],
    }));
  });

  it('keeps all caller steering and inline-citation requirements in one prompt', async () => {
    await service.performDeepResearch({
      topic: 'AI market size',
      prompt: 'Compare private and public companies',
      tone: 'executive',
      style: 'substack',
      depth: 'comprehensive',
      focus_areas: ['unit economics', 'growth'],
    });

    const prompt = mockCallLLM.mock.calls[0][1][0].content as string;
    expect(prompt).toContain('AI market size');
    expect(prompt).toContain('executive');
    expect(prompt).toContain('newsletter-style');
    expect(prompt).toContain('at least 4000 words');
    expect(prompt).toContain('unit economics, growth');
    expect(prompt).toContain('Compare private and public companies');
    expect(prompt).toMatch(/cite.*inline/i);
  });

  it('preserves depth ordering within the fallback model output ceiling', async () => {
    await service.performDeepResearch({ topic: 'A', depth: 'overview' });
    const overviewBudget = mockCallLLM.mock.calls[0][2].max_completion_tokens;
    mockCallLLM.mockClear();

    await service.performDeepResearch({ topic: 'A', depth: 'detailed' });
    const detailedBudget = mockCallLLM.mock.calls[0][2].max_completion_tokens;
    mockCallLLM.mockClear();

    await service.performDeepResearch({ topic: 'A', depth: 'comprehensive' });
    const comprehensiveBudget = mockCallLLM.mock.calls[0][2].max_completion_tokens;

    expect([overviewBudget, detailedBudget, comprehensiveBudget]).toEqual([
      5_000,
      7_000,
      8_000,
    ]);
    expect(comprehensiveBudget).toBeLessThanOrEqual(8_000);
  });

  it('returns the existing report contract with title and bounded summary', async () => {
    const longBody = `# Exact title\n\n${'A'.repeat(700)}`;
    mockCallLLM.mockResolvedValueOnce({ choices: [{ message: { content: longBody } }] });

    const result = await service.performDeepResearch({ topic: 'Fallback title' });

    expect(result.success).toBe(true);
    expect(result.markdownContent).toBe(longBody);
    expect(result.title).toBe('Exact title');
    expect(result.researchSummary).toHaveLength(503);
    expect(result.researchSummary).toMatch(/\.\.\.$/);
  });

  it('fails closed when OpenRouter returns no report text', async () => {
    mockCallLLM.mockResolvedValueOnce({ choices: [{ message: { content: '' } }] });

    await expect(service.performDeepResearch({ topic: 'Empty' })).resolves.toEqual({
      success: false,
      error: 'Deep research completed but no report content was returned.',
    });
  });

  it('preserves the service error contract when the gateway fails', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('upstream unavailable'));

    const result = await service.performDeepResearch({ topic: 'Failure' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('upstream unavailable');
  });

  it('reports availability from the same OpenRouter credential path used for calls', async () => {
    await expect(service.isAvailable()).resolves.toBe(true);
    mockGetOpenRouterClient.mockRejectedValueOnce(new Error('missing key'));
    await expect(service.isAvailable()).resolves.toBe(false);
  });
});

// ENG-738: a genuine timeout on a degradable depth used to surface as a bare
// failure with nothing to show for it. The service now retries once at the
// next cheaper depth within a reserved slice of the same overall budget.
describe('DeepResearchService depth-degrading timeout retry (ENG-738)', () => {
  let service: DeepResearchService;
  const timeoutError = () => Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DeepResearchService();
    mockGetOpenRouterClient.mockResolvedValue({});
  });

  it('retries once at a cheaper depth after the primary attempt times out, and reports the depth actually delivered', async () => {
    mockCallLLM
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce({
        choices: [{ message: { content: '# Retry title\n\nRetry body.' } }],
      });

    const result = await service.performDeepResearch({ topic: 'A', depth: 'comprehensive', userId: 'user-1' });

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.markdownContent).toBe('# Retry title\n\nRetry body.');
    expect(result.degradedFrom).toBe('comprehensive');
    expect(result.actualDepth).toBe('detailed');
  });

  it('degrades detailed to overview on timeout', async () => {
    mockCallLLM
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce({ choices: [{ message: { content: '# T\n\nB' } }] });

    const result = await service.performDeepResearch({ topic: 'A', depth: 'detailed' });

    expect(result.degradedFrom).toBe('detailed');
    expect(result.actualDepth).toBe('overview');
  });

  it('reserves a slice of the total budget for the retry, shrinking the primary attempt', async () => {
    mockCallLLM
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce({ choices: [{ message: { content: '# T\n\nB' } }] });

    await service.performDeepResearch({ topic: 'A', depth: 'comprehensive' });

    const primaryTimeoutMs = mockCallLLM.mock.calls[0][2].timeoutMs;
    const retryTimeoutMs = mockCallLLM.mock.calls[1][2].timeoutMs;
    expect(primaryTimeoutMs).toBe(7 * 60 * 1000);
    expect(retryTimeoutMs).toBe(2 * 60 * 1000);
    expect(primaryTimeoutMs + retryTimeoutMs).toBe(9 * 60 * 1000);
  });

  it('does not retry when already at the cheapest depth', async () => {
    mockCallLLM.mockRejectedValueOnce(timeoutError());

    const result = await service.performDeepResearch({ topic: 'A', depth: 'overview' });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(mockCallLLM.mock.calls[0][2].timeoutMs).toBe(9 * 60 * 1000);
  });

  it('does not retry when no depth was requested at all (e.g. the blog-article caller)', async () => {
    mockCallLLM.mockRejectedValueOnce(timeoutError());

    const result = await service.performDeepResearch({ topic: 'A' });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });

  it('does not retry a non-timeout failure, even at a degradable depth', async () => {
    mockCallLLM.mockRejectedValueOnce(new Error('400 invalid request'));

    const result = await service.performDeepResearch({ topic: 'A', depth: 'comprehensive' });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.degradedFrom).toBeUndefined();
  });

  it('reports the primary failure, not the retry failure, when both attempts time out', async () => {
    mockCallLLM
      .mockRejectedValueOnce(Object.assign(new Error('primary timed out'), { name: 'TimeoutError' }))
      .mockRejectedValueOnce(Object.assign(new Error('retry timed out'), { name: 'TimeoutError' }));

    const result = await service.performDeepResearch({ topic: 'A', depth: 'comprehensive' });

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error).toContain('primary timed out');
    expect(result.degradedFrom).toBeUndefined();
  });

  it('does not retry when the primary attempt succeeds', async () => {
    mockCallLLM.mockResolvedValueOnce({ choices: [{ message: { content: '# T\n\nB' } }] });

    const result = await service.performDeepResearch({ topic: 'A', depth: 'comprehensive' });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.degradedFrom).toBeUndefined();
  });
});
