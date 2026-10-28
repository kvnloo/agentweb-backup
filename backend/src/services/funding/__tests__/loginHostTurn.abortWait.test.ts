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
