import { AgentModeService } from '../services/agentModeService';

/**
 * ENG-1852 follow-up — the DEGRADED-INIT latch, exercised through the REAL
 * registerTools() path.
 *
 * This file deliberately does NOT mock ToolRegistry. Its sibling
 * agentModeService.initializeIdempotent.test.ts does, which makes it useful for
 * pinning the guard's control flow but useless for pinning the guard's SIGNAL:
 * with a mocked registry the test can assert any registry size it likes,
 * including states the real code cannot produce.
 *
 * That gap shipped a real bug. The first version of the latch used
 * `getAllTools().length > 0` as its success signal, which is a tautology —
 * registerTools() registers four built-ins (search_tool_response,
 * read_tool_response, notify_session, wait_seconds) unconditionally AFTER both of
 * its try/catch blocks, and ToolRegistry.register is a Map.set that cannot throw.
 * So the registry is never empty regardless of how registration went, and a fully
 * degraded init latched permanently. Confirmed on test-env-1 by fault injection
 * and independently by review.
 *
 * The two halves of registerTools() fail independently, so both are covered here:
 *   step 1 — the side-effect imports that POPULATE emmaToolRegistry
 *   step 2 — the copy from emmaToolRegistry into this instance's registry
 */

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
    initialize: jest.fn().mockResolvedValue(undefined),
    getTools: jest.fn().mockReturnValue([]),
    shutdown: jest.fn(),
    refresh: jest.fn(),
  })),
}));

// The one thing under test's control: what step 1 leaves in emmaToolRegistry.
let registryToolNames: string[] = ['fake_tool_a', 'fake_tool_b'];
jest.mock('../emma/registry', () => ({
  emmaToolRegistry: {
    // `register` MUST be present. Without it the sixteen real emma modules that step 1
    // imports crash against the stub ("emmaToolRegistry.register is not a function"),
    // which silently left step 1 failing — and three tests in this file passed only
    // because of that accident. Completing the mock is what makes them honest.
    register: jest.fn(),
    getToolNames: jest.fn(() => registryToolNames),
    getTool: jest.fn((name: string) => ({
      name,
      definition: { name, description: `desc ${name}`, inputSchema: { type: 'object', properties: {} } },
      execute: jest.fn(),
      requiresUserAccount: false,
    })),
  },
}));

