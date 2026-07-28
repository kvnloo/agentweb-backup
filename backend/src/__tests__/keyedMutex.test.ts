import { withKeyedMutex, _keyedMutexTrackedKeys } from '../utils/keyedMutex';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('withKeyedMutex', () => {
  it('serializes same-key sections so a read-modify-write cannot interleave', async () => {
    // Shared counter modeling addMessageToSession: read, await, write at the read index.
    let store: number[] = [];
    const appendRaced = async (v: number) => {
      const idx = store.length; // read count
      await tick(5); // simulate DB round-trip window where a race would occur
      store[idx] = v; // write at that index — collides if two read the same idx
    };

    // Without the mutex, 3 concurrent appends all read idx 0 and clobber → length 1.
    store = [];
    await Promise.all([appendRaced(1), appendRaced(2), appendRaced(3)]);
    expect(store.filter((x) => x !== undefined).length).toBe(1); // demonstrates the race

    // With the mutex, the same 3 concurrent calls serialize → all 3 land, no collision.
    store = [];
    await Promise.all([
      withKeyedMutex('s1', () => appendRaced(1)),
      withKeyedMutex('s1', () => appendRaced(2)),
      withKeyedMutex('s1', () => appendRaced(3)),
    ]);
    expect(store.length).toBe(3);
    expect([...store].sort()).toEqual([1, 2, 3]);
  });

  it('runs different keys concurrently', async () => {
    const order: string[] = [];
    await Promise.all([
      withKeyedMutex('a', async () => { await tick(20); order.push('a'); }),
      withKeyedMutex('b', async () => { await tick(5); order.push('b'); }),
    ]);
    // b (shorter) finishes first because different keys don't block each other.
    expect(order).toEqual(['b', 'a']);
  });

  it('preserves arrival order within a key', async () => {
    const order: number[] = [];
    await Promise.all([
      withKeyedMutex('k', async () => { await tick(15); order.push(1); }),
      withKeyedMutex('k', async () => { await tick(1); order.push(2); }),
      withKeyedMutex('k', async () => { await tick(1); order.push(3); }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('propagates the result and rejection of the wrapped fn to its own caller', async () => {
    await expect(withKeyedMutex('r', async () => 42)).resolves.toBe(42);
    await expect(withKeyedMutex('r', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });

  it('a failing section does not break the next queued section for the same key', async () => {
    const results: string[] = [];
    const p1 = withKeyedMutex('e', async () => { throw new Error('x'); }).catch(() => results.push('failed'));
    const p2 = withKeyedMutex('e', async () => { results.push('ran'); });
    await Promise.all([p1, p2]);
    expect(results).toEqual(['failed', 'ran']);
  });

  it('does not leak keys after all sections settle', async () => {
    await withKeyedMutex('leak-check', async () => tick(1));
    await tick(5); // let the cleanup microtask run
    expect(_keyedMutexTrackedKeys()).toBe(0);
  });
});
