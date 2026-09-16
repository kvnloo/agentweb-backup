import { AgentModeService } from '../services/agentModeService';

/**
 * ENG-1852 follow-up — step 1 of registerTools() failing for REAL.
 *
 * Its own file on purpose. Step 1 is sixteen side-effect imports that register into
 * emmaToolRegistry at module scope, and it only runs while the process-wide static
 * AgentModeService.toolsRegistered is false. Once any test in a file has loaded those
 * modules successfully, jest caches them and they never re-execute — so a sibling case
 * cannot make them fail afterwards. Here, `register` throws from the very first load.
 *
 * Why this file exists at all: an earlier version asserted step 1's outcome by ASSIGNING
 * AgentModeService.toolsRegistered in the test and reading it back through the latch.
 * That verified nothing — deleting the conjunct from production code left all 4823 tests
 * green. A test may not supply the signal it is checking.
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
    getAllSkills: jest.fn().mockResolvedValue([]),
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

// The emma modules call register() at import time. Throwing here makes them fail to
// load, which is precisely the condition step 1's own try/catch exists to absorb.
let registryToolNames: string[] = [];
jest.mock('../emma/registry', () => ({
  emmaToolRegistry: {
    register: jest.fn(() => {
      throw new Error('synthetic step-1 registration failure');
    }),
    getToolNames: jest.fn(() => registryToolNames),
    getTool: jest.fn((name: string) => ({
      name,
      definition: { name, description: name, inputSchema: { type: 'object', properties: {} } },
      execute: jest.fn(),
      requiresUserAccount: false,
    })),
  },
}));

describe('AgentModeService — step 1 failure is not latched (ENG-1852)', () => {
  it('leaves toolsRegistered false and refuses to latch', async () => {
    (AgentModeService as any).toolsRegistered = false;
    const service = new AgentModeService();
    jest.spyOn(service as any, 'initializeMcp').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'ensureBuiltInSkills').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'loadFoundationTools').mockResolvedValue(undefined);

    // Production swallows the failure and resolves — that is the whole problem this
    // latch exists for, and why "it resolved" is not a success signal.
    await expect(service.initialize()).resolves.toBeUndefined();

    // Both read values PRODUCTION set, not values this test assigned.
    expect((AgentModeService as any).toolsRegistered).toBe(false);
    expect((service as any).initialized).toBe(false);

    const handle = (service as any).fileCacheCleanupInterval;
    if (handle) clearInterval(handle);
  });
  it('refuses to latch on step 1 alone, even when step 2 copies cleanly', async () => {
    // Pins the toolsRegistered conjunct SPECIFICALLY. In the case above both conjuncts
    // are false, so dropping either from the latch changes nothing and the mutation goes
    // undetected — which is exactly what happened when this was first written.
    //
    // Here the registry reports tools (a partial or earlier population), so step 2 copies
    // them and emmaToolsRegistered comes out TRUE. The only thing standing between this
    // instance and a latched, half-initialized state is the toolsRegistered conjunct.
    registryToolNames = ['tool_a', 'tool_b'];
    (AgentModeService as any).toolsRegistered = false;
    const service = new AgentModeService();
    jest.spyOn(service as any, 'initializeMcp').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'ensureBuiltInSkills').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'loadFoundationTools').mockResolvedValue(undefined);

    await service.initialize();

    expect((service as any).emmaToolsRegistered).toBe(true);   // step 2 was fine
    expect((AgentModeService as any).toolsRegistered).toBe(false); // step 1 was not
    expect((service as any).initialized).toBe(false);

    const handle = (service as any).fileCacheCleanupInterval;
    if (handle) clearInterval(handle);
  });
});