describe('AgentModeService degraded-init detection (real registerTools path)', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    registryToolNames = ['fake_tool_a', 'fake_tool_b'];
    // Step 1 is the seventeen side-effect imports that populate emmaToolRegistry. It is
    // guarded by this process-wide static, so in a real server only the FIRST instance
    // runs it; later ones skip straight to step 2. Default these cases to "step 1 already
    // succeeded in this process", which is the common real state, and drive the
    // step-1-failed case explicitly below.
    (AgentModeService as any).toolsRegistered = true;
    service = new AgentModeService();
    // Keep initialize() to the registration path only — the other steps have their
    // own coverage and would reach DynamoDB here.
    // These stand in for SUCCESSFUL steps, so they set the same flags the real ones do.
    // The latch is the conjunction of every step's own outcome; a spy that resolves
    // without reporting would model a permanently-failing step, not a healthy one.
    jest.spyOn(service as any, 'initializeMcp').mockImplementation(async () => {
      (service as any).mcpStepOk = true;
    });
    jest.spyOn(service as any, 'ensureBuiltInSkills').mockImplementation(async () => {
      (service as any).builtInSkillsStepOk = true;
    });
    jest.spyOn(service as any, 'loadFoundationTools').mockResolvedValue(undefined);
  });

  afterEach(() => {
    (service as any).stopFileCacheCleanup?.();
    const handle = (service as any).fileCacheCleanupInterval;
    if (handle) clearInterval(handle);
    jest.restoreAllMocks();
  });

  it('latches on a healthy registration', async () => {
    await service.initialize();
    expect((service as any).initialized).toBe(true);
  });

  it('a non-empty registry is NOT sufficient — the four built-ins always register', async () => {
    // The exact tautology the first version of the latch shipped. Step 1 failed, so
    // emmaToolRegistry was never populated and no Emma tool reached this instance — yet
    // the registry is still non-empty, because the built-ins register unconditionally
    // after both try/catch blocks and ToolRegistry.register is a Map.set that cannot
    // throw. `getAllTools().length > 0` therefore could never be false.
    registryToolNames = []; // step 1 produced nothing to copy

    await service.initialize();

    const size = (service as any).toolRegistry.getAllTools().length;
    expect(size).toBeGreaterThan(0);   // the old signal would have latched here
    expect((service as any).initialized).toBe(false); // the real signal does not
  });

  it('does not latch when the side-effect imports (step 1) failed', async () => {
    // Step 1 populates emmaToolRegistry; step 2 copies out of it. If step 1 throws, step 2
    // still "succeeds" — it copies zero tools without error — so checking only step 2
    // would latch a degraded init. This is the half a registry-size check misses entirely.
    (AgentModeService as any).toolsRegistered = false;
    registryToolNames = [];

    await expect(service.initialize()).resolves.toBeUndefined();
    expect((service as any).initialized).toBe(false);
  });

  it('does not latch when the emmaToolRegistry copy (step 2) throws', async () => {
    const { emmaToolRegistry } = jest.requireMock('../emma/registry') as any;
    emmaToolRegistry.getToolNames.mockImplementationOnce(() => {
      throw new Error('synthetic step-2 failure');
    });

    await expect(service.initialize()).resolves.toBeUndefined(); // swallowed, as in prod
    expect((service as any).initialized).toBe(false);
  });

  it('retries and recovers once registration succeeds again', async () => {
    // The self-healing that the pre-branch per-message instance gave for free, and that
    // a latch on mere completion destroyed.
    registryToolNames = [];
    await service.initialize();
    expect((service as any).initialized).toBe(false);

    registryToolNames = ['fake_tool_a']; // transient cause clears
    await service.initialize();
    expect((service as any).initialized).toBe(true);
  });

  it('does not latch on a PARTIAL copy — some tools missing is still degraded', async () => {
    // getToolNames reports three, but one cannot be resolved. Nothing throws; the loop
    // simply copies two. A "no exception" signal accepts this; a copied-count does not.
    const { emmaToolRegistry } = jest.requireMock('../emma/registry') as any;
    registryToolNames = ['a', 'b', 'c'];
    emmaToolRegistry.getTool.mockImplementation((name: string) =>
      name === 'b' ? undefined : {
        name,
        definition: { name, description: name, inputSchema: { type: 'object', properties: {} } },
        execute: jest.fn(),
        requiresUserAccount: false,
      });

    await service.initialize();

    expect((service as any).emmaToolsRegistered).toBe(false);
    expect((service as any).initialized).toBe(false);
  });

  it('does not latch when MCP initialization failed', async () => {
    // Registration is fine; MCP is not. initializeMcp swallows its own errors, so the
    // only way the latch can know is if the step reports its own outcome.
    (service as any).initializeMcp.mockImplementation(async () => {
      (service as any).mcpStepOk = false;
    });

    await service.initialize();

    expect((service as any).emmaToolsRegistered).toBe(true); // registration succeeded
    expect((service as any).initialized).toBe(false);        // but init is degraded
  });

  it('does not latch when built-in skill seeding failed', async () => {
    (service as any).ensureBuiltInSkills.mockImplementation(async () => {
      (service as any).builtInSkillsStepOk = false;
    });

    await service.initialize();

    expect((service as any).emmaToolsRegistered).toBe(true);
    expect((service as any).initialized).toBe(false);
  });

  it('does not re-bootstrap downstream singletons on every retry', async () => {
    // initializeDownstreamSingletons is fire-and-forget and NOT idempotent — three of
    // its five inits replace live singletons unconditionally. The latch's retry path
    // would otherwise swap them under in-flight tool calls once per failed attempt.
    const spy = jest
      .spyOn(service as any, 'initializeDownstreamSingletons')
      .mockResolvedValue(undefined);

    registryToolNames = [];
    await service.initialize();
    await service.initialize();
    await service.initialize();

    expect((service as any).initialized).toBe(false); // genuinely retried each time
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not leak a cleanup interval across the retries the latch enables', async () => {
    registryToolNames = [];
    await service.initialize();
    const first = (service as any).fileCacheCleanupInterval;

    await service.initialize();
    await service.initialize();

    // Each failed init re-runs the whole body. Without an idempotence guard in
    // startFileCacheCleanup that orphans one live interval per retry, each retaining
    // `this` — the same leak shape as the per-message-instance bug this branch fixes.
    expect((service as any).fileCacheCleanupInterval).toBe(first);
  });
});
