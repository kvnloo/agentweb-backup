/**
 * Serialize async critical sections per key WITHIN this process. Calls sharing a key run
 * one-at-a-time in arrival order; different keys run concurrently.
 *
 * ENG-510: chat-message appends do a read-modify-write (read the current message count,
 * then write at that index). When a single turn generates image variants in parallel, each
 * completed image persists its marker concurrently — without serialization two writes read
 * the same count and Put to the same messageIndex, so the later one overwrites the earlier
 * and a marker is lost. Wrapping the append critical section in this mutex (keyed by
 * session) makes those writes atomic per session.
 *
 * In-process only, which is sufficient here: a session's generation is guarded by
 * tryClaimSessionGeneration to a single in-flight run, so all of a session's concurrent
 * appends originate in one process. Different processes/instances never write the same
 * session concurrently.
 */
const tails = new Map<string, Promise<void>>();

export function withKeyedMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // Run fn only after the previous critical section for this key settles (success OR
  // failure) — prev already swallows its own errors, so fn always runs.
  const run = prev.then(fn, fn);
  // The tail others await. Swallow errors so one failed section doesn't reject the chain
  // for everyone queued behind it.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  // Once this is the last queued section for the key, drop the entry so the map can't grow
  // without bound. Guarded by identity so a newer waiter's tail is never deleted.
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  // Propagate fn's real result/rejection to the caller (NOT the error-swallowed tail).
  return run;
}

/** Test-only: number of keys currently tracked, to assert the map does not leak. */
export function _keyedMutexTrackedKeys(): number {
  return tails.size;
}
