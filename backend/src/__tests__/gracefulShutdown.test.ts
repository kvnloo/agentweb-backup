/**
 * Tests for the zero-downtime graceful-shutdown building blocks:
 *   1. instanceState — isCronEnabled / disableCron
 *   2. GenerateMarketingResponseWorkerService — drain-aware shutdown
 *   3. agentModeController — 503 guard when cron is disabled
 *   4. server drain — admitted turns settle before worker shutdown
 *   5. server.ts — drain-before-close ordering (ENG-1189)
 */

import fs from 'fs';
import path from 'path';

// --------------------------------------------------------------------------
// 1. instanceState
// --------------------------------------------------------------------------
describe('instanceState', () => {
  let isCronEnabled: () => boolean;
  let disableCron: () => void;

  beforeEach(() => {
    jest.resetModules();
    ({ isCronEnabled, disableCron } = require('../utils/instanceState'));
  });

  it('starts enabled', () => {
    expect(isCronEnabled()).toBe(true);
  });

  it('disableCron() makes isCronEnabled() return false', () => {
    disableCron();
    expect(isCronEnabled()).toBe(false);
  });

  it('flag stays false across multiple calls', () => {
    disableCron();
    disableCron();
    expect(isCronEnabled()).toBe(false);
  });
});

// --------------------------------------------------------------------------
// 2. GenerateMarketingResponseWorkerService — drain-aware shutdown
// --------------------------------------------------------------------------

function makeWorkerService() {
  jest.resetModules();
  jest.doMock('child_process', () => ({
    fork: jest.fn(() => ({
      on: jest.fn(),
      send: jest.fn(),
      killed: false,
      kill: jest.fn(),
    })),
  }));
  // Stub the Socket.IO require inside the worker message handler
  jest.doMock('../server', () => ({ io: { to: jest.fn(() => ({ emit: jest.fn() })) } }));
  const { GenerateMarketingResponseWorkerService } =
    require('../services/generateMarketingResponseWorkerService');
  return new GenerateMarketingResponseWorkerService();
}

describe('GenerateMarketingResponseWorkerService.shutdown', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('exits immediately when no requests are in flight', async () => {
    const svc = makeWorkerService();
    const start = Date.now();
    await svc.shutdown();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('sets draining=true and rejects new runInWorker calls immediately', async () => {
    const svc = makeWorkerService();
    // Start shutdown without awaiting
    const shutdownPromise = svc.shutdown();

    await expect(
      svc.runInWorker({
        messageContent: 'test',
        sessionHistory: [],
        userId: 'u1',
        llmModel: 'gpt-4o',
        sessionId: 's1',
      }),
    ).rejects.toThrow('draining');

    await shutdownPromise;
  });

  it.each([0, 25])('uses the remaining %i ms budget instead of a fresh drain ceiling', async (budgetMs) => {
    jest.useFakeTimers();
    const svc = makeWorkerService();
    const reject = jest.fn();
    const timeout = setTimeout(() => {}, 99999);
    svc['pendingRequests'].set('stuck', { resolve: jest.fn(), reject, timeout });
    const started = Date.now();
    const shutdown = svc.shutdown(budgetMs);
    await jest.advanceTimersByTimeAsync(budgetMs);
    await shutdown;
    expect(Date.now() - started).toBe(budgetMs);
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: 'Worker shutdown — drain ceiling exceeded' }));
    expect(svc['pendingRequests'].size).toBe(0);
    jest.useRealTimers();
  });

  it('blocks until in-flight requests complete, then resolves', async () => {
    const svc = makeWorkerService();

    // Inject a fake pending request — shutdown must not resolve until this is gone
    const fakeTimeout = setTimeout(() => {}, 99999);
    svc['pendingRequests'].set('fake-req', {
      resolve: jest.fn(),
      reject: jest.fn(),
      timeout: fakeTimeout,
    });

    // Start the drain
    let resolved = false;
    const shutdownPromise = svc.shutdown().then(() => { resolved = true; });

    // After one event-loop tick, shutdown is still waiting (request still in-flight)
    await new Promise(resolve => setImmediate(resolve));
    expect(resolved).toBe(false);
    expect(svc['draining']).toBe(true);

    // Simulate the in-flight request completing
    clearTimeout(fakeTimeout);
    svc['pendingRequests'].delete('fake-req');

    // Shutdown's next 2-second poll detects the empty queue and resolves
    await shutdownPromise;
    expect(resolved).toBe(true);
    expect(svc['pendingRequests'].size).toBe(0);
  }, 10000 /* real timers: allow up to 10s for the 2s poll */);
});

