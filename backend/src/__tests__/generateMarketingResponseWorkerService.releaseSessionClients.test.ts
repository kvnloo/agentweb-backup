/**
 * ENG-1118: releasing a finished session's MCP clients across the process boundary.
 *
 * Browser MCP clients pool per chat session and live in the forked generate worker, not in
 * the controller process that ends a scheduled run — so `mcpClientService.releaseSessionClients`
 * called from the controller would reclaim nothing. The controller signals the worker instead,
 * fire-and-forget, exactly like cancelSession does.
 *
 * The contract pinned here: send when there is a live worker, stay silent (and never fork one)
 * when there isn't, and never throw into the caller's `finally`.
 */
import { GenerateMarketingResponseWorkerService } from '../services/generateMarketingResponseWorkerService';
import { fork } from 'child_process';

jest.mock('child_process', () => ({ fork: jest.fn() }));
jest.mock('path', () => ({ join: jest.fn((...args: string[]) => args.join('/')) }));

describe('GenerateMarketingResponseWorkerService.releaseSessionClients (ENG-1118)', () => {
  let service: GenerateMarketingResponseWorkerService;
  let mockWorker: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GenerateMarketingResponseWorkerService();

    mockWorker = {
      killed: false,
      connected: true,
      pid: 4321,
      send: jest.fn(),
      kill: jest.fn(),
      stdout: { on: jest.fn() },
      stderr: { on: jest.fn() },
      on: jest.fn((event: string, handler: any) => {
        // Mirror a worker that finishes initialization as soon as it is listened to.
        if (event === 'message') setImmediate(() => handler({ type: 'ready' }));
      }),
      removeAllListeners: jest.fn(),
    };
    (fork as jest.Mock).mockReturnValue(mockWorker);
  });

  it('does not send — or fork — anything when no worker is running', () => {
    expect(() => service.releaseSessionClients('session-a')).not.toThrow();

    expect(fork).not.toHaveBeenCalled();
    expect(mockWorker.send).not.toHaveBeenCalled();
  });

  it('signals the live worker to release that session', async () => {
    await service.ensureWorkerReady();

    service.releaseSessionClients('session-a');

    expect(mockWorker.send).toHaveBeenCalledWith({ type: 'releaseSessionClients', sessionId: 'session-a' });
  });

  it('stays silent for a killed worker', async () => {
    await service.ensureWorkerReady();
    mockWorker.send.mockClear();
    mockWorker.killed = true;

    service.releaseSessionClients('session-a');

    expect(mockWorker.send).not.toHaveBeenCalled();
  });

  it('swallows a send failure on a torn-down IPC channel', async () => {
    await service.ensureWorkerReady();
    mockWorker.send.mockImplementation(() => { throw new Error('channel closed'); });

    expect(() => service.releaseSessionClients('session-a')).not.toThrow();
  });

  it('ignores an empty session id', async () => {
    await service.ensureWorkerReady();
    mockWorker.send.mockClear();

    service.releaseSessionClients('');

    expect(mockWorker.send).not.toHaveBeenCalled();
  });
});
