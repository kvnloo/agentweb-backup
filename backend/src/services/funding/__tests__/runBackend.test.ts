jest.mock('../../agentModeService', () => ({
  agentModeService: { generateMarketingResponse: jest.fn() },
}));

import { agentModeService } from '../../agentModeService';
import { EmmaLoopBackend, pickRunBackend } from '../runBackend';
import { RunEmitter, type RunEvent } from '../../agentMode/streamEvents';
import type { GenerateMarketingResponseParams } from '../../generateMarketingResponseWorkerService';

const mockGenerate = agentModeService.generateMarketingResponse as jest.Mock;

const FULL_PARAMS: GenerateMarketingResponseParams = {
  messageContent: 'hello',
  sessionHistory: [{ role: 'user', content: 'hi' }] as any,
  userId: 'user-1',
  llmModel: 'anthropic.claude-sonnet-5',
  sessionId: 'session-1',
  mockMode: false,
  isInteractiveShare: true,
  isDelegatedAccess: false,
  excludeTools: ['get_visual_context'],
  screenshotUrl: 'https://example.com/shot.png',
  persistIncrementally: true,
  turnStartMs: 12345,
  publishAuthorizationOverride: { authorized: true, tools: ['publish_post'] },
  approvedRevisionImageSources: ['https://example.com/img.png'],
  requireWorkPlanDisposition: true,
  isUnattendedRun: false,
};

describe('EmmaLoopBackend (ENG-1816 F1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerate.mockResolvedValue({ content: 'ok', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
  });

  it('calls generateMarketingResponse with every field, in the exact positional order the real worker script uses', async () => {
    const onProgress = jest.fn();
    const socketEmit = jest.fn();
    const isCancelled = jest.fn(() => false);

    await new EmmaLoopBackend().run(FULL_PARAMS, { onProgress, socketEmit, isCancelled });

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledWith(
      FULL_PARAMS.messageContent,
      FULL_PARAMS.sessionHistory,
      FULL_PARAMS.userId,
      FULL_PARAMS.llmModel,
      FULL_PARAMS.sessionId,
      FULL_PARAMS.mockMode,
      onProgress,
      socketEmit,
      FULL_PARAMS.isInteractiveShare,
      isCancelled,
      FULL_PARAMS.excludeTools,
      FULL_PARAMS.screenshotUrl,
      FULL_PARAMS.isDelegatedAccess,
      FULL_PARAMS.persistIncrementally,
      FULL_PARAMS.turnStartMs,
      FULL_PARAMS.publishAuthorizationOverride,
      FULL_PARAMS.approvedRevisionImageSources,
      FULL_PARAMS.requireWorkPlanDisposition,
      FULL_PARAMS.isUnattendedRun,
    );
  });

  it('returns generateMarketingResponse\'s result unchanged', async () => {
    const result = { content: 'specific', toolCalls: [{ id: 't1' }], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
    mockGenerate.mockResolvedValue(result);

    const returned = await new EmmaLoopBackend().run(FULL_PARAMS, {
      onProgress: jest.fn(),
      socketEmit: jest.fn(),
      isCancelled: () => false,
    });

    expect(returned).toBe(result);
  });

  it('pickRunBackend always resolves EmmaLoopBackend in F1, regardless of RunFunding', () => {
    const backend1 = pickRunBackend(undefined);
    const backend2 = pickRunBackend({
      route: 'api_key',
      fallback: 'stop',
      ownerUserId: 'u',
      billingUserId: 'u',
      resolvedAt: new Date().toISOString(),
    });
    expect(backend1).toBeInstanceOf(EmmaLoopBackend);
    expect(backend1).toBe(backend2);
  });
});

