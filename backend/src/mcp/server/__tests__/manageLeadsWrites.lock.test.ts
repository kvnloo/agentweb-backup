/** ENG-2840 PR B: withLeadLock runs work for one key one at a time, in arrival order; other keys are not held up; a failure does not block the next; nothing is kept afterwards. */
import { withLeadLock } from '../manageLeadsWrites';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('withLeadLock', () => {
  it('runs calls for the same key one at a time, in the order they arrived', async () => {
    const log: string[] = [];
    const task = (name: string, ms: number) => withLeadLock('k', async () => { log.push(`start ${name}`); await tick(ms); log.push(`end ${name}`); return name; });
    const results = await Promise.all([task('a', 20), task('b', 1), task('c', 5)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('does not hold up other keys', async () => {
    const log: string[] = [];
    const slow = withLeadLock('one', async () => { log.push('slow start'); await tick(30); log.push('slow end'); });
    await tick(2);
    await withLeadLock('two', async () => { log.push('other'); });
    await slow;
    expect(log).toEqual(['slow start', 'other', 'slow end']);
  });

  it('a failing call passes its error on and does not block the next one', async () => {
    const failing = withLeadLock('k', async () => { throw new Error('boom'); });
    const next = withLeadLock('k', async () => 'ran');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ran');
  });

  it('returns each call\'s own value and leaves nothing queued behind for a key that has gone idle', async () => {
    expect(await withLeadLock('idle', async () => 42)).toBe(42);
    // A later call for the same key starts at once (nothing is waiting on a finished chain).
    const started = jest.fn();
    await withLeadLock('idle', async () => { started(); });
    expect(started).toHaveBeenCalledTimes(1);
  });
});
