// Mock all dependencies (mirrors agentModeService.skills.test.ts's mocking approach)
jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn(),
    getSkillsByIds: jest.fn(),
    getSkillsAvailableToUser: jest.fn(),
    getSkillsByOwner: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addAssociatedSkills: jest.fn(),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
    addMessageToSession: jest.fn().mockResolvedValue(undefined),
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

import { AgentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { Skill } from '../services/skillService';

describe('AgentModeService - applyOpeningAction (ENG-712)', () => {
  let agentModeService: AgentModeService;

  const baseSkill: Skill = {
    skillId: 'skill-712',
    name: 'Reply Guy',
    description: 'Finds reply candidates',
    toolNames: ['find_reply_candidates'],
    isPublished: true,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();

    const mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService = {
      getSetting: jest.fn().mockResolvedValue(null),
    };
  });

  describe('no openingAction (AC5 — zero cost for unrelated skills)', () => {
    it('FAIL: does not call addMessageToSession or executeTool when the skill has no openingAction', async () => {
      const executeToolSpy = jest.spyOn(agentModeService, 'executeTool');

      const result = await agentModeService.applyOpeningAction(baseSkill, 'session-1', 'user-1');

      expect(result.applied).toBe(false);
      expect(chatbotDb.addMessageToSession).not.toHaveBeenCalled();
      expect(executeToolSpy).not.toHaveBeenCalled();
    });
  });

  describe('brief flavor', () => {
    it('FAIL: renders the static content as the first assistant turn', async () => {
      const skill: Skill = {
        ...baseSkill,
        openingAction: {
          type: 'brief',
          content: "Drop your artifact + your yap, and I'll draft from there.",
        },
      };

      const result = await agentModeService.applyOpeningAction(skill, 'session-2', 'user-1');

      expect(result.applied).toBe(true);
      expect(result.degraded).toBeFalsy();
      expect(chatbotDb.addMessageToSession).toHaveBeenCalledTimes(1);
      const [sessionIdArg, messageArg] = (chatbotDb.addMessageToSession as jest.Mock).mock.calls[0];
      expect(sessionIdArg).toBe('session-2');
      expect(messageArg.role).toBe('assistant');
      expect(messageArg.content).toBe("Drop your artifact + your yap, and I'll draft from there.");
    });
  });

  describe('prefetch flavor', () => {
    it('FAIL: runs the declared tool calls and renders the raw results, not LLM commentary', async () => {
      const skill: Skill = {
        ...baseSkill,
        openingAction: {
          type: 'prefetch',
          toolCalls: [{ toolName: 'find_reply_candidates', args: { count: 5 } }],
        },
      };

      const executeToolSpy = jest
        .spyOn(agentModeService, 'executeTool')
        .mockResolvedValue({ success: true, candidates: ['post-a', 'post-b'] });

      const result = await agentModeService.applyOpeningAction(skill, 'session-3', 'user-1');

      expect(executeToolSpy).toHaveBeenCalledWith(
        expect.any(String),
        'find_reply_candidates',
        { count: 5 },
        'user-1',
        'session-3',
        false,
      );
      expect(result.applied).toBe(true);
      expect(result.degraded).toBeFalsy();
      expect(chatbotDb.addMessageToSession).toHaveBeenCalledTimes(1);
      const [, messageArg] = (chatbotDb.addMessageToSession as jest.Mock).mock.calls[0];
      expect(messageArg.role).toBe('assistant');
      expect(messageArg.content).toContain('post-a');
      expect(messageArg.content).toContain('post-b');
    });

    it('FAIL: a failed tool result degrades loudly with an honest message, never fabricated material', async () => {
      const skill: Skill = {
        ...baseSkill,
        openingAction: {
          type: 'prefetch',
          toolCalls: [{ toolName: 'find_reply_candidates', args: {} }],
        },
      };

      jest
        .spyOn(agentModeService, 'executeTool')
        .mockResolvedValue({ success: false, error: 'upstream API down' });

      const result = await agentModeService.applyOpeningAction(skill, 'session-4', 'user-1');

      expect(result.applied).toBe(true);
      expect(result.degraded).toBe(true);
      expect(chatbotDb.addMessageToSession).toHaveBeenCalledTimes(1);
      const [, messageArg] = (chatbotDb.addMessageToSession as jest.Mock).mock.calls[0];
      expect(messageArg.role).toBe('assistant');
      // Never fabricates placeholder candidates
      expect(messageArg.content).not.toContain('post-a');
      expect(messageArg.content.toLowerCase()).toMatch(/couldn't|could not|unable/);
    });

    it('FAIL: a thrown exception during prefetch also degrades loudly instead of propagating', async () => {
      const skill: Skill = {
        ...baseSkill,
        openingAction: {
          type: 'prefetch',
          toolCalls: [{ toolName: 'find_reply_candidates', args: {} }],
        },
      };

      jest.spyOn(agentModeService, 'executeTool').mockRejectedValue(new Error('network blew up'));

      await expect(
        agentModeService.applyOpeningAction(skill, 'session-5', 'user-1')
      ).resolves.toEqual(expect.objectContaining({ applied: true, degraded: true }));
      expect(chatbotDb.addMessageToSession).toHaveBeenCalledTimes(1);
    });
  });
});
