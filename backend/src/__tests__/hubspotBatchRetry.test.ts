import { splitAndRetry } from '../utils/hubspotBatchRetry';

describe('splitAndRetry', () => {
  // 1. All items succeed in one pass → failed empty; assert chunk sizes.
  it('processes all items in chunks of maxBatchSize and records no failures when all succeed', async () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const batchSizes: number[] = [];
    const runBatch = jest.fn(async (batch: number[]) => {
      batchSizes.push(batch.length);
    });

    const result = await splitAndRetry(items, runBatch, { maxBatchSize: 100 });

    expect(result.failed).toEqual([]);
    expect(batchSizes).toEqual([100, 100, 50]);
    expect(runBatch).toHaveBeenCalledTimes(3);
  });

  // 2. Empty items → runBatch never called, failed empty.
  it('returns empty failed and never calls runBatch for empty items', async () => {
    const runBatch = jest.fn(async () => {});

    const result = await splitAndRetry([], runBatch, { maxBatchSize: 100 });

    expect(result.failed).toEqual([]);
    expect(runBatch).not.toHaveBeenCalled();
  });

  // 3. One bad item in a 100-chunk → split-and-retry isolates exactly that one item.
  it('isolates a single bad item via split-and-retry while the rest succeed', async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const badItem = 42;
    const runBatch = jest.fn(async (batch: number[]) => {
      if (batch.includes(badItem)) {
        throw new Error(`batch contains bad item ${badItem}`);
      }
    });

    const result = await splitAndRetry(items, runBatch, { maxBatchSize: 100 });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].item).toBe(badItem);
    expect(result.failed[0].error).toBeInstanceOf(Error);
  });

  // 4. Multiple bad items isolated correctly.
  it('isolates multiple bad items', async () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const badItems = new Set([7, 42, 88]);
    const runBatch = jest.fn(async (batch: number[]) => {
      if (batch.some((x) => badItems.has(x))) {
        throw new Error('batch contains a bad item');
      }
    });

    const result = await splitAndRetry(items, runBatch, { maxBatchSize: 100 });

    const failedItems = result.failed.map((f) => f.item).sort((a, b) => a - b);
    expect(failedItems).toEqual([7, 42, 88]);
    result.failed.forEach((f) => expect(f.error).toBeInstanceOf(Error));
  });

  // 5. A size-1 batch that fails is recorded (terminal).
  it('records a failing size-1 batch as terminal', async () => {
    const items = [99];
    const theError = new Error('always fails');
    const runBatch = jest.fn(async () => {
      throw theError;
    });

    const result = await splitAndRetry(items, runBatch, { maxBatchSize: 100 });

    expect(result.failed).toEqual([{ item: 99, error: theError }]);
    expect(runBatch).toHaveBeenCalledTimes(1);
  });

  // 6. onSplit is invoked when a multi-item batch fails (and not for size-1 failures).
  it('calls onSplit on multi-item batch failures but not on size-1 failures', async () => {
    const items = [1, 2];
    const onSplit = jest.fn();
    // The whole batch [1,2] fails (multi-item) → onSplit called once with (2, error).
    // It splits into [1] and [2], each size-1 and failing → recorded, no onSplit.
    const runBatch = jest.fn(async () => {
      throw new Error('fail');
    });

    const result = await splitAndRetry(items, runBatch, {
      maxBatchSize: 100,
      onSplit,
    });

    expect(result.failed.map((f) => f.item).sort()).toEqual([1, 2]);
    expect(onSplit).toHaveBeenCalledTimes(1);
    expect(onSplit).toHaveBeenCalledWith(2, expect.any(Error));
  });

  it('does not call onSplit when all batches succeed', async () => {
    const items = [1, 2, 3];
    const onSplit = jest.fn();
    const runBatch = jest.fn(async () => {});

    await splitAndRetry(items, runBatch, { maxBatchSize: 100, onSplit });

    expect(onSplit).not.toHaveBeenCalled();
  });

  it('does not require onSplit (optional) when a multi-item batch fails', async () => {
    const items = [1, 2];
    const runBatch = jest.fn(async (batch: number[]) => {
      // Only item 2 is bad.
      if (batch.includes(2)) {
        throw new Error('fail');
      }
    });

    const result = await splitAndRetry(items, runBatch, { maxBatchSize: 100 });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].item).toBe(2);
  });

  // 7. Chunks processed sequentially (assert ordering).
  it('processes chunks sequentially, never concurrently', async () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    const events: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const runBatch = jest.fn(async (batch: number[]) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      events.push(`start:${batch[0]}-${batch[batch.length - 1]}`);
      // Yield to the event loop to expose any accidental concurrency.
      await new Promise((resolve) => setTimeout(resolve, 0));
      events.push(`end:${batch[0]}-${batch[batch.length - 1]}`);
      inFlight -= 1;
    });

    await splitAndRetry(items, runBatch, { maxBatchSize: 100 });

    expect(maxInFlight).toBe(1);
    expect(events).toEqual([
      'start:0-99',
      'end:0-99',
      'start:100-199',
      'end:100-199',
      'start:200-249',
      'end:200-249',
    ]);
  });

  it('splits an odd-sized failing batch using floor(n/2)', async () => {
    // A 3-item batch that fails should split into halves of size floor(3/2)=1 and 2.
    const items = [10, 20, 30];
    const observedBatches: number[][] = [];
    const runBatch = jest.fn(async (batch: number[]) => {
      observedBatches.push([...batch]);
      // Fail only when item 30 is present so we force at least one split.
      if (batch.includes(30)) {
        throw new Error('fail');
      }
    });

    const result = await splitAndRetry(items, runBatch, { maxBatchSize: 3 });

    // Whole batch [10,20,30] fails → split into [10] and [20,30].
    expect(observedBatches).toContainEqual([10, 20, 30]);
    expect(observedBatches).toContainEqual([10]);
    expect(observedBatches).toContainEqual([20, 30]);
    expect(observedBatches).toContainEqual([30]);
    expect(result.failed.map((f) => f.item)).toEqual([30]);
  });
});
