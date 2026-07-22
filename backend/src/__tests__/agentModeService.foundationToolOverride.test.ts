import { AgentModeService } from '../services/agentModeService';

// ENG-404: a stale `foundation_tools` AW-Settings override must never be able to
// strip a tool that the code ships in DEFAULT_FOUNDATION_TOOLS. loadFoundationTools
// (and updateFoundationTools) must treat the DB override as ADDITIVE on top of the
// defaults, so no drifted override can silently drop a shipped default tool — the
// systemic root cause behind ENG-280 and the earlier one-off MANDATORY patches.

jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
    getAllSkills: jest.fn().mockResolvedValue([]),
    createSkill: jest.fn().mockResolvedValue({}),
    updateSkill: jest.fn().mockResolvedValue(undefined),
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
  filterFunctionCalls: jest.fn().mockImplementation((tools) => tools),
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

// The exact stale override captured from prod AW-Settings (updated 2026-06-16),
// which omits most DEFAULT-only tools.
const STALE_PROD_OVERRIDE = [
  'install_skills',
  'list_available_skills',
  'read_brand_guidelines',
  'read_market_strategy',
  'you_search_web',
  'perform_data_analysis',
  'create_work_plan',
  'modify_work_plan',
  'set_work_plan_status',
  'save_memory',
  'delete_memory',
  'resolve_skill',
  'report_product_issues',
  'notify_session',
  'wait_seconds',
];

// Derive the DEFAULT-only tools the stale override strips, straight from the live
// DEFAULT/MANDATORY sets — anything shipped in DEFAULT that is neither in the
// override nor in MANDATORY. Computed (not hardcoded) so the test can never drift
// as DEFAULT_FOUNDATION_TOOLS evolves (e.g. tools added/removed on main).
const strippedDefaultOnlyTools = (): string[] => {
  const overrideSet = new Set(STALE_PROD_OVERRIDE);
  const mandatorySet = new Set(
    (AgentModeService as any).MANDATORY_FOUNDATION_TOOLS as string[]
  );
  return AgentModeService.DEFAULT_FOUNDATION_TOOLS.filter(
    (t) => !overrideSet.has(t) && !mandatorySet.has(t)
  );
};

describe('AgentModeService - foundation_tools override is additive (ENG-404)', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();

    const mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService = {
      getSetting: jest.fn().mockResolvedValue(null),
      setSetting: jest.fn().mockResolvedValue(undefined),
    };

    (AgentModeService as any).FOUNDATION_TOOLS = new Set(AgentModeService.DEFAULT_FOUNDATION_TOOLS);
  });

  it('always exposes the canonical product-guide search to normal and live voice sessions', () => {
    expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('search_user_guide');
    expect((AgentModeService as any).MANDATORY_FOUNDATION_TOOLS).toContain(
      'search_user_guide'
    );
  });

  it('keeps every DEFAULT-only tool available when a stale override omits them', async () => {
    const mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService.getSetting = jest.fn().mockResolvedValue({
      settingValue: JSON.stringify(STALE_PROD_OVERRIDE),
    });

    await agentModeService.loadFoundationTools();
    const tools = agentModeService.getFoundationToolNames();

    const stripped = strippedDefaultOnlyTools();
    // Sanity: the stale override really does omit a meaningful set of defaults,
    // otherwise this test would be vacuously true.
    expect(stripped.length).toBeGreaterThan(5);
    for (const name of stripped) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it('keeps the full DEFAULT_FOUNDATION_TOOLS set as a subset of the active tools under any override', async () => {
    const mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService.getSetting = jest.fn().mockResolvedValue({
      settingValue: JSON.stringify(STALE_PROD_OVERRIDE),
    });

    await agentModeService.loadFoundationTools();
    const tools = agentModeService.getFoundationToolNames();

    for (const name of AgentModeService.DEFAULT_FOUNDATION_TOOLS) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it('still preserves override-only extras that are not in DEFAULT', async () => {
    const mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService.getSetting = jest.fn().mockResolvedValue({
      settingValue: JSON.stringify(STALE_PROD_OVERRIDE),
    });

    await agentModeService.loadFoundationTools();
    const tools = agentModeService.getFoundationToolNames();

    // report_product_issues is in the override but NOT in DEFAULT — it must survive.
    expect(tools.has('report_product_issues')).toBe(true);
  });

  it('updateFoundationTools persists a superset of DEFAULT_FOUNDATION_TOOLS', async () => {
    const result = await agentModeService.updateFoundationTools(
      ['some_custom_tool'],
      'tester@example.com'
    );

    for (const name of AgentModeService.DEFAULT_FOUNDATION_TOOLS) {
      expect(result).toContain(name);
    }
    expect(result).toContain('some_custom_tool');
  });
});
