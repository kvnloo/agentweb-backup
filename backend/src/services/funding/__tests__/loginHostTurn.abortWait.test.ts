/** ENG-2113 (A3): a Stop while the turn waits for a free slot on the worker must end the wait at once. */
import { LoginHostError, type LoginHostClient } from '../loginHostClient';
import { runHostTurn } from '../loginHostTurn';

describe('runHostTurn: the wait for a free slot is abortable', () => {
  it('a Stop during the EBUSY back-off ends admission immediately (the sleep is not waited out)', async () => {
    const ac = new AbortController();
    const turnRun = jest.fn(async () => {
      throw new LoginHostError('EBUSY', 'host_busy');
    });
    const client = { turnRun } as unknown as LoginHostClient;
    const never = () => new Promise<void>(() => undefined); // a back-off that would last forever
    const started = Date.now();
    const p = runHostTurn(client, { connectionId: 'c', epoch: 1, idempotencyKey: 'k', turnId: 't', prompt: 'p', model: 'm', bridgeToken: 'x'.repeat(16) } as never, { signal: ac.signal, sleep: never, busyWaitMs: 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'EBUSY', detail: 'aborted_while_waiting' });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(turnRun).toHaveBeenCalledTimes(1);
  });
});

describe('runHostTurn: an abort that lands just before the back-off sleep', () => {
  it('the wait returns at once when the signal is already aborted (its event never fires again)', async () => {
    const ac = new AbortController();
    const turnRun = jest.fn(async () => {
      ac.abort(); // the Stop lands while the admission call is in flight
      throw new LoginHostError('EBUSY', 'host_busy');
    });
    const client = { turnRun } as unknown as LoginHostClient;
    const never = () => new Promise<void>(() => undefined);
    const p = runHostTurn(client, { connectionId: 'c', epoch: 1, idempotencyKey: 'k', turnId: 't', prompt: 'p', model: 'm', bridgeToken: 'x'.repeat(16) } as never, { signal: ac.signal, sleep: never, busyWaitMs: 60_000 });
    const outcome = await Promise.race([p.then(() => 'resolved', (e) => e.detail), new Promise((r) => setTimeout(() => r('hung'), 500))]);
    expect(outcome).toBe('aborted_while_waiting');
  });
});

describe('runHostTurn hands its Stop signal to turnRun', () => {
  it('a Stop while the worker has not yet answered turn.run ends the wait: the signal reaches turnRun (no timers: the client rejects as soon as it sees the signal)', async () => {
    const ac = new AbortController();
    let received: AbortSignal | undefined;
    const turnRun = jest.fn(
      (_req: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          received = opts?.signal;
          // a client that was NOT given the signal can never be stopped: fail the test right away instead of hanging it
          if (!opts?.signal) return reject(new Error('SIGNAL_NOT_PASSED_TO_turnRun'));
          opts.signal.addEventListener('abort', () => reject(new LoginHostError('EBUSY', 'aborted_while_waiting')), { once: true });
        }),
    );
    const client = { turnRun } as unknown as LoginHostClient;
    const p = runHostTurn(client, { connectionId: 'c', epoch: 1, idempotencyKey: 'k', turnId: 't', prompt: 'p', model: 'm', tools: [], deadlineMs: 60_000, priority: 'interactive' } as never, {
      signal: ac.signal,
      sleep: async () => undefined,
    });
    await Promise.resolve(); // let admission call turnRun
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'EBUSY', detail: 'aborted_while_waiting' });
    expect(received).toBe(ac.signal);
    expect(turnRun).toHaveBeenCalledTimes(1);
  });
});
