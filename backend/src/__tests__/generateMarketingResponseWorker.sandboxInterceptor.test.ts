/**
 * ENG-1912: this worker is a SEPARATE forked process (child_process.fork), so
 * server.ts's installSandboxMetaInterceptorAtBoot() call in the main process's
 * listen() callback never runs here — found live in production when a sandbox
 * principal's call_meta_ads_insights_api tool call (which runs inside this worker)
 * reached the real graph.facebook.com with its sentinel token. This pins that the
 * worker module now installs the interceptor itself as part of the same
 * initialization chain agentModeService.initialize() runs in, guarded the same way
 * server.ts guards its own call (skip under the Jest test-boot path) — and that,
 * unlike server.ts's own call, a failed install here fails the whole worker rather
 * than continuing to serve tool calls unprotected.
 */

const installSandboxMetaInterceptorAtBoot = jest.fn();
jest.mock('../services/sandbox/bootstrap', () => ({ installSandboxMetaInterceptorAtBoot }));

const shouldBootstrapBackgroundJobs = jest.fn();
jest.mock('../utils/instanceState', () => ({ shouldBootstrapBackgroundJobs }));

const initialize = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/agentModeService', () => ({ agentModeService: { initialize } }));
jest.mock('../workers/workerShutdownGuards', () => ({ installWorkerShutdownGuards: jest.fn() }));

/** Flushes the microtask queue so the module's own async ensureInitialized() chain settles. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('generateMarketingResponseWorker — sandbox interceptor boot wiring', () => {
  let originalSend: any;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    installSandboxMetaInterceptorAtBoot.mockReset();
    shouldBootstrapBackgroundJobs.mockReset();
    initialize.mockClear();
    originalSend = process.send;
    process.send = jest.fn() as any;
    jest.spyOn(process, 'on').mockImplementation((() => process) as any);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    process.send = originalSend;
    (process.on as any).mockRestore?.();
    exitSpy.mockRestore();
  });

  it('installs the sandbox Meta interceptor before agentModeService.initialize() when running as a real background worker', async () => {
    shouldBootstrapBackgroundJobs.mockReturnValue(true);
    require('../workers/generateMarketingResponseWorker');
    await flush();
    expect(installSandboxMetaInterceptorAtBoot).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(installSandboxMetaInterceptorAtBoot.mock.invocationCallOrder[0])
      .toBeLessThan(initialize.mock.invocationCallOrder[0]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does not install the interceptor under the Jest test-boot path', async () => {
    shouldBootstrapBackgroundJobs.mockReturnValue(false);
    require('../workers/generateMarketingResponseWorker');
    await flush();
    expect(installSandboxMetaInterceptorAtBoot).not.toHaveBeenCalled();
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('exits the worker rather than continuing to serve tool calls unprotected when the install fails', async () => {
    shouldBootstrapBackgroundJobs.mockReturnValue(true);
    installSandboxMetaInterceptorAtBoot.mockImplementation(() => { throw new Error('boom'); });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    require('../workers/generateMarketingResponseWorker');
    await flush();
    expect(initialize).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    errorSpy.mockRestore();
  });
});
