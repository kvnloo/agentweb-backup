import { AgentModeService } from '../services/agentModeService';

// Mock all dependencies
jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsByIds: jest.fn().mockResolvedValue([]),
    getAllSkills: jest.fn().mockResolvedValue([]),
    createSkill: jest.fn().mockResolvedValue(undefined),
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

describe('AgentModeService - read_file_content foundation tool (ENG-152)', () => {
  let agentModeService: AgentModeService;
  let mockSettingsService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();

    mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService = {
      getSetting: jest.fn().mockResolvedValue(null),
    };

    // Reset foundation tools to defaults
    (AgentModeService as any).FOUNDATION_TOOLS = new Set(AgentModeService.DEFAULT_FOUNDATION_TOOLS);
  });

  it('includes read_file_content in DEFAULT_FOUNDATION_TOOLS', () => {
    expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('read_file_content');
  });

  it('has read_file_content in the runtime FOUNDATION_TOOLS set after reset', () => {
    const foundationTools = agentModeService.getFoundationToolNames();
    expect(foundationTools.has('read_file_content')).toBe(true);
  });

  it('keeps read_file_content available even when a DB foundation_tools override omits it', async () => {
    // Reproduces production: AW-Settings `foundation_tools` is a small curated list
    // that does NOT include read_file_content. Without a mandatory merge, the tool
    // becomes "not available" and the user has to manually install other_skills.
    const prodOverride = [
      'install_skills',
      'list_available_skills',
      'you_search_web',
      'perform_data_analysis',
      'resolve_skill',
    ];
    mockSettingsService.settingsService.getSetting = jest
      .fn()
      .mockResolvedValue({ settingValue: JSON.stringify(prodOverride) });

    await agentModeService.loadFoundationTools();

    const tools = agentModeService.getFoundationToolNames();
    expect(tools.has('read_file_content')).toBe(true);
  });

  it('allows read_file_content to pass the buildSkillContext gate with no associated skills', () => {
    // Exercise the actual gate ENG-152 fixes: with zero associated/session skills,
    // buildSkillContext seeds allowedToolNames from FOUNDATION_TOOLS, so a user who
    // attached a file can read it without first installing other_skills.
    const { allowedToolNames } = (agentModeService as any).buildSkillContext(
      [], // associatedSkills — none
      ['*'], // userAllowedSkillIds
      [], // publishedSkills
      [], // sessionAssociatedSkillIds — none installed
      false // hasAdminAccess
    );

    expect(allowedToolNames.has('read_file_content')).toBe(true);
  });

  it('keeps read_file_content in getFilteredTools output even when subscription skills omit it', async () => {
    // Reproduces the gate: a narrow subscription resolves to skill tools that do NOT
    // include read_file_content. getFilteredTools must still surface it because it is
    // a foundation tool that bypasses subscription filtering.
    const readFileTool = { name: 'read_file_content', definition: { name: 'read_file_content' } };
    (agentModeService as any).toolRegistry = {
      getAllTools: jest.fn().mockReturnValue([readFileTool]),
      getTool: jest.fn(),
    };

    const subscriptionService = require('../services/subscriptionService');
    // Subscription resolves to a narrow, non-wildcard tool set without read_file_content.
    subscriptionService.resolveSkillsToToolNames.mockResolvedValueOnce(['some_other_tool']);
    // Real filtering semantics: only tools in the allowed list survive.
    subscriptionService.filterFunctionCalls.mockImplementationOnce(
      (tools: any[], allowed: string[]) =>
        allowed.includes('*') ? tools : tools.filter((t) => allowed.includes(t.name))
    );

    const skillContext = (agentModeService as any).buildSkillContext([], ['skill-narrow'], [], [], false);
    const filtered = await agentModeService.getFilteredTools(
      '1743956381327',
      skillContext.allowedToolNames,
      ['skill-narrow']
    );

    expect(filtered.some((t: any) => t.name === 'read_file_content')).toBe(true);
  });
});
