/**
 * Interruption disclosure plumbing — worker death must tell the controller
 * WHICH tools were in flight (so the persisted disclosure can say
 * "interrupted — NOT executed"), and must clear SSE progress BEFORE dropping
 * the session mapping (B4 ordering).
 *
 * Also pins that the drain-ceiling rejection ("Worker shutdown — drain
 * ceiling exceeded") is classified as a worker-shutdown error, so drained
 * runs get the interrupted treatment instead of a generic diagnosis.
 */
import { GenerateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { isWorkerShutdownError } from '../utils/agentModeErrors';
import { clearTerminalProgress } from '../utils/sseProgress';

jest.mock('child_process', () => ({ fork: jest.fn() }));
jest.mock('path', () => ({ join: jest.fn((...args) => args.join('/')) }));
jest.mock('../utils/sseProgress', () => ({
  clearTerminalProgress: jest.fn(),
}));

import { fork } from 'child_process';

describe('worker death — pendingTools disclosure + progress ordering', () => {
  let service: GenerateMarketingResponseWorkerService;
  let mockWorker: any;
  let messageHandler: ((data: any) => void) | undefined;
  let exitHandler: ((code: number | null, signal: string | null) => void) | undefined;

  const params = {
    messageContent: 'hi',
    sessionHistory: [],
    userId: 'u1',
    llmModel: 'gpt-5-chat-2',
    sessionId: 'session-pt',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GenerateMarketingResponseWorkerService();
    mockWorker = {
      killed: false,
      on: jest.fn((event: string, handler: any) => {
        if (event === 'message') {
          messageHandler = handler;
          handler({ type: 'ready' });
        } else if (event === 'exit') {
          exitHandler = handler;
        }
      }),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      send: jest.fn(),
      kill: jest.fn(),
    };
    (fork as jest.Mock).mockReturnValue(mockWorker);
  });

  it('rejection error carries the pendingTools from the last progress update', async () => {
    const runPromise = service.runInWorker(params as any);
    await new Promise((r) => setImmediate(r));

    // Worker reports two tools in flight, then dies.
    const requestId = mockWorker.send.mock.calls.find(
      (c: any[]) => c[0].type === 'generateMarketingResponse'
    )![0].requestId;
    messageHandler!({
      type: 'progress',
      requestId,
      progress: { iteration: 2, status: 'executing_tools', pendingTools: ['send_email', 'update_lead'] },
    });
    exitHandler!(1, null);

    await expect(runPromise).rejects.toMatchObject({
      pendingTools: ['send_email', 'update_lead'],
    });
    const err = await runPromise.catch((e) => e);
    expect(isWorkerShutdownError(err)).toBe(true);
  });

  it('rejection error has no pendingTools when no tools were in flight', async () => {
    const runPromise = service.runInWorker(params as any);
    await new Promise((r) => setImmediate(r));
    exitHandler!(1, null);

    const err = await runPromise.catch((e) => e);
    expect(err.pendingTools).toBeUndefined();
  });

  it('clears SSE progress for the dying run BEFORE rejecting (B4 ordering preserved)', async () => {
    const order: string[] = [];
    (clearTerminalProgress as jest.Mock).mockImplementation(() => order.push('clearProgress'));

    const runPromise = service.runInWorker(params as any);
    await new Promise((r) => setImmediate(r));
    runPromise.catch(() => order.push('rejected'));
    exitHandler!(1, null);
    await new Promise((r) => setImmediate(r));

    expect(order[0]).toBe('clearProgress');
    expect(clearTerminalProgress).toHaveBeenCalledWith('session-pt');
  });
});

describe('isWorkerShutdownError — drain-ceiling rejection', () => {
  it('classifies "Worker shutdown — drain ceiling exceeded" as a worker shutdown', () => {
    expect(isWorkerShutdownError(new Error('Worker shutdown — drain ceiling exceeded'))).toBe(true);
  });

  it('still classifies the exact legacy messages', () => {
    expect(isWorkerShutdownError(new Error('Worker shutdown'))).toBe(true);
    expect(isWorkerShutdownError(new Error('Worker process exited with code 1 and signal null'))).toBe(true);
  });

  it('does not classify unrelated errors', () => {
    expect(isWorkerShutdownError(new Error('Workerless mystery'))).toBe(false);
  });
});
