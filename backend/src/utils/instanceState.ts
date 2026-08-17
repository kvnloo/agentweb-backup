/**
 * Instance-local state for graceful shutdown coordination.
 *
 * cronEnabled starts true on every new instance. gracefulShutdown() calls
 * disableCron() as its very first action so that:
 *   - /run-scheduled-chats returns 503 immediately (agent-engine reroutes to
 *     the new instance within one 5-second poll cycle)
 *   - every setInterval/setTimeout background worker skips its next tick
 *
 * This flag is intentionally in-memory only — no DynamoDB or Redis needed.
 * Each new instance always starts with cronEnabled = true.
 */

let cronEnabled = true;

export const isCronEnabled = (): boolean => cronEnabled;

export const disableCron = (): void => {
  cronEnabled = false;
  console.log('[instanceState] Cron disabled — instance is draining, no new scheduled work accepted');
};

/**
 * May this process start background work that outlives the caller? (ENG-1286)
 *
 * `server.ts` schedules its cron bootstrap from inside `server.listen()`, behind
 * a 30-second `setTimeout`. Under Jest that is a time bomb: `app.ts` registers
 * `routes/crm.ts`, which imports `../server`, so any test touching `app` boots
 * the real server. Thirty seconds later that test file has finished and its
 * environment is torn down, and the timer fires into whichever suite the worker
 * moved on to — where every `await import(...)` returns a dead module and the
 * cron throws `TypeError: <fn> is not a function`, blaming an innocent test.
 *
 * Deliberately two independent signals rather than one with a fallback: the
 * worker id catches a runner that leaves NODE_ENV unset or lying. And
 * deliberately compared against `undefined` rather than tested for truthiness,
 * so that ANY defined value means "inside a worker". Truthiness would read
 * `JEST_WORKER_ID=''` as "not a worker" and bootstrap anyway; only an absent
 * variable should qualify. ('0' is a non-empty string and therefore truthy —
 * it is not the case that distinguishes the two, '' is.)
 *
 * The unset-NODE_ENV case must stay TRUE: a bare `node dist/server.js` has to
 * keep running its crons. Failing closed there would silently kill every
 * scheduled job in production, which is far worse than the flake this fixes.
 */
export const shouldBootstrapBackgroundJobs = (): boolean =>
  process.env.NODE_ENV !== 'test' && process.env.JEST_WORKER_ID === undefined;
