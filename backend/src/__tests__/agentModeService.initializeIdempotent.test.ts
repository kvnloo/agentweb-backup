import { AgentModeService } from '../services/agentModeService';

// Same mock surface as agentModeService.skills.test.ts — this suite only ever
// exercises initialize()'s guard, never the work it guards, so the heavy
// dependencies are stubbed rather than exercised.
jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
    getSkillsAvailableToUser: jest.fn().mockResolvedValue([]),
    getSkillsByOwner: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addAssociatedSkills: jest.fn(),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  },
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
    shutdown: jest.fn(),
    refresh: jest.fn(),
  })),
}));

// The registry reports one tool by default. initialize() latches on a NON-EMPTY
// registry rather than on "runInitialize didn't throw" (it provably cannot throw),
// so a mock that always returns [] would model a permanently-failing init, not a
// healthy one.
let registryTools: Array<{ name: string }> = [{ name: 'some_tool' }];
jest.mock('../mcp/client/toolRegistry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    unregister: jest.fn(),
    getAllTools: jest.fn(() => registryTools),
    getTool: jest.fn(),
    getToolDefinitions: jest.fn().mockReturnValue([]),
  })),
}));

/**
 * ENG-1852 follow-up. initialize() is called from two places that can overlap:
 * server.ts starts it at boot deliberately non-blocking, and chatbotService's
 * widget path calls it per message on the same module singleton. These tests pin
 * the guard that makes that safe.
 *
 * SCOPE: this file pins initialize()'s CONTROL FLOW — that the expensive body runs
 * once, that concurrent callers collapse onto one in-flight run, that the flag is
 * per-instance, and that foundation tools are re-read on every call. It mocks
 * runInitialize and ToolRegistry to do that, which means it cannot say anything about
 * the latch's SIGNAL.
 *
 * The signal is pinned separately, against the real registerTools() path, in
 * agentModeService.degradedInit.test.ts. That split is deliberate: an earlier version of
 * this file tried to cover both, and its fully-mocked registry let it assert a degraded
 * state the real code cannot produce — so it passed while the latch it "verified" was a
 * tautology. Mocked control-flow tests and real-path signal tests are different jobs.
 */
describe('AgentModeService.initialize — idempotency (ENG-1852 follow-up)', () => {
  let service: AgentModeService;
  let runSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    registryTools = [{ name: 'some_tool' }];
    service = new AgentModeService();
    // Spy on the private worker so these tests assert the guard itself, not any
    // particular side effect of the initialization body.
    // The mock stands in for a SUCCESSFUL runInitialize, so it must set the same signals
    (AgentModeService as any).toolsRegistered = true;
    runSpy = jest
      .spyOn(service as any, 'runInitialize')
      .mockImplementation(async () => {
        // Models a successful registration. This file covers CONTROL FLOW only — see
        // agentModeService.degradedInit.test.ts for the latch's signal, which is driven
        // through the real registerTools() path rather than assigned by the test.
        (service as any).emmaToolsRegistered = true;
      });
  });

  it('runs the work only once across repeated sequential calls', async () => {
    await service.initialize();
    await service.initialize();
    await service.initialize();

    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent callers onto a single in-flight initialization', async () => {
    // The deferred is built UP FRONT, not inside mockImplementation. initialize()
    // awaits loadFoundationTools() before it ever reaches runInitialize, so a
    // `release` assigned inside the mock is still unassigned when the test calls
    // it — the promise never settles and the test times out. Caught exactly that
    // way while adding the foundation-tools hoist.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runSpy.mockImplementation(() => gate);

    const a = service.initialize();
    const b = service.initialize();
    const c = service.initialize();

    release();
    await Promise.all([a, b, c]);

    // This is the boot-race case: server.ts's non-blocking boot init is still
    // running when a chat message arrives and calls initialize() again. The
    // second caller must await the first, not start a parallel registration pass.
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('re-reads foundation tools on EVERY call, outside the latch (F3 regression)', async () => {
    const loadSpy = jest
      .spyOn(service as any, 'loadFoundationTools')
      .mockResolvedValue(undefined);

    await service.initialize();
    await service.initialize();
    await service.initialize();

    // loadFoundationTools writes the process-global static FOUNDATION_TOOLS, which
    // the admin PUT /foundation-tools route mutates per-process. Latching it would
    // mean an added foundation tool never reaches a process until restart — the
    // ENG-280/ENG-404 "tool not available" class. The expensive registration pass
    // is still guarded.
    expect(loadSpy).toHaveBeenCalledTimes(3);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('does not share initialization state between instances', async () => {
    await service.initialize();

    const other = new AgentModeService();
    const otherSpy = jest
      .spyOn(other as any, 'runInitialize')
      .mockResolvedValue(undefined);

    await other.initialize();

    // The flag is per-instance on purpose: suites that construct their own
    // AgentModeService in beforeEach must still initialize normally.
    expect(otherSpy).toHaveBeenCalledTimes(1);
  });
});
