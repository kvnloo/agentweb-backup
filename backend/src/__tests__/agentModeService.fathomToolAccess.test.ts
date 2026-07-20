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
    createSkill: jest.fn().mockResolvedValue({
      skillId: 'mock-skill-id',
      name: 'Meeting Intelligence',
      description: 'test',
      toolNames: ['fathom_get_meetings', 'fathom_get_transcript', 'fathom_get_onboarding_context'],
      isPublished: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
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

import { skillService } from '../services/skillService';

describe('AgentModeService - Fathom Tool Access', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();

    const mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService = {
      getSetting: jest.fn().mockResolvedValue(null),
    };

    // Reset foundation tools to defaults
    (AgentModeService as any).FOUNDATION_TOOLS = new Set(AgentModeService.DEFAULT_FOUNDATION_TOOLS);
  });

  describe('Deprecated local agent tools are NOT foundation tools (ENG-383)', () => {
    it('excludes run_local_agent_task and check_local_agent_status from DEFAULT_FOUNDATION_TOOLS', () => {
      expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).not.toContain('run_local_agent_task');
      expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).not.toContain('check_local_agent_status');
    });

    it('excludes them from the runtime FOUNDATION_TOOLS default set', () => {
      const foundationTools = agentModeService.getFoundationToolNames();
      expect(foundationTools.has('run_local_agent_task')).toBe(false);
      expect(foundationTools.has('check_local_agent_status')).toBe(false);
    });
  });

  describe('Approach 1: Fathom tools in DEFAULT_FOUNDATION_TOOLS', () => {
    it('should include fathom_get_meetings in default foundation tools', () => {
      expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('fathom_get_meetings');
    });

    it('should include fathom_get_transcript in default foundation tools', () => {
      expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('fathom_get_transcript');
    });

    it('should include fathom_get_onboarding_context in default foundation tools', () => {
      expect(AgentModeService.DEFAULT_FOUNDATION_TOOLS).toContain('fathom_get_onboarding_context');
    });

    it('should have Fathom tools in the runtime FOUNDATION_TOOLS set after reset', () => {
      const foundationTools = agentModeService.getFoundationToolNames();
      expect(foundationTools.has('fathom_get_meetings')).toBe(true);
      expect(foundationTools.has('fathom_get_transcript')).toBe(true);
      expect(foundationTools.has('fathom_get_onboarding_context')).toBe(true);
    });

    it('should load Fathom tools into FOUNDATION_TOOLS on loadFoundationTools fallback', async () => {
      await agentModeService.loadFoundationTools();
      const tools = agentModeService.getFoundationToolNames();
      expect(tools.has('fathom_get_meetings')).toBe(true);
      expect(tools.has('fathom_get_transcript')).toBe(true);
      expect(tools.has('fathom_get_onboarding_context')).toBe(true);
    });

    // ENG-280: production had a stale `foundation_tools` AW-Settings override
    // (set before the Fathom tools existed) that did NOT list the Fathom tools.
    // Because loadFoundationTools merges the DB override only with
    // MANDATORY_FOUNDATION_TOOLS, the Fathom tools were stripped in prod and
    // `fathom_get_onboarding_context` became unreachable for the session. The
    // Fathom tools must be force-merged so no stale config can strip them.
    it('should keep Fathom tools available even when a stale DB override omits them', async () => {
      const mockSettingsService = require('../services/settingsService');
      mockSettingsService.settingsService.getSetting = jest.fn().mockResolvedValue({
        settingValue: JSON.stringify([
          'install_skills',
          'list_available_skills',
          'resolve_skill',
          'you_search_web',
          'perform_data_analysis',
          'notify_session',
          'wait_seconds',
        ]),
      });

      await agentModeService.loadFoundationTools();
      const tools = agentModeService.getFoundationToolNames();
      expect(tools.has('fathom_get_meetings')).toBe(true);
      expect(tools.has('fathom_get_transcript')).toBe(true);
      expect(tools.has('fathom_get_onboarding_context')).toBe(true);
    });

    it('should include Fathom tools in MANDATORY_FOUNDATION_TOOLS', () => {
      const mandatory = (AgentModeService as any).MANDATORY_FOUNDATION_TOOLS as string[];
      expect(mandatory).toContain('fathom_get_meetings');
      expect(mandatory).toContain('fathom_get_transcript');
      expect(mandatory).toContain('fathom_get_onboarding_context');
    });
  });

  describe('Approach 2: Meeting Intelligence built-in skill', () => {
    it('should have a built-in skill definition for Meeting Intelligence', () => {
      const meetingSkill = AgentModeService.BUILT_IN_SKILLS.find(
        s => s.name === 'Meeting Intelligence'
      );
      expect(meetingSkill).toBeDefined();
      expect(meetingSkill!.toolNames).toContain('fathom_get_meetings');
      expect(meetingSkill!.toolNames).toContain('fathom_get_transcript');
      expect(meetingSkill!.toolNames).toContain('fathom_get_onboarding_context');
      expect(meetingSkill!.category).toBe('tool_bundle');
    });

    it('should create the skill when it does not exist', async () => {
      (skillService.getAllSkills as jest.Mock).mockResolvedValue([]);

      await agentModeService.ensureBuiltInSkills();

      expect(skillService.createSkill).toHaveBeenCalledWith(
        'Meeting Intelligence',
        expect.stringContaining('Fathom'),
        ['fathom_get_meetings', 'fathom_get_transcript', 'fathom_get_onboarding_context'],
        undefined,
        true
      );
      expect(skillService.updateSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          isBuiltIn: true,
          category: 'tool_bundle',
        })
      );
    });

    it('should skip creation when skill already exists', async () => {
      (skillService.getAllSkills as jest.Mock).mockResolvedValue([
        {
          skillId: 'existing-id',
          name: 'Meeting Intelligence',
          description: 'Already exists',
          toolNames: ['fathom_get_meetings', 'fathom_get_transcript', 'fathom_get_onboarding_context'],
          isPublished: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          skillId: 'existing-id-2',
          name: 'Google Calendar',
          description: 'Already exists',
          toolNames: ['google_calendar_list_events', 'google_calendar_get_event', 'google_calendar_list_calendars'],
          isPublished: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      await agentModeService.ensureBuiltInSkills();

      expect(skillService.createSkill).not.toHaveBeenCalled();
    });

    it('should not throw when skill creation fails (non-fatal)', async () => {
      (skillService.getAllSkills as jest.Mock).mockRejectedValue(new Error('DynamoDB error'));

      // Should not throw
      await expect(agentModeService.ensureBuiltInSkills()).resolves.toBeUndefined();
    });
  });

  describe('Tool gating integration', () => {
    it('should allow Fathom tool calls via foundation tools without installing a skill', () => {
      // The tool gating logic in agentModeController checks foundationTools.has(funcName).
      // Since Fathom tools are now in DEFAULT_FOUNDATION_TOOLS, they pass the gate.
      const foundationTools = agentModeService.getFoundationToolNames();

      // Simulate the gating check from agentModeController.ts line ~855
      const funcName = 'fathom_get_meetings';
      const isAllowed = foundationTools.has(funcName);
      expect(isAllowed).toBe(true);

      const funcName2 = 'fathom_get_transcript';
      const isAllowed2 = foundationTools.has(funcName2);
      expect(isAllowed2).toBe(true);

      const funcName3 = 'fathom_get_onboarding_context';
      const isAllowed3 = foundationTools.has(funcName3);
      expect(isAllowed3).toBe(true);
    });
  });
});
