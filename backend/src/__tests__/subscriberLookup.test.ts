/**
 * ENG-2991: finding a subscriber by address in any letter case needs the task's address list, which can be large and which anyone holding a
 * confirmation link can ask for again and again. It is read narrowly, shared between simultaneous callers, kept briefly, and never kept when
 * it failed.
 */
jest.mock('../services/db', () => ({
  subscriberDb: { getTaskSubscriberStates: jest.fn() },
}));

import { subscriberDb } from '../services/db';
import { findSubscriberAnyCase, forgetSubscriberLookup, clearSubscriberLookups } from '../services/subscriberLookup';

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

  it('keeps the list for 30 seconds, then reads it again', async () => {
    await findSubscriberAnyCase('t1', 'jane.doe@example.com', T0);
    await findSubscriberAnyCase('t1', 'jane.doe@example.com', T0 + 29_000);
    expect(states).toHaveBeenCalledTimes(1);
    await findSubscriberAnyCase('t1', 'jane.doe@example.com', T0 + 31_000);
    expect(states).toHaveBeenCalledTimes(2);
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

  it('keeps at most a couple of hundred task lists, dropping the oldest', async () => {
    for (let i = 0; i < 205; i++) await findSubscriberAnyCase(`task-${i}`, 'x@example.com', T0);
    expect(states).toHaveBeenCalledTimes(205);
    await findSubscriberAnyCase('task-204', 'x@example.com', T0); // recent: still kept
    expect(states).toHaveBeenCalledTimes(205);
    await findSubscriberAnyCase('task-0', 'x@example.com', T0); // oldest: was dropped
    expect(states).toHaveBeenCalledTimes(206);
  });
});
