/**
 * ENG-893 — the tool payload must depend only on WHICH tools are allowed, never
 * on the order they were allowed in.
 *
 * Bedrock chains prompt-cache checkpoints tools -> system -> messages, so any
 * byte change in `toolConfig` invalidates the system prompt and the entire
 * conversation history behind it. In the session that filed this ticket that
 * cost 80k-185k tokens each time.
 *
 * A skill install legitimately changes the tool SET, and we accept that cost.
 * What must never happen is the tool payload changing when the set did not —
 * e.g. if the filter ever started iterating the allowed-name Set (whose order
 * follows install order) instead of the registry. That would re-cache the whole
 * prefix on every skill refresh for no functional reason, and would stop two
 * sessions holding the same tools from ever sharing a cached prefix.
 */

import { AgentModeService } from '../services/agentModeService';

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
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

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  getPublicAllowedSkills: jest.fn().mockResolvedValue([]),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
    shutdown: jest.fn(),
    refresh: jest.fn(),
    discoverToolsForUser: jest.fn().mockResolvedValue(0),
  })),
}));

/** Registry order is the ONLY thing that may determine payload order. */
const REGISTRY_ORDER = ['alpha_tool', 'bravo_tool', 'charlie_tool', 'delta_tool', 'echo_tool'];

jest.mock('../mcp/client/toolRegistry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    unregister: jest.fn(),
    getTool: jest.fn(),
    getToolDefinitions: jest.fn().mockReturnValue([]),
    getAllTools: jest.fn().mockReturnValue(
      ['alpha_tool', 'bravo_tool', 'charlie_tool', 'delta_tool', 'echo_tool'].map((name) => ({
        name,
        definition: { type: 'function', function: { name, parameters: {} } },
        execute: jest.fn(),
      }))
    ),
  })),
}));

describe('ENG-893 — Converse tool payload stability', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
  });

  const names = (tools: any[]) => tools.map((t) => t.function?.name ?? t.name);

  it('orders the payload by the registry, not by the order skills were installed', async () => {
    // Same three tools, opposite install orders.
    const installedAscending = await agentModeService.getFilteredTools(
      'user-1',
      new Set(['alpha_tool', 'charlie_tool', 'echo_tool']),
      []
    );
    const installedDescending = await agentModeService.getFilteredTools(
      'user-1',
      new Set(['echo_tool', 'charlie_tool', 'alpha_tool']),
      []
    );

    expect(names(installedAscending)).toEqual(['alpha_tool', 'charlie_tool', 'echo_tool']);
    // Byte-identical, or Bedrock re-caches the entire prefix behind it.
    expect(JSON.stringify(installedDescending)).toBe(JSON.stringify(installedAscending));
  });

  it('produces an identical payload when a refresh does not change the tool set', async () => {
    // The post-install refresh rebuilds the tool list from scratch. When the
    // membership is unchanged the rebuilt payload must be byte-identical, so a
    // no-op refresh costs nothing.
    const allowed = ['bravo_tool', 'delta_tool'];
    const before = await agentModeService.getFilteredTools('user-1', new Set(allowed), []);
    const afterRebuild = await agentModeService.getFilteredTools('user-1', new Set(allowed), []);

    expect(JSON.stringify(afterRebuild)).toBe(JSON.stringify(before));
  });

  it('keeps the surviving tools in the same relative order when a skill is installed', async () => {
    // Installing a skill legitimately changes the payload — that re-cache is
    // accepted. What it must not do is reshuffle the tools that were already
    // there, which would enlarge the diff for no reason.
    const beforeInstall = await agentModeService.getFilteredTools(
      'user-1',
      new Set(['alpha_tool', 'echo_tool']),
      []
    );
    const afterInstall = await agentModeService.getFilteredTools(
      'user-1',
      new Set(['alpha_tool', 'charlie_tool', 'echo_tool']),
      []
    );

    const survivors = names(afterInstall).filter((n: string) => names(beforeInstall).includes(n));
    expect(survivors).toEqual(names(beforeInstall));
  });

  it('never emits a tool that is not in the allowed set', async () => {
    const filtered = await agentModeService.getFilteredTools(
      'user-1',
      new Set(['bravo_tool']),
      []
    );
    expect(names(filtered)).toEqual(['bravo_tool']);
    expect(names(filtered)).not.toContain('alpha_tool');
  });

  it('reflects the registry order exactly when every tool is allowed', async () => {
    const filtered = await agentModeService.getFilteredTools(
      'user-1',
      new Set([...REGISTRY_ORDER].reverse()),
      []
    );
    expect(names(filtered)).toEqual(REGISTRY_ORDER);
  });
});
