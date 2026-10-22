/**
 * ENG-2371 AC1/AC3: 3 successes, a turn deadline, a simulated restart (fresh runner over
 * the same store), and the 4th unit completes exactly once with no second customer
 * message; every asset attaches to the original session; structured logs are emitted.
 */
import {
  InMemoryMediaBatchStore,
  MediaBatchLogEvent,
  RunDeps,
  runMediaBatch,
  startMediaBatch,
} from '../mediaBatchContinuation';

function harness(store: InMemoryMediaBatchStore, clock: { t: number }) {
  const generated: string[] = [];
  const attached: Array<{ sessionId: string; assetId: string; unitIndex: number }> = [];
  const notices: string[] = [];
  const scheduled: string[] = [];
  const logs: MediaBatchLogEvent[] = [];
  const deps: RunDeps = {
    store,
    generate: async (input, key) => {
      generated.push(key);
      clock.t += 1_000;
      return { ok: true, assetId: `asset-${String(input.prompt)}` };
    },
    attachAsset: async (sessionId, assetId, unitIndex) => {
      attached.push({ sessionId, assetId, unitIndex });
    },
    notifyComplete: async (sessionId) => {
      notices.push(sessionId);
    },
    scheduleContinuation: (id) => scheduled.push(id),
    now: () => clock.t,
    log: (e) => logs.push(e),
  };
  return { deps, generated, attached, notices, scheduled, logs };
}

const inputs = [1, 2, 3, 4].map((n) => ({ prompt: `img${n}` }));

describe('ENG-2371 automatic media-batch continuation', () => {
  it('resumes the 4th image after a deadline + restart exactly once, no second customer message', async () => {
    const store = new InMemoryMediaBatchStore();
    const clock = { t: 0 };
    await startMediaBatch(store, 'sess-1', 'batch-1', inputs);

    const turn1 = harness(store, clock);
    // Deadline lands after the 3rd unit finishes (each unit takes 1s).
    const r1 = await runMediaBatch('batch-1', 3_000, turn1.deps);
    expect(r1).toBe('continuing');
    expect(turn1.generated).toHaveLength(3);
    expect(turn1.scheduled).toEqual(['batch-1']);
    expect(turn1.notices).toHaveLength(0);

    // Simulated restart: new runner, same store.
    const turn2 = harness(store, clock);
    const r2 = await runMediaBatch('batch-1', clock.t + 60_000, turn2.deps);
    expect(r2).toBe('complete');
    expect(turn2.generated).toHaveLength(1);
    expect(turn2.notices).toEqual(['sess-1']);

    // Replaying the continuation is a no-op: nothing regenerated, no second notice.
    const turn3 = harness(store, clock);
    expect(await runMediaBatch('batch-1', clock.t + 60_000, turn3.deps)).toBe('complete');
    expect(turn3.generated).toHaveLength(0);
    expect(turn3.notices).toHaveLength(0);

    const allAttached = [...turn1.attached, ...turn2.attached];
    expect(allAttached.map((a) => a.assetId).sort()).toEqual(['asset-img1', 'asset-img2', 'asset-img3', 'asset-img4']);
    expect(new Set(allAttached.map((a) => a.sessionId))).toEqual(new Set(['sess-1']));
    expect(new Set([...turn1.generated, ...turn2.generated]).size).toBe(4);
  });

  it('emits per-unit duration, retry count, outcome and batch completion logs', async () => {
    const store = new InMemoryMediaBatchStore();
    const clock = { t: 0 };
    await startMediaBatch(store, 'sess-2', 'batch-2', inputs.slice(0, 2));
    const h = harness(store, clock);
    let first = true;
    h.deps.generate = async (input) => {
      clock.t += 500;
      if (first) {
        first = false;
        return { ok: false, retryable: true, reason: 'provider 503' };
      }
      return { ok: true, assetId: `asset-${String(input.prompt)}` };
    };
    // Retry backoff makes the failed unit not runnable yet -> continuation scheduled.
    expect(await runMediaBatch('batch-2', 100_000, h.deps)).toBe('continuing');
    clock.t += 10_000;
    expect(await runMediaBatch('batch-2', clock.t + 100_000, h.deps)).toBe('complete');

    const units = h.logs.filter((l) => l.event === 'media_batch_unit');
    expect(units[0]).toMatchObject({ unitIndex: 0, outcome: 'failed_retryable', retryCount: 0, durationMs: 500 });
    expect(units.find((u) => u.event === 'media_batch_unit' && u.unitIndex === 0 && u.outcome === 'succeeded'))
      .toMatchObject({ retryCount: 1 });
    expect(h.logs.filter((l) => l.event === 'media_batch_complete')).toEqual([
      { event: 'media_batch_complete', batchId: 'batch-2', sessionId: 'sess-2', succeeded: 2, failed: 0, total: 2 },
    ]);
  });

  it('records a rejected provider call as retryable instead of stranding the lease', async () => {
    const store = new InMemoryMediaBatchStore();
    const clock = { t: 0 };
    await startMediaBatch(store, 'sess-r', 'batch-r', [{ prompt: 'x' }]);
    const h = harness(store, clock);
    let first = true;
    h.deps.generate = async () => {
      clock.t += 1_000;
      if (first) {
        first = false;
        throw new Error('provider 500');
      }
      return { ok: true, assetId: 'asset-x' };
    };
    const r = await runMediaBatch('batch-r', 1_500, h.deps);
    expect(r).toBe('continuing');
    const rec = await store.get('batch-r');
    expect(rec?.batch.units[0].state).not.toBe('running');
  });

  it('retries the completion notice when notification fails, and sends it once after success', async () => {
    const store = new InMemoryMediaBatchStore();
    const clock = { t: 0 };
    await startMediaBatch(store, 'sess-n', 'batch-n', [{ prompt: 'y' }]);
    const h = harness(store, clock);
    h.deps.notifyComplete = async () => {
      throw new Error('slack down');
    };
    await expect(runMediaBatch('batch-n', 60_000, h.deps)).rejects.toThrow('slack down');
    expect((await store.get('batch-n'))?.completionNotified).toBe(false);
    const h2 = harness(store, clock);
    expect(await runMediaBatch('batch-n', 60_000, h2.deps)).toBe('complete');
    expect(h2.notices).toEqual(['sess-n']);
    expect(h2.generated).toHaveLength(0);
  });

  it('serializes concurrent continuations of the same batch (no duplicate generation)', async () => {
    const store = new InMemoryMediaBatchStore();
    const clock = { t: 0 };
    await startMediaBatch(store, 'sess-c', 'batch-c', [{ prompt: 'z' }]);
    const a = harness(store, clock);
    const b = harness(store, clock);
    await Promise.all([runMediaBatch('batch-c', 60_000, a.deps), runMediaBatch('batch-c', 60_000, b.deps)]);
    expect(a.generated.length + b.generated.length).toBe(1);
    expect(a.notices.length + b.notices.length).toBe(1);
  });
});
