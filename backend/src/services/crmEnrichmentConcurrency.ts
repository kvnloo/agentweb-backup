/**
 * Bounded-concurrency runner shared by the bulk CRM enrichment fan-outs
 * (find-emails, lookup-by-email). Per-item failures are isolated so one
 * worker rejection cannot kill the runner — callers handle their own
 * per-item error reporting.
 */
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const cap = Math.max(1, limit);
  let i = 0;
  const runners = Array.from({ length: Math.min(cap, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx]);
      } catch {
        // Worker is expected to handle its own errors; this catch is
        // belt-and-suspenders so one rejection doesn't kill the runner.
      }
    }
  });
  await Promise.all(runners);
}

/**
 * Concurrency cap for background bulk enrichment fan-out. Tuned to stay
 * well under enrich.so per-second rate limits while still finishing a
 * 1K-lead list in a few minutes.
 */
export const BULK_ENRICH_CONCURRENCY = 8;
