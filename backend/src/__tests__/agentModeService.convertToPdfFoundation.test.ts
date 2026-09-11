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

describe('AgentModeService - convert_to_pdf foundation tool (ENG-1867)', () => {
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

  it('includes convert_to_pdf in DEFAULT_FOUNDATION_TOOLS', () => {
    expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('convert_to_pdf');
  });

  it('has convert_to_pdf in the runtime FOUNDATION_TOOLS set after reset', () => {
    const foundationTools = agentModeService.getFoundationToolNames();
    expect(foundationTools.has('convert_to_pdf')).toBe(true);
  });

  it('keeps convert_to_pdf available even when a DB foundation_tools override omits it', async () => {
    // Reproduces production (ENG-1867): AW-Settings `foundation_tools` is a small
    // curated list that does NOT include convert_to_pdf. Without a mandatory
    // merge, the tool is only reachable via install_skills(["__other_skills__"]) —
    // a bucket whose membership depends on which other skills a specific
    // subscription tier happens to have installed, so the install can be refused
    // with "these skills are currently unavailable to install" even though the
    // account is fully entitled to use it.
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
    expect(tools.has('convert_to_pdf')).toBe(true);
  });

  it('allows convert_to_pdf to pass the buildSkillContext gate with no associated skills', () => {
    // With zero associated/session skills, buildSkillContext seeds allowedToolNames
    // from FOUNDATION_TOOLS, so a user asking to download a generated HTML file as
    // a PDF can have it converted without first installing a skill.
    const { allowedToolNames } = (agentModeService as any).buildSkillContext(
      [], // associatedSkills — none
      ['*'], // userAllowedSkillIds
      [], // publishedSkills
      [], // sessionAssociatedSkillIds — none installed
      false // hasAdminAccess
    );

    expect(allowedToolNames.has('convert_to_pdf')).toBe(true);
  });
});
