/**
 * ENG-1286 — background jobs must never bootstrap inside a Jest worker.
 *
 * `server.ts` schedules its whole cron bootstrap from inside `server.listen()`,
 * behind `setTimeout(..., 30000)`. Nothing in the test suite wants that, but it
 * runs anyway: `app.ts` registers `routes/crm.ts`, which imports `../server`,
 * so any test that touches `app` — `securityHeaders.test.ts`, for one — boots
 * the real server. Most crm tests `jest.mock('../server')` and escape it; the
 * ones that only import `app` do not.
 *
 * Thirty seconds later that test file is long finished and its environment torn
 * down, and the timer fires into whichever suite the worker has moved on to.
 * Each cron does `await import(...)` against a dead module registry, so its
 * callback resolves to undefined and throws `TypeError: <fn> is not a function`
 * — attributed to an innocent test that never went near cron code.
 *
 * Observed across four consecutive runs of one PR: a different victim each time
 * (`chatbotService.batchWriteRetry`, then a different test in the same file,
 * then `auth.effectiveAnalytics` as well), each passing in isolation. At the
 * time of filing, 19 of the 20 most recent CI runs repo-wide were failing on
 * this, across four authors' branches.
 *
 * The predicate below is what stops it. It is not "is this production" — it is
 * "may this process start work that outlives the caller".
 */

describe('shouldBootstrapBackgroundJobs (ENG-1286)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalWorkerId = process.env.JEST_WORKER_ID;

  /** Re-require so the module reads the env we just set, not the env at import. */
  const load = () => {
    let mod: typeof import('../instanceState');
    jest.isolateModules(() => {
      mod = require('../instanceState');
    });
    return mod!;
  };

  const setEnv = (nodeEnv?: string, workerId?: string) => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    if (workerId === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = workerId;
  };

  afterEach(() => {
    setEnv(originalNodeEnv, originalWorkerId);
  });

  describe('refuses to bootstrap where a leaked timer can outlive its caller', () => {
    it('is false under NODE_ENV=test', () => {
      setEnv('test', undefined);
      expect(load().shouldBootstrapBackgroundJobs()).toBe(false);
    });

    it('is false inside a Jest worker even when NODE_ENV says production', () => {
      // The failing CI job runs the suite in workers. If a runner ever leaves
      // NODE_ENV unset or set to something else, the worker id is the signal
      // that still holds — so it is checked independently, not as a fallback.
      setEnv('production', '3');
      expect(load().shouldBootstrapBackgroundJobs()).toBe(false);
    });

    it('is false when the worker id is set but empty', () => {
      // The case that actually distinguishes `=== undefined` from a truthiness
      // check: '' is falsy, so `!process.env.JEST_WORKER_ID` would call this
      // "not a worker" and bootstrap anyway. Only an ABSENT variable qualifies.
      setEnv('production', '');
      expect(load().shouldBootstrapBackgroundJobs()).toBe(false);
    });

    it('is false inside worker 0', () => {
      // '0' is a non-empty string and therefore truthy, so this passes under
      // either implementation — kept because worker 0 is a real worker and the
      // rule is "any defined value means inside a worker".
      setEnv('production', '0');
      expect(load().shouldBootstrapBackgroundJobs()).toBe(false);
    });

    it('is false when NODE_ENV is unset but a worker id is present', () => {
      setEnv(undefined, '1');
      expect(load().shouldBootstrapBackgroundJobs()).toBe(false);
    });
  });

  describe('still bootstraps everywhere the server actually runs', () => {
    it('is true in production', () => {
      setEnv('production', undefined);
      expect(load().shouldBootstrapBackgroundJobs()).toBe(true);
    });

    it('is true in development', () => {
      setEnv('development', undefined);
      expect(load().shouldBootstrapBackgroundJobs()).toBe(true);
    });

    it('is true in staging', () => {
      setEnv('staging', undefined);
      expect(load().shouldBootstrapBackgroundJobs()).toBe(true);
    });

    it('is true when NODE_ENV is unset outside a worker', () => {
      // A bare `node dist/server.js` with no NODE_ENV must still run its crons.
      // Defaulting this to "don't bootstrap" would silently stop every cron in
      // production — a far worse failure than the flake being fixed.
      setEnv(undefined, undefined);
      expect(load().shouldBootstrapBackgroundJobs()).toBe(true);
    });
  });
});