describe('EmmaLoopBackend terminal events (ENG-2104 F3)', () => {
  const callbacks = (overrides: Record<string, unknown> = {}) => ({
    onProgress: jest.fn(),
    socketEmit: jest.fn(),
    isCancelled: () => false,
    ...overrides,
  });
  const parts = (events: RunEvent[]) => events.map((e) => e.part);

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks keeps implementations, so reset the default a previous test may have replaced.
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValue({ content: 'ok', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('emits attempt-finished then finish(stop) on a completed run, with the tool-call count', async () => {
    mockGenerate.mockResolvedValue({ content: 'ok', toolCalls: [{ id: 'a' }, { id: 'b' }], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
    const events: RunEvent[] = [];
    const emitter = new RunEmitter('run-1', (e) => events.push(e));

    await new EmmaLoopBackend().run(FULL_PARAMS, callbacks({ emitter }));

    expect(events.map((e) => e.seq)).toEqual([0, 1]);
    expect(parts(events)).toEqual([
      { type: 'attempt-finished', outcome: 'completed', toolCalls: 2 },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it('emits failed/error and rethrows the ORIGINAL error when the run throws', async () => {
    const boom = new Error('model exploded');
    mockGenerate.mockRejectedValue(boom);
    const events: RunEvent[] = [];
    const emitter = new RunEmitter('run-1', (e) => events.push(e));

    await expect(new EmmaLoopBackend().run(FULL_PARAMS, callbacks({ emitter }))).rejects.toBe(boom);

    expect(parts(events)).toEqual([
      { type: 'attempt-finished', outcome: 'failed' },
      { type: 'finish', reason: 'error' },
    ]);
  });

  it('reports cancelled from the loop\'s own result.cancelled, not from isCancelled()', async () => {
    mockGenerate.mockResolvedValue({ content: '', cancelled: true, toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
    const events: RunEvent[] = [];
    const emitter = new RunEmitter('run-1', (e) => events.push(e));

    await new EmmaLoopBackend().run(FULL_PARAMS, callbacks({ emitter, isCancelled: () => false }));

    expect(parts(events)).toEqual([
      { type: 'attempt-finished', outcome: 'cancelled', toolCalls: 0 },
      { type: 'finish', reason: 'cancelled' },
    ]);
  });

  it('a run that finished and was stopped only during tail work stays completed', async () => {
    mockGenerate.mockResolvedValue({ content: 'full answer', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] });
    const events: RunEvent[] = [];
    const emitter = new RunEmitter('run-1', (e) => events.push(e));

    await new EmmaLoopBackend().run(FULL_PARAMS, callbacks({ emitter, isCancelled: () => true }));

    expect(parts(events)[0]).toEqual({ type: 'attempt-finished', outcome: 'completed', toolCalls: 0 });
  });

  it('a throwing sink never reaches the turn: the result is still returned unchanged', async () => {
    const result = { content: 'ok', toolCalls: [], knowledgeBaseQueries: [], sources: [], responseMessages: [] };
    mockGenerate.mockResolvedValue(result);
    const emitter = new RunEmitter('run-1', () => { throw new Error('sink down'); });

    await expect(new EmmaLoopBackend().run(FULL_PARAMS, callbacks({ emitter }))).resolves.toBe(result);
    expect(console.error).toHaveBeenCalled();
  });

  it('a throwing sink does not mask the run\'s own error', async () => {
    const boom = new Error('model exploded');
    mockGenerate.mockRejectedValue(boom);
    const emitter = new RunEmitter('run-1', () => { throw new Error('sink down'); });

    await expect(new EmmaLoopBackend().run(FULL_PARAMS, callbacks({ emitter }))).rejects.toBe(boom);
  });

  it('works unchanged with no emitter, and still hands the same callbacks to generateMarketingResponse', async () => {
    const cb = callbacks();
    await new EmmaLoopBackend().run(FULL_PARAMS, cb);
    const args = mockGenerate.mock.calls[0];
    expect(args[6]).toBe(cb.onProgress);
    expect(args[7]).toBe(cb.socketEmit);
  });
});
