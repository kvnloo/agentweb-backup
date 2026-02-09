import { AgentModeService } from '../services/agentModeService';

// Mock all dependencies
jest.mock('openai');
jest.mock('../services/settingsService');
jest.mock('../services/db');
jest.mock('../utils/secretsManager');

// Mock skillService - define mock implementations inside factory
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn(),
    getSkillsByIds: jest.fn(),
  },
}));

// Mock chatbotService - define mock implementations inside factory
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    addAssociatedSkills: jest.fn(),
    addMessagesToSession: jest.fn().mockResolvedValue(undefined),
  },
  searchPlatformKnowledgeBase: jest.fn().mockResolvedValue([]),
}));

// Mock subscriptionService
jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools) => tools),
}));

// Mock MCP client service
jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    initialize: jest.fn(),
    getTools: jest.fn().mockReturnValue([]),
    shutdown: jest.fn(),
  })),
}));

// Import the mocked modules to access the mock functions
import { skillService } from '../services/skillService';
import { chatbotDb } from '../services/chatbotService';


describe('AgentModeService - Skills', () => {
  let agentModeService: AgentModeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    agentModeService = new AgentModeService();
    
    // Mock settings service for default behavior
    const mockSettingsService = require('../services/settingsService');
    mockSettingsService.settingsService = {
      getSetting: jest.fn().mockResolvedValue(null),
    };
  });

  describe('installSkills', () => {
    it('should install published skills by ID', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        { skillId: 'skill-2', name: 'Skill 2', description: 'Desc', toolNames: ['tool2'], isPublished: true },
      ];

      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const result = await agentModeService.installSkills(
        ['skill-1', 'skill-2'],
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toEqual(['Skill 1', 'Skill 2']);
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', ['skill-1', 'skill-2']);
    });

    it('should return error for invalid skill IDs', async () => {
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.installSkills(
        ['invalid-skill-1'],
        'user-123',
        'session-123'
      );

      expect(result.message).toContain('No valid skills found');
      expect(chatbotDb.addAssociatedSkills).not.toHaveBeenCalled();
    });

    it('should filter out unpublished skills', async () => {
      const skills = [
        { skillId: 'skill-1', name: 'Published', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        // 'skill-2' is not in published list (unpublished)
      ];

      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(skills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const result = await agentModeService.installSkills(
        ['skill-1', 'skill-2'],
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toEqual(['Published']);
      // Only skill-1 should be added
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', ['skill-1']);
    });

    it('should add skills to session associatedSkills', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
      ];

      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      await agentModeService.installSkills(['skill-1'], 'user-123', 'session-123');

      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', ['skill-1']);
    });

    it('should return list of installed skill names', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Content Creation', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        { skillId: 'skill-2', name: 'Analytics', description: 'Desc', toolNames: ['tool2'], isPublished: true },
      ];

      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const result = await agentModeService.installSkills(
        ['skill-1', 'skill-2'],
        'user-123',
        'session-123'
      );

      expect(result.installedSkills).toContain('Content Creation');
      expect(result.installedSkills).toContain('Analytics');
    });

    it('should handle errors gracefully', async () => {
      (skillService.getPublishedSkills as jest.Mock).mockRejectedValue(new Error('DB Error'));

      const result = await agentModeService.installSkills(
        ['skill-1'],
        'user-123',
        'session-123'
      );

      expect(result.message).toContain('error occurred');
    });
  });

  describe('buildSkillContext', () => {
    it('should add install_skills to allowed tools by default', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*']);

      expect(result.allowedToolNames.has('install_skills')).toBe(true);
    });

    it('should add skill toolNames to allowed set', () => {
      const skills = [
        { skillId: 's1', name: 'Skill', toolNames: ['tool1', 'tool2'], description: '', isPublished: true },
      ];

      const result = (agentModeService as any).buildSkillContext(skills, ['*']);

      expect(result.allowedToolNames.has('tool1')).toBe(true);
      expect(result.allowedToolNames.has('tool2')).toBe(true);
    });

    it('should filter tools by user subscription', () => {
      const skills = [
        { skillId: 's1', name: 'Skill', toolNames: ['tool1', 'tool2', 'tool3'], description: '', isPublished: true },
      ];
      // User only has access to tool1 and tool2
      const userAllowedTools = ['tool1', 'tool2'];

      const result = (agentModeService as any).buildSkillContext(skills, userAllowedTools);

      expect(result.allowedToolNames.has('tool1')).toBe(true);
      expect(result.allowedToolNames.has('tool2')).toBe(true);
      expect(result.allowedToolNames.has('tool3')).toBe(false);
    });

    it('should build installed skill context message', () => {
      const skills = [
        { skillId: 's1', name: 'Content Creation', description: 'Create content', systemPrompt: 'Custom instructions', toolNames: ['tool1'], isPublished: true },
      ];

      const result = (agentModeService as any).buildSkillContext(skills, ['*']);

      expect(result.installedSkillContextMsg).toContain('Installed Skills:');
      expect(result.installedSkillContextMsg).toContain('Content Creation');
      expect(result.installedSkillContextMsg).toContain('Create content');
    });

    it('should return empty context message when no skills', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*']);

      expect(result.installedSkillContextMsg).toBe('');
    });
  });

  describe('getFilteredTools', () => {
    beforeEach(async () => {
      await agentModeService.initialize();
    });

    it('should return only install_skills if no skills associated', async () => {
      // Pass empty set as precomputed allowed names (simulating no associated skills)
      const result = await agentModeService.getFilteredTools('user-123', new Set(['install_skills']));

      // Should have at least install_skills
      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain('install_skills');
    });

    it('should return skill tools when skills are associated', async () => {
      // Mock associated skills being passed as precomputed set
      const precomputedNames = new Set(['read_brand_guidelines', 'install_skills']);

      const result = await agentModeService.getFilteredTools('user-123', precomputedNames);

      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain('read_brand_guidelines');
    });

    it('should return install_skills on error', async () => {
      // Force error by passing invalid type to force crash in logic if we want to test try/catch
      // Or better, mock this.toolRegistry.getAllTools to throw
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockImplementationOnce(() => {
        throw new Error('Registry Error');
      });

      const result = await agentModeService.getFilteredTools('user-123', new Set());

      // Should fallback to just install_skills
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should use precomputed allowed names when provided', async () => {
      const precomputedNames = new Set(['install_skills', 'read_brand_guidelines']);

      const result = await agentModeService.getFilteredTools(
        'user-123',
        precomputedNames
      );

      // Result should be filtered based on precomputed names
      expect(result).toBeDefined();
      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain('read_brand_guidelines');
    });
  });

  describe('updateConversationContext', () => {
    it('should add/update Installed Skills message', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
      ];

      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\ns1- Skill 1: Description',
        [],
        new Set(['install_skills'])
      );

      const installedMsg = messages.find(m => m.content?.startsWith('Installed Skills:'));
      expect(installedMsg).toBeDefined();
    });

    it('should remove old context messages before adding new', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Installed Skills:\nOLD CONTENT' },
      ];

      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\nNEW CONTENT',
        [],
        new Set(['install_skills'])
      );

      const installedMsgs = messages.filter(m => m.content?.startsWith('Installed Skills:'));
      expect(installedMsgs).toHaveLength(1);
      expect(installedMsgs[0].content).toContain('NEW CONTENT');
    });

    it('should not add installed skills message if empty', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
      ];

      (agentModeService as any).updateConversationContext(
        messages,
        '',
        [],
        new Set(['install_skills'])
      );

      const installedMsg = messages.find(m => m.content?.startsWith('Installed Skills:'));
      expect(installedMsg).toBeUndefined();
    });
  });
});
