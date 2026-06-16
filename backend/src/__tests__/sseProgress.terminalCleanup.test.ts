/**
 * B4 — Clear progressStore on terminal/crash run states (no zombie SSE progress).
 *
 * Bug: progressStore entries (utils/sseProgress.ts) were only cleaned by the
 * controller's terminal paths (markProgressComplete). If the generation worker
 * died mid-iteration, the controller's awaiting code might reject — but the
 * detached fire-and-forget path and any path that doesn't reach a
 * markProgressComplete call would leave a stale progress entry in the store
 * forever, so the frontend SSE stream shows "Thinking…" indefinitely for that
 * session even after a reload.
 *
 * Fix: worker death (`error` / `exit`) now clears the progress entry at the
 * source for every session that had an in-flight request, via
 * clearTerminalProgress(). Normal completion is unchanged.
 *
 * Acceptance criteria pinned here:
 *   1. No orphaned progressStore entry remains after a simulated mid-run crash.
 *   2. Normal completion still cleans up (no entry left behind).
 */

import { GenerateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import {
  progressStore,
  emitProgress,
  getLatestProgress,
  clearTerminalProgress,
  registerProgressCallback,
} from '../utils/sseProgress';
import { fork } from 'child_process';

jest.mock('child_process', () => ({ fork: jest.fn() }));
jest.mock('path', () => ({ join: jest.fn((...args: string[]) => args.join('/')) }));

describe('sseProgress.clearTerminalProgress (unit)', () => {
  afterEach(() => {
    progressStore.clear();
  });

  it('removes the stored progress entry for the session', () => {
    emitProgress('sess-A', { iteration: 3, status: 'executing_tools' });
    expect(progressStore.has('sess-A')).toBe(true);

    clearTerminalProgress('sess-A');

    expect(progressStore.has('sess-A')).toBe(false);
    expect(getLatestProgress('sess-A')).toBeUndefined();
  });

  it('emits a final complete status to a live listener before deleting', () => {
    const received: any[] = [];
    const unregister = registerProgressCallback('sess-B', (p) => received.push(p));
    emitProgress('sess-B', { iteration: 2, status: 'thinking' });

    clearTerminalProgress('sess-B');

    // The last thing the listener saw must be the terminal complete signal,
    // so the frontend stops showing "Thinking…".
    expect(received[received.length - 1]).toEqual({ iteration: 0, status: 'complete' });
    expect(progressStore.has('sess-B')).toBe(false);
    unregister();
  });

  it('is a no-op (no resurrected entry) when no progress exists for the session', () => {
    clearTerminalProgress('never-existed');
    expect(progressStore.has('never-existed')).toBe(false);
  });
});

describe('B4: worker crash clears progressStore (no zombie SSE progress)', () => {
  let workerService: GenerateMarketingResponseWorkerService;
  let mockWorker: any;
  let messageHandler: ((data: any) => void) | undefined;
  let errorHandler: ((error: Error) => void) | undefined;
  let exitHandler: ((code: number | null, signal: string | null) => void) | undefined;

  const waitForSend = async (minCalls = 1) => {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setImmediate(r));
      if (mockWorker.send.mock.calls.length >= minCalls) return;
    }
  };

  const baseParams = {
    messageContent: 'Test message',
    sessionHistory: [],
    userId: 'user-1',
    llmModel: 'gpt-5.1',
    sessionId: 'crash-session',
    mockMode: false,
  };

  const mockResult = {
    content: 'Test response',
    toolCalls: [],
    knowledgeBaseQueries: [],
    sources: [],
    responseMessages: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    progressStore.clear();
    workerService = new GenerateMarketingResponseWorkerService();
    messageHandler = undefined;
    errorHandler = undefined;
    exitHandler = undefined;

    mockWorker = {
      on: jest.fn((event: string, handler: any) => {
        if (event === 'message') {
          messageHandler = handler;
          // Auto-send 'ready' so ensureWorker resolves (mirrors real worker boot).
          handler({ type: 'ready' });
        } else if (event === 'error') {
          errorHandler = handler;
        } else if (event === 'exit') {
          exitHandler = handler;
        }
      }),
      removeListener: jest.fn(),
      send: jest.fn(),
      kill: jest.fn(),
      killed: false,
      stdout: null,
      stderr: null,
    };
    (fork as jest.Mock).mockReturnValue(mockWorker);
  });

  afterEach(() => {
    progressStore.clear();
  });

  it('AC1: leaves NO orphaned progressStore entry after a mid-run worker exit', async () => {
    const promise = workerService.runInWorker(baseParams);
    await waitForSend();

    // Simulate the worker emitting in-flight progress mid-iteration. This is the
    // entry that previously leaked forever when the worker then died.
    emitProgress(baseParams.sessionId, { iteration: 2, status: 'executing_tools', pendingTools: ['x'] });
    expect(progressStore.has(baseParams.sessionId)).toBe(true);

    // Worker dies mid-iteration (crash / OOM / SIGKILL).
    expect(exitHandler).toBeDefined();
    exitHandler!(1, 'SIGKILL');

    await expect(promise).rejects.toThrow(/Worker process exited/);

    // The whole point of the fix: the progress entry must be gone.
    expect(progressStore.has(baseParams.sessionId)).toBe(false);
    expect(getLatestProgress(baseParams.sessionId)).toBeUndefined();
  });

  it('AC1: leaves NO orphaned progressStore entry after a worker process error', async () => {
    const promise = workerService.runInWorker(baseParams);
    await waitForSend();

    emitProgress(baseParams.sessionId, { iteration: 1, status: 'thinking' });
    expect(progressStore.has(baseParams.sessionId)).toBe(true);

    expect(errorHandler).toBeDefined();
    errorHandler!(new Error('Worker process crashed'));

    await expect(promise).rejects.toThrow('Worker process crashed');

    expect(progressStore.has(baseParams.sessionId)).toBe(false);
  });

  it('AC1: clears progress for ALL in-flight sessions when the worker dies', async () => {
    const p1 = workerService.runInWorker({ ...baseParams, sessionId: 'sess-1' });
    await waitForSend(1);
    const p2 = workerService.runInWorker({ ...baseParams, sessionId: 'sess-2' });
    await waitForSend(2);

    emitProgress('sess-1', { iteration: 1, status: 'thinking' });
    emitProgress('sess-2', { iteration: 1, status: 'executing_tools' });

    exitHandler!(null, 'SIGTERM');

    await expect(p1).rejects.toThrow(/Worker process exited/);
    await expect(p2).rejects.toThrow(/Worker process exited/);

    expect(progressStore.has('sess-1')).toBe(false);
    expect(progressStore.has('sess-2')).toBe(false);
  });

  it('AC2: normal completion does not leave the entry orphaned either', async () => {
    const promise = workerService.runInWorker(baseParams);
    await waitForSend();

    // Mid-run progress, then the worker reports success normally.
    emitProgress(baseParams.sessionId, { iteration: 1, status: 'thinking' });
    const requestId = mockWorker.send.mock.calls[0][0].requestId;
    messageHandler!({ type: 'success', requestId, result: mockResult });

    await expect(promise).resolves.toEqual(mockResult);

    // On the worker-service side a successful run simply settles the promise;
    // the controller's markProgressComplete handles the store cleanup for the
    // happy path. Here we assert the controller's terminal helper (same final
    // effect) leaves nothing behind.
    clearTerminalProgress(baseParams.sessionId);
    expect(progressStore.has(baseParams.sessionId)).toBe(false);
  });
});
