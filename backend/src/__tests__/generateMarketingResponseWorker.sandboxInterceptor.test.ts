/**
 * ENG-1912: this worker is a SEPARATE forked process (child_process.fork), so
 * server.ts's installSandboxMetaInterceptorAtBoot() call in the main process's
 * listen() callback never runs here — found live in production when a sandbox
 * principal's call_meta_ads_insights_api tool call (which runs inside this worker)
 * reached the real graph.facebook.com with its sentinel token. This pins that the
 * worker module now installs the interceptor itself, guarded the same way
 * server.ts guards its own call (skip under the Jest test-boot path).
 */

const installSandboxMetaInterceptorAtBoot = jest.fn();
jest.mock('../services/sandbox/bootstrap', () => ({ installSandboxMetaInterceptorAtBoot }));

const shouldBootstrapBackgroundJobs = jest.fn();
jest.mock('../utils/instanceState', () => ({ shouldBootstrapBackgroundJobs }));

jest.mock('../services/agentModeService', () => ({
  agentModeService: { initialize: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../workers/workerShutdownGuards', () => ({ installWorkerShutdownGuards: jest.fn() }));

describe('generateMarketingResponseWorker — sandbox interceptor boot wiring', () => {
  let originalSend: any;

  beforeEach(() => {
    jest.resetModules();
    installSandboxMetaInterceptorAtBoot.mockClear();
    shouldBootstrapBackgroundJobs.mockClear();
    originalSend = process.send;
    process.send = jest.fn() as any;
    jest.spyOn(process, 'on').mockImplementation((() => process) as any);
  });

  afterEach(() => {
    process.send = originalSend;
    (process.on as any).mockRestore?.();
  });

  it('installs the sandbox Meta interceptor when running as a real background worker', () => {
    shouldBootstrapBackgroundJobs.mockReturnValue(true);
    require('../workers/generateMarketingResponseWorker');
    expect(installSandboxMetaInterceptorAtBoot).toHaveBeenCalledTimes(1);
  });

  it('does not install the interceptor under the Jest test-boot path', () => {
    shouldBootstrapBackgroundJobs.mockReturnValue(false);
    require('../workers/generateMarketingResponseWorker');
    expect(installSandboxMetaInterceptorAtBoot).not.toHaveBeenCalled();
  });

  it('logs and swallows an install failure rather than crashing the worker', () => {
    shouldBootstrapBackgroundJobs.mockReturnValue(true);
    installSandboxMetaInterceptorAtBoot.mockImplementation(() => { throw new Error('boom'); });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => require('../workers/generateMarketingResponseWorker')).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('[Worker] Failed to install sandbox Meta interceptor:', 'boom');
    errorSpy.mockRestore();
  });
});
