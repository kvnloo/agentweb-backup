/**
 * ENG-2991: finding a subscriber by address in any letter case needs the task's address list, which can be large and which anyone holding a
 * confirmation link can ask for again and again. It is read narrowly, shared between simultaneous callers, kept briefly, and never kept when
 * it failed.
 */
jest.mock('../services/db', () => ({
  subscriberDb: { getTaskSubscriberStates: jest.fn() },
}));

import { subscriberDb } from '../services/db';
import { findSubscriberAnyCase, forgetSubscriberLookup, clearSubscriberLookups, subscriberLookupStats } from '../services/subscriberLookup';

const states = subscriberDb.getTaskSubscriberStates as jest.Mock;
const T0 = 1_800_000_000_000;

beforeEach(() => {
  jest.clearAllMocks();
  clearSubscriberLookups();
  states.mockResolvedValue([
    { email: 'Jane.Doe@Example.com', unsubscribed: false },
    { email: 'other@example.com', unsubscribed: true, unsubscribedAt: '2026-01-01T00:00:00.000Z' },
  ]);
});

describe('findSubscriberAnyCase', () => {
  it('matches the stored spelling whatever the letter case of the address asked for', async () => {
    expect(await findSubscriberAnyCase('t1', 'jane.doe@example.com', T0)).toEqual({ email: 'Jane.Doe@Example.com', unsubscribed: false });
    expect(await findSubscriberAnyCase('t1', 'other@example.com', T0)).toMatchObject({ email: 'other@example.com', unsubscribed: true });
  });

  it('is null for an address that is not on the list, and does not match a different mailbox', async () => {
    expect(await findSubscriberAnyCase('t1', 'nobody@example.com', T0)).toBeNull();
    expect(await findSubscriberAnyCase('t1', 'jane.doe+x@example.com', T0)).toBeNull();
    expect(await findSubscriberAnyCase('t1', 'janedoe@example.com', T0)).toBeNull();
  });

  it('reads the list once for simultaneous callers, and again for another task', async () => {
    await Promise.all(Array.from({ length: 25 }, () => findSubscriberAnyCase('t1', 'jane.doe@example.com', T0)));
    expect(states).toHaveBeenCalledTimes(1);
    await findSubscriberAnyCase('t2', 'jane.doe@example.com', T0);
    expect(states).toHaveBeenCalledTimes(2);
    expect(states).toHaveBeenLastCalledWith('t2');
  });

  it('keeps the list for 10 seconds, then reads it again', async () => {
    await findSubscriberAnyCase('t1', 'jane.doe@example.com', T0);
    await findSubscriberAnyCase('t1', 'jane.doe@example.com', T0 + 9_000);
    expect(states).toHaveBeenCalledTimes(1);
    await findSubscriberAnyCase('t1', 'jane.doe@example.com', T0 + 11_000);
    expect(states).toHaveBeenCalledTimes(2);
  });

  it('works the same whatever the real clock says (it uses the caller\'s clock, not Date.now, to decide what is stale)', async () => {
    const real = jest.spyOn(Date, 'now').mockReturnValue(T0 + 365 * 24 * 3600 * 1000);
    try {
      await findSubscriberAnyCase('t1', 'jane.doe@example.com', T0);
      await findSubscriberAnyCase('t1', 'jane.doe@example.com', T0 + 5_000);
      expect(states).toHaveBeenCalledTimes(1);
      expect(subscriberLookupStats()).toEqual({ tasks: 1, rows: 2 });
    } finally {
      real.mockRestore();
    }
  });

  it('a read that is still under way is shared with callers arriving meanwhile, even past the normal 10 seconds', async () => {
    let finish!: (rows: any[]) => void;
    states.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = findSubscriberAnyCase('slow', 'a@example.com', T0);
    const later = findSubscriberAnyCase('slow', 'a@example.com', T0 + 20_000); // the read has still not come back after 20 seconds
    const another = findSubscriberAnyCase('slow', 'b@example.com', T0 + 25_000);
    expect(states).toHaveBeenCalledTimes(1);
    finish([{ email: 'A@example.com', unsubscribed: false }]);
    expect(await first).toMatchObject({ email: 'A@example.com' });
    expect(await later).toMatchObject({ email: 'A@example.com' });
    expect(await another).toBeNull();
  });

  it('a read that never comes back cannot hold the task for ever: after 30 seconds the next caller starts its own', async () => {
    states.mockImplementationOnce(() => new Promise(() => undefined)); // hangs for good
    void findSubscriberAnyCase('hung', 'a@example.com', T0);
    states.mockResolvedValueOnce([{ email: 'A@example.com', unsubscribed: false }]);
    expect(await findSubscriberAnyCase('hung', 'a@example.com', T0 + 31_000)).toMatchObject({ email: 'A@example.com' });
    expect(states).toHaveBeenCalledTimes(2);
  });

  it('a stale read that was dropped does not disturb its replacement when it resolves or fails later', async () => {
    let finishOld!: (rows: any[]) => void;
    let failOld!: (e: Error) => void;
    states.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const old = findSubscriberAnyCase('swap', 'a@example.com', T0);
    states.mockResolvedValueOnce([{ email: 'New@example.com', unsubscribed: false }]);
    expect(await findSubscriberAnyCase('swap', 'new@example.com', T0 + 31_000)).toMatchObject({ email: 'New@example.com' }); // replaced the hung read
    finishOld([{ email: 'Old@example.com', unsubscribed: false }]);
    expect(await old).toBeNull(); // the old caller still gets its own answer
    expect(subscriberLookupStats()).toEqual({ tasks: 1, rows: 1 }); // and the replacement is intact, with its rows counted once

    states.mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject; }));
    const failing = findSubscriberAnyCase('swap2', 'a@example.com', T0 + 100_000);
    states.mockResolvedValueOnce([{ email: 'Kept@example.com', unsubscribed: false }]);
    await findSubscriberAnyCase('swap2', 'kept@example.com', T0 + 131_000);
    failOld(new Error('late failure'));
    await expect(failing).rejects.toThrow('late failure');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await findSubscriberAnyCase('swap2', 'kept@example.com', T0 + 132_000)).toMatchObject({ email: 'Kept@example.com' });
    expect(states).toHaveBeenCalledTimes(4); // no extra read: the replacement was not deleted by the old read's failure
  });

  it('too many addresses held: lists still being read (holding none) are not dropped for nothing', async () => {
    const never = () => new Promise<any[]>(() => undefined);
    states.mockImplementationOnce(never).mockImplementationOnce(never).mockImplementationOnce(never);
    for (const t of ['p1', 'p2', 'p3']) void findSubscriberAnyCase(t, 'x@example.com', T0);
    const big = (tag: string) => Array.from({ length: 100_000 }, (_, i) => ({ email: `${tag}${i}@example.com`, unsubscribed: false }));
    states.mockImplementationOnce(async () => big('a')).mockImplementationOnce(async () => big('b'));
    await findSubscriberAnyCase('big-a', 'nobody@example.com', T0 + 1);
    await findSubscriberAnyCase('big-b', 'nobody@example.com', T0 + 2);
    states.mockClear();
    void findSubscriberAnyCase('p1', 'x@example.com', T0 + 3); // still shared: it was not evicted to make room
    expect(states).not.toHaveBeenCalled();
    expect(subscriberLookupStats().rows).toBeLessThanOrEqual(150_000);
  });

  it('forgets a task\'s list on request, so a change made here is seen by the next caller', async () => {
    await findSubscriberAnyCase('t1', 'new@example.com', T0);
    states.mockResolvedValue([{ email: 'New@Example.com', unsubscribed: false }]);
    expect(await findSubscriberAnyCase('t1', 'new@example.com', T0 + 1000)).toBeNull(); // still the cached list
    forgetSubscriberLookup('t1');
    expect(await findSubscriberAnyCase('t1', 'new@example.com', T0 + 1000)).toMatchObject({ email: 'New@Example.com' });
  });

  it('does not keep a failed read: the next caller tries again, and the failing caller sees the error', async () => {
    states.mockRejectedValueOnce(new Error('dynamo down'));
    await expect(findSubscriberAnyCase('t1', 'jane.doe@example.com', T0)).rejects.toThrow('dynamo down');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await findSubscriberAnyCase('t1', 'jane.doe@example.com', T0 + 1)).toMatchObject({ email: 'Jane.Doe@Example.com' });
    expect(states).toHaveBeenCalledTimes(2);
  });

  it('copes with an empty or missing list and with rows that have no address', async () => {
    states.mockResolvedValueOnce(undefined);
    expect(await findSubscriberAnyCase('empty', 'a@example.com', T0)).toBeNull();
    states.mockResolvedValueOnce([{ unsubscribed: false }, null, { email: 'a@example.com' }]);
    expect(await findSubscriberAnyCase('odd', 'a@example.com', T0)).toEqual({ email: 'a@example.com' });
  });

  it('keeps at most a couple of hundred task lists, dropping the least recently used', async () => {
    for (let i = 0; i < 205; i++) await findSubscriberAnyCase(`task-${i}`, 'x@example.com', T0);
    expect(states).toHaveBeenCalledTimes(205);
    expect(subscriberLookupStats().tasks).toBeLessThanOrEqual(200);
    await findSubscriberAnyCase('task-204', 'x@example.com', T0); // recent: still kept
    expect(states).toHaveBeenCalledTimes(205);
    await findSubscriberAnyCase('task-0', 'x@example.com', T0); // oldest: was dropped
    expect(states).toHaveBeenCalledTimes(206);
  });

  it('a list that is used again stays, and an untouched one is dropped first (least recently used, not first inserted)', async () => {
    for (let i = 0; i < 200; i++) await findSubscriberAnyCase(`task-${i}`, 'x@example.com', T0);
    await findSubscriberAnyCase('task-0', 'x@example.com', T0 + 1); // used again: now the most recent
    await findSubscriberAnyCase('task-new', 'x@example.com', T0 + 2); // makes room by dropping the least recently used: task-1
    states.mockClear();
    await findSubscriberAnyCase('task-0', 'x@example.com', T0 + 3);
    expect(states).not.toHaveBeenCalled();
    await findSubscriberAnyCase('task-1', 'x@example.com', T0 + 3);
    expect(states).toHaveBeenCalledTimes(1);
  });

  it('bounds what it holds by the number of addresses, not only the number of tasks', async () => {
    const big = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ email: `${tag}${i}@example.com`, unsubscribed: false }));
    states.mockImplementation(async (taskId: string) => big(60_000, taskId));
    for (let i = 0; i < 6; i++) await findSubscriberAnyCase(`big-${i}`, 'nobody@example.com', T0);
    expect(subscriberLookupStats().rows).toBeLessThanOrEqual(150_000);
    expect(subscriberLookupStats().tasks).toBeLessThanOrEqual(2);
  });

  it('shares a list that is too big to keep between the callers waiting for it, then drops it', async () => {
    states.mockImplementation(async () => Array.from({ length: 200_000 }, (_, i) => ({ email: `p${i}@example.com`, unsubscribed: false })));
    const answers = await Promise.all(Array.from({ length: 5 }, () => findSubscriberAnyCase('huge', 'p7@example.com', T0)));
    expect(answers.every((row) => row?.email === 'p7@example.com')).toBe(true);
    expect(states).toHaveBeenCalledTimes(1);
    expect(subscriberLookupStats()).toEqual({ tasks: 0, rows: 0 });
  });

  it('forgets lists that have gone stale when another task is looked up (they do not sit in memory until the cap is reached)', async () => {
    await findSubscriberAnyCase('old', 'x@example.com', T0);
    await findSubscriberAnyCase('fresh', 'x@example.com', T0 + 60_000);
    expect(subscriberLookupStats().tasks).toBe(1);
  });
});
