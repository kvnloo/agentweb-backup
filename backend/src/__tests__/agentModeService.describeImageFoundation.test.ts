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

describe('AgentModeService - describe_image foundation tool (ENG-260)', () => {
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

  it('includes describe_image in DEFAULT_FOUNDATION_TOOLS', () => {
    expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('describe_image');
  });

  it('has describe_image in the runtime FOUNDATION_TOOLS set after reset', () => {
    const foundationTools = agentModeService.getFoundationToolNames();
    expect(foundationTools.has('describe_image')).toBe(true);
  });

  it('keeps describe_image available even when a DB foundation_tools override omits it', async () => {
    // Reproduces production: AW-Settings `foundation_tools` is a small curated list
    // that does NOT include describe_image. Without a mandatory merge, the tool is
    // "not available" and Emma cannot read a screenshot the user attached — she has
    // to ask them to type out what's on screen (ENG-260).
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
    expect(tools.has('describe_image')).toBe(true);
  });

  it('allows describe_image to pass the buildSkillContext gate with no associated skills', () => {
    // With zero associated/session skills, buildSkillContext seeds allowedToolNames
    // from FOUNDATION_TOOLS, so a user who attached a screenshot can have it read
    // without first installing an image skill.
    const { allowedToolNames } = (agentModeService as any).buildSkillContext(
      [], // associatedSkills — none
      ['*'], // userAllowedSkillIds
      [], // publishedSkills
      [], // sessionAssociatedSkillIds — none installed
      false // hasAdminAccess
    );

    expect(allowedToolNames.has('describe_image')).toBe(true);
  });
});
