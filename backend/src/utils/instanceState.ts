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
 * True when this process is a Jest worker.
 *
 * ENG-1286: `server.ts` binds a port and registers ~21 background timers inside its
 * `listen` callback. Importing the module runs all of that, and two suites import it for
 * its Socket.IO instance. Those timers then outlive the Jest environment that created
 * them, fire after teardown, and resolve module references that no longer exist —
 * surfacing as `TypeError: <fn> is not a function` inside whatever unrelated test happens
 * to occupy that worker next. The failure lands nowhere near its cause, moves file to file
 * between runs, and is invisible when any single suite runs alone.
 *
 * `JEST_WORKER_ID` is set by Jest in every worker, including `--runInBand`, and is the
 * signal least likely to be wrong: NODE_ENV is set by deploy tooling and has already been
 * observed carrying values other than 'test' in local runs, so it is checked as a
 * secondary rather than relied on alone.
 *
 * This is deliberately narrow. It gates process-level side effects at startup, and must
 * never be used to change behaviour inside a unit under test — a test that passes only
 * because the code detected a test is worse than no test.
 */
export const isTestRuntime = (): boolean =>
  process.env.JEST_WORKER_ID !== undefined || process.env.NODE_ENV === 'test';
