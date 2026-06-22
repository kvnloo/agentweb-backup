export interface SplitAndRetryOptions {
  maxBatchSize: number;
  /**
   * Max number of top-level batches to run at once (default 1 = sequential).
   * Only the initial maxBatchSize chunks are parallelised; a failed batch's
   * bisection retries always run sequentially within that batch's subtree.
   * Keep this modest to stay within the provider's rate limits.
   */
  concurrency?: number;
  /** Called whenever a multi-item batch fails and is about to be split, for logging. */
  onSplit?: (failedBatchSize: number, error: unknown) => void;
}

export interface SplitAndRetryResult<T> {
  /** Items that still failed when isolated to a batch of size 1, with their error. */
  failed: Array<{ item: T; error: unknown }>;
}

/**
 * Processes `items` by calling `runBatch` on chunks of up to maxBatchSize.
 * `runBatch` performs the side-effecting work (e.g. an API call) and RESOLVES if the
 * whole batch succeeded, or REJECTS (throws) if the whole batch failed.
 * On a batch failure: if the batch has 1 item, record it in `failed`; otherwise split
 * the batch into two halves and retry each half recursively. This isolates the
 * genuinely-bad item(s) while letting good items succeed.
 * Chunks are processed SEQUENTIALLY (await each before the next) — never concurrently.
 */
export async function splitAndRetry<T>(
  items: T[],
  runBatch: (batch: T[]) => Promise<void>,
  options: SplitAndRetryOptions
): Promise<SplitAndRetryResult<T>> {
  const failed: Array<{ item: T; error: unknown }> = [];

  // Process a single chunk: run it, and on failure either record (size 1) or split.
  const processChunk = async (chunk: T[]): Promise<void> => {
    try {
      await runBatch(chunk);
    } catch (error) {
      if (chunk.length === 1) {
        failed.push({ item: chunk[0], error });
        return;
      }
      options.onSplit?.(chunk.length, error);
      const mid = Math.floor(chunk.length / 2);
      const left = chunk.slice(0, mid);
      const right = chunk.slice(mid);
      await processChunk(left);
      await processChunk(right);
    }
  };

  // Split items into consecutive chunks of maxBatchSize.
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += options.maxBatchSize) {
    chunks.push(items.slice(i, i + options.maxBatchSize));
  }

  // Process the top-level chunks with bounded concurrency (default 1 =
  // sequential). Workers pull from a shared cursor so at most `limit` chunks
  // are in flight at once; processChunk itself awaits its (sequential) bisection.
  const limit = Math.max(1, Math.min(options.concurrency ?? 1, chunks.length));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      await processChunk(chunk);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));

  return { failed };
}
