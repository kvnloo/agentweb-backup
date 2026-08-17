/**
 * ENG-1286 — the guard that stops server.ts leaking timers into Jest workers.
 *
 * The bug it exists for: server.ts binds a port and registers ~21 background timers inside
 * its `listen` callback. Importing the module runs all of it, and two suites import it for
 * its Socket.IO instance. Those timers outlive the Jest environment that created them, fire
 * after teardown, and resolve module references that no longer exist — surfacing as
 * `TypeError: <fn> is not a function` inside whatever unrelated suite occupies that worker
 * next. Observed victims included admin.freezeUserAccount, settings.replaySessions,
 * admin.seoAeoResolve and chatbotService.batchWriteRetry: four files with nothing in common
 * except bad luck in worker scheduling.
 */

import { isTestRuntime } from '../utils/instanceState';

describe('isTestRuntime', () => {
  const savedWorker = process.env.JEST_WORKER_ID;
  const savedNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (savedWorker === undefined) delete process.env.JEST_WORKER_ID;
    else process.env.JEST_WORKER_ID = savedWorker;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it('is true inside the suite that is running right now', () => {
    // The load-bearing assertion. If this is ever false, the guard is inert and the leak
    // is back — with no other symptom until an unrelated suite starts failing.
    expect(isTestRuntime()).toBe(true);
  });

  it('detects a Jest worker even when NODE_ENV says otherwise', () => {
    // NODE_ENV is set by deploy tooling and has been observed carrying values other than
    // 'test' in local runs, so it cannot be the only signal.
    process.env.JEST_WORKER_ID = '3';
    process.env.NODE_ENV = 'development';
    expect(isTestRuntime()).toBe(true);
  });

  it('detects NODE_ENV=test even with no worker id', () => {
    // --runInBand and non-Jest test harnesses.
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'test';
    expect(isTestRuntime()).toBe(true);
  });

  it('is FALSE in a normal server process, so production still starts', () => {
    // The other half of the contract: this guard skips binding the port and registering
    // every background job, so a false positive in production would silently disable all
    // cron work while the process looked healthy.
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = 'production';
    expect(isTestRuntime()).toBe(false);
  });

  it('is FALSE when neither signal is present', () => {
    delete process.env.JEST_WORKER_ID;
    delete process.env.NODE_ENV;
    expect(isTestRuntime()).toBe(false);
  });
});