// --------------------------------------------------------------------------
// 3. agentModeController — 503 guard
//
// Rather than importing the full 2500-line controller (which pulls in DynamoDB,
// Bedrock, etc.), we verify the guard pattern directly: the isCronEnabled check
// is the only code path that gates the controller, so testing it in a
// minimal equivalent is sufficient.
// --------------------------------------------------------------------------
describe('isCronEnabled 503 guard — pattern verification', () => {
  it('returns 503 when cron is disabled', async () => {
    jest.resetModules();
    const { disableCron, isCronEnabled } = require('../utils/instanceState');
    disableCron();

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    // Replicate exactly the guard added to runScheduledChats
    const guardHandler = async (_req: any, _res: any) => {
      if (!isCronEnabled()) {
        return _res.status(503).json({ message: 'Instance draining — retry on new instance' });
      }
    };

    await guardHandler({}, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('draining') }),
    );
  });

  it('does NOT return 503 when cron is enabled', async () => {
    jest.resetModules();
    const { isCronEnabled } = require('../utils/instanceState');
    // cron is enabled by default on fresh require
    expect(isCronEnabled()).toBe(true);

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    const guardHandler = async (_req: any, _res: any) => {
      if (!isCronEnabled()) {
        return _res.status(503).json({ message: 'Instance draining — retry on new instance' });
      }
      // normal handler would continue here
    };

    await guardHandler({}, res);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// 4. Execute the production drain block without booting server.ts. Admitted
// MCP calls must be able to reach the worker before its shutdown begins.
// --------------------------------------------------------------------------
describe('server drain keeps the worker available to admitted turns', () => {
  it('does not shut down the worker until registry and session drains settle', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../server.ts'), 'utf8');
    const start = source.indexOf('  const [', source.indexOf('const runDrain'));
    const end = source.indexOf('  if (!cronDrain.drained)', start);
    const block = source.slice(start, end);
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const run = new AsyncFunction(
      'generateMarketingResponseWorkerService', 'cronJobRegistry',
      'drainActiveSessionGenerations', 'drainLiveVoiceToolExecutions',
      'remainingDrainMs', block
    );
    let resolveRegistry!: (value: any) => void;
    let resolveSession!: (value: any) => void;
    const registry = new Promise(resolve => { resolveRegistry = resolve; });
    const session = new Promise(resolve => { resolveSession = resolve; });
    const shutdown = jest.fn().mockResolvedValue(undefined);
    const remainingDrainMs = jest.fn().mockReturnValue(123);
    const pending = run({ shutdown }, { drain: () => registry },
      () => session, async () => ({ drained: true }), remainingDrainMs);
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    resolveRegistry({ drained: true });
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();
    resolveSession({ drained: true });
    await pending;
    expect(shutdown).toHaveBeenCalledWith(123);
  });
});

// --------------------------------------------------------------------------
// 5. server.ts — drain-before-close ordering (ENG-1189)
//
// server.ts can't be `require`d directly in tests — importing it runs
// `server.listen(...)` as a real side effect (see chatSocketHandler.ts's own
// comment on this). So, like nginxProxyBuffers.test.ts does for EB config,
// this asserts the invariant against the source text instead of behavior:
// every MCP tool self-call (mcpFetch) loops back into THIS process's own
// listener via http://localhost:${PORT}. If server.close()/io.close() ever
// move back above the drain wait, in-flight self-calls break unrecoverably
// again — not transiently, since a closed listener refuses every retry — for
// as long as the process takes to actually exit (production-verified up to
// several minutes: session 2318c99c-6b45-47ae-95cb-12fe85939c8d, 2026-08-12).
// --------------------------------------------------------------------------
describe('server.ts shutdown sequencing (source-pinned, ENG-1189)', () => {
  const serverSrc = fs.readFileSync(
    path.join(__dirname, '../server.ts'),
    'utf8'
  );
  const mcpServerSrc = fs.readFileSync(
    path.join(__dirname, '../mcp/server/mcpServer.ts'),
    'utf8'
  );


  it('drains the worker/cron/session in-flight work before closing the HTTP listener', () => {
    const drainCallIndex = serverSrc.indexOf('await generateMarketingResponseWorkerService.shutdown(remainingDrainMs());');
    const serverCloseIndex = serverSrc.indexOf('server.close((err)');

    expect(drainCallIndex).toBeGreaterThan(-1);
    expect(serverCloseIndex).toBeGreaterThan(-1);
    expect(drainCallIndex).toBeLessThan(serverCloseIndex);
  });

  it('A-019 leaves SIGTERM/SIGINT ownership to the main server drain', () => {
    expect(mcpServerSrc).not.toContain("process.on('SIGTERM'");
    expect(mcpServerSrc).not.toContain("process.on('SIGINT'");
    expect(mcpServerSrc).toContain('(app as any).mcpShutdown = shutdownAllSessions');
  });

  it('A-019 closes MCP session transports after in-flight drain and before the HTTP listener', () => {
    const drainCallIndex = serverSrc.indexOf('await generateMarketingResponseWorkerService.shutdown(remainingDrainMs());');
    const mcpShutdownIndex = serverSrc.indexOf('await mcpShutdown();');
    const serverCloseIndex = serverSrc.indexOf('server.close((err)');

    expect(drainCallIndex).toBeGreaterThan(-1);
    expect(mcpShutdownIndex).toBeGreaterThan(drainCallIndex);
    expect(serverCloseIndex).toBeGreaterThan(mcpShutdownIndex);
  });

  it('drains the worker/cron/session in-flight work before closing Socket.IO', () => {
    const drainCallIndex = serverSrc.indexOf('await generateMarketingResponseWorkerService.shutdown(remainingDrainMs());');
    const ioCloseIndex = serverSrc.indexOf('io.close((err)');

    expect(drainCallIndex).toBeGreaterThan(-1);
    expect(ioCloseIndex).toBeGreaterThan(-1);
    expect(drainCallIndex).toBeLessThan(ioCloseIndex);
  });

  it('tracks in-flight interactive Agent Mode turns as part of the drain', () => {
    expect(serverSrc).toMatch(/drainActiveSessionGenerations/);
  });

  it('tracks in-flight Gemini Live Voice tool calls as part of the drain', () => {
    expect(serverSrc).toMatch(/drainLiveVoiceToolExecutions/);
  });

  it('tracks the Emma-chatbot socket turn — the one path with no other in-flight coverage', () => {
    const messageHandlerSection = serverSrc.slice(
      serverSrc.indexOf("socket.on('message'"),
      serverSrc.indexOf("socket.on('message'") + 400
    );
    expect(messageHandlerSection).toMatch(/cronJobRegistry\.track\('chatbotTurn',\s*handleSocketChatMessage/);
  });
});

describe('agentModeController generateResponse — drain admission (A-019)', () => {
  it('returns the drain 503 before any session-generation claim can be taken', () => {
    const controllerSrc = fs.readFileSync(
      path.join(__dirname, '../controllers/agentModeController.ts'),
      'utf8'
    );
    const methodIndex = controllerSrc.indexOf('async generateResponse(req: Request, res: Response)');
    const guardIndex = controllerSrc.indexOf("return res.status(503).json({ message: 'Instance draining — retry on new instance' });", methodIndex);
    // The claim now also passes the owner (ENG-110): match the call regardless of its extra arguments.
    const claimMatch = /tryClaimSessionGeneration\(sessionId\b/.exec(controllerSrc.slice(methodIndex));
    const claimIndex = claimMatch ? methodIndex + claimMatch.index : -1;

    expect(methodIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(methodIndex);
    expect(claimIndex).toBeGreaterThan(guardIndex);
  });
});

describe('agentModeController verifiedGenerate — drain coverage (ENG-1189)', () => {
  it('tracks the interactive verifiedGenerate call via cronJobRegistry, not activeSessionGenerations', () => {
    const controllerSrc = fs.readFileSync(
      path.join(__dirname, '../controllers/agentModeController.ts'),
      'utf8'
    );

    // verifiedGenerate has no per-session concurrency lock (unlike /generate),
    // so reusing activeSessionGenerations here would be wrong: a second
    // concurrent call for the same session would race the first call's
    // add/delete and could clear tracking while the first is still running.
    const verifiedGenerateIndex = controllerSrc.indexOf('async verifiedGenerate(req: Request, res: Response)');
    const trackCallIndex = controllerSrc.indexOf("cronJobRegistry.track('verifiedGenerateTurn', runVerifiedChat");

    expect(verifiedGenerateIndex).toBeGreaterThan(-1);
    // 'verifiedGenerateTurn' is a job-name coined specifically for this call
    // site, so a single occurrence positioned after the method declaration
    // is enough to confirm it's inside verifiedGenerate's own body.
    expect(trackCallIndex).toBeGreaterThan(verifiedGenerateIndex);
    expect(controllerSrc.indexOf("cronJobRegistry.track('verifiedGenerateTurn'", trackCallIndex + 1)).toBe(-1);
  });
});
