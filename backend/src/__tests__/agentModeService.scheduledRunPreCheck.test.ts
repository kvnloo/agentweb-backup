/**
 * ENG-1259 — the cheap pre-check gate's LLM call.
 *
 * `evaluateScheduledRunPreCheck` is a thin, fail-open wrapper around a single
 * cheap/fast model call (mirrors `generateScheduledChatSummary` /
 * `generateDiagnosticMessage`'s DIAGNOSIS_MODEL pattern) — it must NEVER
 * throw, and must return `null` (not a guessed decision) on any timeout,
 * error, or unparseable response, so the pure fold in
 * `resolvePreCheckDecision` (scheduledRunPreCheck.ts) can fail toward running.
 */

import { agentModeService } from '../services/agentModeService';

describe('evaluateScheduledRunPreCheck (ENG-1259)', () => {
  let callLLMSpy: jest.SpyInstance;

  const mockLLMContent = (content: string | null) => {
    callLLMSpy = jest
      .spyOn(agentModeService as any, 'callLLM')
      .mockResolvedValue({ choices: [{ message: { content } }] } as any);
  };

  const sentMessages = (): any[] => callLLMSpy.mock.calls[0][1];
  const sentUserContent = (): string => sentMessages().find((m: any) => m.role === 'user').content;
  const sentSystemContent = (): string => sentMessages().find((m: any) => m.role === 'system').content;
  const sentModel = (): string => callLLMSpy.mock.calls[0][0];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls a cheap/fast model, not the primary generation model', async () => {
    mockLLMContent(JSON.stringify({ decision: 'proceed', confidence: 'high', reason: 'ok' }));

    await agentModeService.evaluateScheduledRunPreCheck({
      scheduleName: 'LUCAS — LinkedIn Thought Leadership (Mon/Wed/Fri)',
      startingMessage: 'Publish a thought-leadership post.',
      lastRunStatus: 'failure',
      lastRunSummary: 'Nothing Published',
      consecutiveNoOutputRuns: 1,
    });

    // Same cheap tier used elsewhere for lightweight classification calls
    // (generateScheduledChatSummary, generateDiagnosticMessage) — never the
    // schedule's own primary generation model.
    expect(sentModel()).toBe('gemini-3.1-flash-lite');
  });

  it('sends the schedule instructions and recent-history signal to the model', async () => {
    mockLLMContent(JSON.stringify({ decision: 'skip', confidence: 'high', reason: 'repeat no-op' }));

    await agentModeService.evaluateScheduledRunPreCheck({
      scheduleName: 'LUCAS',
      startingMessage: 'Publish today\'s thought-leadership post only on Mon/Wed/Fri.',
      lastRunStatus: 'failure',
      lastRunSummary: 'Schedule skipped',
      consecutiveNoOutputRuns: 3,
    });

    const user = sentUserContent();
    expect(user).toContain('Publish today\'s thought-leadership post only on Mon/Wed/Fri.');
    expect(user).toContain('Schedule skipped');
    expect(user).toContain('3');
  });

  it('instructs the model to default to proceed when uncertain (fail toward running)', async () => {
    mockLLMContent(JSON.stringify({ decision: 'proceed', confidence: 'high', reason: 'ok' }));

    await agentModeService.evaluateScheduledRunPreCheck({
      scheduleName: 'LUCAS',
      startingMessage: 'Publish a post.',
      lastRunStatus: null,
      lastRunSummary: null,
      consecutiveNoOutputRuns: 0,
    });

    const system = sentSystemContent();
    expect(system.toLowerCase()).toContain('proceed');
    expect(system.toLowerCase()).toContain('no live access');
  });

  it('parses a well-formed JSON response into decision/confidence/reason', async () => {
    mockLLMContent(JSON.stringify({ decision: 'skip', confidence: 'high', reason: 'no new content likely' }));

    const result = await agentModeService.evaluateScheduledRunPreCheck({
      scheduleName: 'LUCAS',
      startingMessage: 'Publish a post.',
      lastRunStatus: 'failure',
      lastRunSummary: 'Nothing Published',
      consecutiveNoOutputRuns: 2,
    });

    expect(result).toEqual({ decision: 'skip', confidence: 'high', reason: 'no new content likely' });
  });

  it('returns null (fail-open) when the model call throws', async () => {
    jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue(new Error('model unavailable'));

    const result = await agentModeService.evaluateScheduledRunPreCheck({
      scheduleName: 'LUCAS',
      startingMessage: 'Publish a post.',
      lastRunStatus: 'failure',
      lastRunSummary: 'Nothing Published',
      consecutiveNoOutputRuns: 1,
    });

    expect(result).toBeNull();
  });

  it('returns null (fail-open) when the response is not valid JSON', async () => {
    mockLLMContent('not json at all');

    const result = await agentModeService.evaluateScheduledRunPreCheck({
      scheduleName: 'LUCAS',
      startingMessage: 'Publish a post.',
      lastRunStatus: 'failure',
      lastRunSummary: 'Nothing Published',
      consecutiveNoOutputRuns: 1,
    });

    expect(result).toBeNull();
  });

  it('returns null (fail-open) when the response content is empty', async () => {
    mockLLMContent('');

    const result = await agentModeService.evaluateScheduledRunPreCheck({
      scheduleName: 'LUCAS',
      startingMessage: 'Publish a post.',
      lastRunStatus: null,
      lastRunSummary: null,
      consecutiveNoOutputRuns: 0,
    });

    expect(result).toBeNull();
  });

  it('never throws — a rejected promise from callLLM resolves to null, not a rejection', async () => {
    jest.spyOn(agentModeService as any, 'callLLM').mockRejectedValue(new Error('boom'));

    await expect(
      agentModeService.evaluateScheduledRunPreCheck({
        scheduleName: 'LUCAS',
        startingMessage: 'Publish a post.',
        lastRunStatus: 'failure',
        lastRunSummary: 'Nothing Published',
        consecutiveNoOutputRuns: 1,
      })
    ).resolves.toBeNull();
  });
});
