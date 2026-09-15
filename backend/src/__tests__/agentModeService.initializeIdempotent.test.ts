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

jest.mock('../mcp/client/toolRegistry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    unregister: jest.fn(),
    getAllTools: jest.fn().mockReturnValue([]),
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
 * Mutation-verified against the pre-fix code (initialize() with no guard, body
 * inline instead of in runInitialize): 'runs the work only once' and 'collapses
 * concurrent callers' both FAIL there — 2 calls and 3 calls respectively — and
 * 'retries after a failed attempt' passes both before and after, so it pins the
 * retry path rather than the guard. Kept deliberately: it is the regression that
 * a naive `initialized = true` in a non-finally path would introduce.
 */
describe('AgentModeService.initialize — idempotency (ENG-1852 follow-up)', () => {
  let service: AgentModeService;
  let runSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    // Spy on the private worker so these tests assert the guard itself, not any
    // particular side effect of the initialization body.
    runSpy = jest
      .spyOn(service as any, 'runInitialize')
      .mockResolvedValue(undefined);
  });

  it('runs the work only once across repeated sequential calls', async () => {
    await service.initialize();
    await service.initialize();
    await service.initialize();

    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent callers onto a single in-flight initialization', async () => {
    let release: () => void = () => {};
    runSpy.mockImplementation(
      () => new Promise<void>((resolve) => { release = () => resolve(); })
    );

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

  it('retries after a failed attempt instead of staying permanently wedged', async () => {
    runSpy.mockRejectedValueOnce(new Error('boot init failed'));

    await expect(service.initialize()).rejects.toThrow('boot init failed');

    // A failed boot must not leave the service believing it is initialized, nor
    // hand every later caller the same rejected promise forever.
    runSpy.mockResolvedValue(undefined);
    await expect(service.initialize()).resolves.toBeUndefined();

    expect(runSpy).toHaveBeenCalledTimes(2);
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
