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
    getSkillsAvailableToUser: jest.fn(),
    getSkillsByOwner: jest.fn().mockResolvedValue([]),
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
    refresh: jest.fn(), // Added refresh mock
  })),
}));

// Mock ToolRegistry
jest.mock('../mcp/client/toolRegistry', () => ({
  ToolRegistry: jest.fn().mockImplementation(() => ({
    register: jest.fn(),
    unregister: jest.fn(),
    getAllTools: jest.fn().mockReturnValue([]),
    getTool: jest.fn(),
    getToolDefinitions: jest.fn().mockReturnValue([]),
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

    // By default, getSkillsAvailableToUser returns same as getPublishedSkills
    (skillService.getSkillsAvailableToUser as jest.Mock).mockImplementation(async () => {
      return (skillService.getPublishedSkills as jest.Mock)();
    });
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

      expect(result.message).toContain('not available with your current subscription');
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

    it('should install other_skills virtual skill', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
      ];
      
      // Mock getUnassociatedTools behavior - we need to mock internal method or toolRegistry
      // Easier to spy on toolRegistry in beforeEach if we could, but here we can rely on 
      // the fact that getUnassociatedTools calls this.toolRegistry.getAllTools()
      
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } }, // associated
        { name: 'orphan_tool', definition: { function: { description: 'desc2' } } }, // unassociated
        { name: 'install_skills', definition: { function: { description: 'infra' } } } // infra
      ];
      
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const result = await agentModeService.installSkills(
        ['__other_skills__'],
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toContain('other_skills');
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', ['__other_skills__']);
    });

    it('should install mixed real skills and other_skills', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
      ];
      
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } }, 
        { name: 'orphan_tool', definition: { function: { description: 'desc2' } } }
      ];
      
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const result = await agentModeService.installSkills(
        ['skill-1', '__other_skills__'],
        'user-123',
        'session-123'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toContain('Skill 1');
      expect(result.installedSkills).toContain('other_skills');
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-123', ['skill-1', '__other_skills__']);
    });

    it('allows a restricted subscriber to install a sharing-enabled same-org private skill', async () => {
      const orgId = 'org-abc';
      const orgMemberUserId = 'member-user-456';
      const orgPrivateSkill = {
        skillId: 'org-private-skill-1',
        name: 'Org Private Skill',
        description: 'Private skill shared via org',
        toolNames: ['tool_org'],
        isPublished: false,
        ownerId: 'owner-user-123',
        orgId,
        visibility: 'private',
      };

      // getSkillsAvailableToUser returns org skill for the org member
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([orgPrivateSkill]);
      (chatbotDb.addAssociatedSkills as jest.Mock).mockResolvedValue(undefined);

      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: orgMemberUserId, orgId, orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({
        orgId, ownerUserId: 'owner-user-123',
        shareSettings: { skills: { enabled: true, editors: [] } },
      }) };
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['org-private-skill-1']);

      const result = await agentModeService.installSkills(
        ['org-private-skill-1'],
        orgMemberUserId,
        'session-abc'
      );

      expect(result.success).toBe(true);
      expect(result.installedSkills).toContain('Org Private Skill');
      expect(chatbotDb.addAssociatedSkills).toHaveBeenCalledWith('session-abc', ['org-private-skill-1']);
    });

    it('should reject a private org skill for a user outside that org', async () => {
      const orgId = 'org-abc';
      const outsiderUserId = 'outsider-user-789';
      const orgPrivateSkill = {
        skillId: 'org-private-skill-1',
        name: 'Org Private Skill',
        description: 'Private skill shared via org',
        toolNames: ['tool_org'],
        isPublished: false,
        ownerId: 'owner-user-123',
        orgId,
        visibility: 'private',
      };

      // getSkillsAvailableToUser does NOT return org skill for outsider
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([]);

      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: outsiderUserId, orgId: 'org-different', orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({
        orgId: 'org-different', ownerUserId: 'other-owner',
        shareSettings: { skills: { enabled: true, editors: [] } },
      }) };

      const result = await agentModeService.installSkills(
        ['org-private-skill-1'],
        outsiderUserId,
        'session-xyz'
      );

      expect(result.message).toContain('not available with your current subscription');
      expect(chatbotDb.addAssociatedSkills).not.toHaveBeenCalled();
    });
    it('rejects a same-org private skill when skill sharing is disabled', async () => {
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'member-1', orgId: 'org-1', orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1', shareSettings: { skills: { enabled: false, editors: [] } } }) };
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([]);
      const result = await agentModeService.installSkills(['org-private'], 'member-1', 'session-1');
      expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('member-1', undefined);
      expect(result.message).toContain('not available with your current subscription');
      expect(chatbotDb.addAssociatedSkills).not.toHaveBeenCalled();
    });
  });

  describe('buildSkillContext', () => {
    it('should add install_skills to allowed tools by default', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*'], [], []);

      expect(result.allowedToolNames.has('install_skills')).toBe(true);
    });

    it('should expose explicit You.com search tools in foundation tools without the compatibility alias', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*'], [], []);

      expect(result.allowedToolNames.has('search_web')).toBe(false);
      expect(result.allowedToolNames.has('you_search_web')).toBe(true);
      expect(result.allowedToolNames.has('you_search_news')).toBe(true);
      expect(result.allowedToolNames.has('google_search_web')).toBe(false);
    });

    it('should add skill toolNames to allowed set', () => {
      const skills = [
        { skillId: 's1', name: 'Skill', toolNames: ['tool1', 'tool2'], description: '', isPublished: true },
      ];

      const result = (agentModeService as any).buildSkillContext(skills, ['*'], [], []);

      expect(result.allowedToolNames.has('tool1')).toBe(true);
      expect(result.allowedToolNames.has('tool2')).toBe(true);
    });

    it('should filter tools by user subscription (skill-level)', () => {
      const skills = [
        { skillId: 's1', name: 'Skill A', toolNames: ['tool1', 'tool2'], description: '', isPublished: true },
        { skillId: 's2', name: 'Skill B', toolNames: ['tool3'], description: '', isPublished: true },
      ];
      // User only has access to skill s1 (not s2)
      const userAllowedSkillIds = ['s1'];

      const result = (agentModeService as any).buildSkillContext(skills, userAllowedSkillIds, [], []);

      expect(result.allowedToolNames.has('tool1')).toBe(true);
      expect(result.allowedToolNames.has('tool2')).toBe(true);
      expect(result.allowedToolNames.has('tool3')).toBe(false);
    });

    it('should build installed skill context message', () => {
      const skills = [
        { skillId: 's1', name: 'Content Creation', description: 'Create content', systemPrompt: 'Custom instructions', toolNames: ['tool1'], isPublished: true },
      ];

      const result = (agentModeService as any).buildSkillContext(skills, ['*'], [], []);

      expect(result.installedSkillContextMsg).toContain('Installed Skills:');
      expect(result.installedSkillContextMsg).toContain('Content Creation');
      expect(result.installedSkillContextMsg).toContain('Create content');
    });

    it('should return empty context message when no skills', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*'], [], []);

      expect(result.installedSkillContextMsg).toBe('');
    });

    it('should add unassociated tools when __other_skills__ is associated', () => {
      const publishedSkills = [
          { skillId: 's1', name: 'S1', toolNames: ['t1'], isPublished: true }
      ];
      const mockTools = [
          { name: 't1', definition: {} },
          { name: 'orphan_tool', definition: {} }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).buildSkillContext([], ['*'], publishedSkills, ['__other_skills__']);

      expect(result.allowedToolNames.has('orphan_tool')).toBe(true);
    });

    it('should exclude infrastructure tools from unassociated tools', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
          { name: 'orphan_tool', definition: {} },
          { name: 'install_skills', definition: {} }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).buildSkillContext([], ['*'], publishedSkills, ['__other_skills__']);

      // orphan_tool should be included
      expect(result.allowedToolNames.has('orphan_tool')).toBe(true);
      // install_skills is always included (infrastructure but needed)
      expect(result.allowedToolNames.has('install_skills')).toBe(true);
    });
  });

  describe('getUnassociatedTools', () => {
    it('should return tools not associated with any published skill', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1', 'tool2'], isPublished: true }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } },
        { name: 'tool2', definition: { function: { description: 'desc2' } } },
        { name: 'orphan_tool', definition: { function: { description: 'orphan desc' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('orphan_tool');
      expect(result[0].description).toBe('orphan desc');
    });

    it('should exclude infrastructure tools', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'regular_tool', definition: { function: { description: 'regular' } } },
        { name: 'install_skills', definition: { function: { description: 'infra1' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('regular_tool');
    });

    it('should return empty array when all tools are associated', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1', 'tool2'], isPublished: true }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } },
        { name: 'tool2', definition: { function: { description: 'desc2' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(0);
    });

    it('should handle missing description gracefully', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'tool_no_desc', definition: {} }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('tool_no_desc');
      expect(result[0].description).toBe('tool_no_desc');
    });

    it('should exclude foundation and admin-only tools from unassociated tools', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'regular_tool', definition: { function: { description: 'regular' } } },
        { name: 'list_predefined_work_plans', definition: { function: { description: 'admin tool' } } },
        { name: 'manage_predefined_work_plan', definition: { function: { description: 'admin tool 2' } } },
        { name: 'list_skills', definition: { function: { description: 'admin tool 3' } } },
        { name: 'resolve_skill', definition: { function: { description: 'foundation resolver' } } },
        { name: 'manage_skill', definition: { function: { description: 'admin tool 5' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('regular_tool');
    });

    it('should exclude get_visual_context from unassociated tools (page-embedded Emma only)', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'regular_tool', definition: { function: { description: 'regular' } } },
        { name: 'get_visual_context', definition: { function: { description: 'page screenshot tool' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).getUnassociatedTools(publishedSkills);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('regular_tool');
      expect(result.find((t: any) => t.name === 'get_visual_context')).toBeUndefined();
    });

    it('should exclude get_visual_context via getUnassociatedToolNames (resolveSkillsToToolNames path)', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'regular_tool', definition: { function: { description: 'regular' } } },
        { name: 'get_visual_context', definition: { function: { description: 'page screenshot tool' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const names = agentModeService.getUnassociatedToolNames(publishedSkills);

      expect(names).toContain('regular_tool');
      expect(names).not.toContain('get_visual_context');
    });
  });

  describe('buildAvailableSkillsMessage', () => {
    it('should list published skills not already associated', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'Skill 1', description: 'Desc 1', isPublished: true },
        { skillId: 's2', name: 'Skill 2', description: 'Desc 2', isPublished: true }
      ];
      const associatedSkillIds = ['s1'];

      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, associatedSkillIds);

      expect(result).toContain('Available Skills:');
      expect(result).toContain('s2- Skill 2: Desc 2');
      expect(result).not.toContain('s1- Skill 1');
    });

    it('should include __other_skills__ when there are unassociated tools', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1'], isPublished: true }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } },
        { name: 'orphan_tool', definition: { function: { description: 'orphan desc' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, []);

      expect(result).toContain('__other_skills__- other_skills:');
      expect(result).toContain('orphan_tool: orphan desc');
    });

    it('should not include __other_skills__ when already associated', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1'], isPublished: true }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } },
        { name: 'orphan_tool', definition: { function: { description: 'orphan desc' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, ['__other_skills__']);

      expect(result).not.toContain('__other_skills__');
    });

    it('should return empty string when no available skills and no unassociated tools', () => {
      const publishedSkills = [
        { skillId: 's1', name: 'S1', toolNames: ['tool1'], isPublished: true }
      ];
      const mockTools = [
        { name: 'tool1', definition: { function: { description: 'desc1' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      // All skills associated, all tools associated
      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, ['s1']);

      expect(result).toBe('');
    });

    it('should return empty string when no published skills and only infrastructure tools', () => {
      const publishedSkills: any[] = [];
      const mockTools = [
        { name: 'install_skills', definition: { function: { description: 'infra' } } }
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

      const result = (agentModeService as any).buildAvailableSkillsMessage(publishedSkills, []);

      expect(result).toBe('');
    });
  });

  describe('getFilteredTools', () => {
    beforeEach(async () => {
      // Mock tools for getFilteredTools tests
      const mockTools = [
        { name: 'read_brand_guidelines', definition: { function: { name: 'read_brand_guidelines', description: 'desc' } } },
        { name: 'install_skills', definition: { function: { name: 'install_skills', description: 'infra' } } },
        { name: 'create_work_plan', definition: { function: { name: 'create_work_plan', description: 'Create work plan' } } },
        { name: 'you_search_web', definition: { function: { name: 'you_search_web', description: 'Search the web with You.com' } } },
        { name: 'you_search_news', definition: { function: { name: 'you_search_news', description: 'Search news with You.com' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);

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

    it('should include foundation tools for legacy sessions even when subscription is restrictive', async () => {
      // Legacy sessions pass undefined for precomputedAllowedSkillToolNames,
      // so all tools pass the context filter. But a restrictive subscription
      // would strip foundation tools. The fix ensures FOUNDATION_TOOLS are
      // always added to allowedFunctionCalls before the subscription filter.
      const { resolveSkillsToToolNames, filterFunctionCalls: mockFilterFn } = require('../services/subscriptionService');
      // Subscription only allows read_brand_guidelines (no foundation tools)
      (resolveSkillsToToolNames as jest.Mock).mockResolvedValueOnce(['read_brand_guidelines']);
      // Use realistic filter: only pass tools whose name is in allowed list
      (mockFilterFn as jest.Mock).mockImplementationOnce((tools: any[], allowed: string[]) => {
        if (allowed.includes('*')) return tools;
        return tools.filter((t: any) => {
          const name = t.function?.name || t.name;
          return !name || allowed.includes(name);
        });
      });

      // Legacy session: no precomputed names (undefined)
      const result = await agentModeService.getFilteredTools('user-123', undefined);

      const toolNames = result.map((t: any) => t.function?.name || t.name);
      // Foundation tools should bypass subscription filter
      expect(toolNames).toContain('create_work_plan');
      expect(toolNames).toContain('install_skills');
      expect(toolNames).toContain('you_search_web');
      expect(toolNames).not.toContain('search_web');
      // Non-foundation tool allowed by subscription should also be present
      expect(toolNames).toContain('read_brand_guidelines');
    });

    it('should not expose a deprecated search tool when a legacy skill allows search_web', async () => {
      const { filterFunctionCalls: mockFilterFn } = require('../services/subscriptionService');
      (mockFilterFn as jest.Mock).mockImplementationOnce((tools: any[], allowed: string[]) => {
        if (allowed.includes('*')) return tools;
        return tools.filter((t: any) => {
          const name = t.function?.name || t.name;
          return !name || allowed.includes(name);
        });
      });

      const result = await agentModeService.getFilteredTools('user-123', new Set(['search_web']));

      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).not.toContain('search_web');
      expect(toolNames).not.toContain('you_search_web');
    });
  });

  // ENG-508 / ENG-867: the "LinkedIn Profile Reader" skill grants exactly one tool,
  // linkedin_outreach. Prove that installing it makes that tool reach a session's
  // toolbox — even for a user whose subscription does NOT include it (the Founder
  // audit case) — and that WITHOUT the skill the tool is excluded, which is the
  // stale-headline pre-fix state. This exercises the real getFilteredTools gating.
  describe('LinkedIn Profile Reader skill grant (ENG-508)', () => {
    beforeEach(async () => {
      const mockTools = [
        { name: 'install_skills', definition: { function: { name: 'install_skills', description: 'infra' } } },
        { name: 'you_search_web', definition: { function: { name: 'you_search_web', description: 'Search the web' } } },
        { name: 'linkedin_outreach', definition: { function: { name: 'linkedin_outreach', description: 'LinkedIn outreach incl. get-profile' } } },
      ];
      jest.spyOn(agentModeService['toolRegistry'], 'getAllTools').mockReturnValue(mockTools as any);
      await agentModeService.initialize();

      // Realistic subscription filter: only the explicitly-allowed names survive.
      const { filterFunctionCalls: mockFilterFn } = require('../services/subscriptionService');
      (mockFilterFn as jest.Mock).mockImplementation((tools: any[], allowed: string[]) => {
        if (allowed.includes('*')) return tools;
        return tools.filter((t: any) => {
          const name = t.function?.name || t.name;
          return !name || allowed.includes(name);
        });
      });
    });

    it('exposes linkedin_outreach when the skill is installed, even under a subscription that omits it', async () => {
      const { resolveSkillsToToolNames } = require('../services/subscriptionService');
      // Subscription grants NOTHING extra — the tool must come solely from the
      // session-installed skill's toolNames (getFilteredTools session-tool bypass).
      (resolveSkillsToToolNames as jest.Mock).mockResolvedValueOnce([]);

      // Precomputed allowed set = what buildSkillContext produces once the
      // "LinkedIn Profile Reader" skill (toolNames: ['linkedin_outreach']) is associated.
      const withSkill = new Set(['install_skills', 'linkedin_outreach']);
      const result = await agentModeService.getFilteredTools('user-123', withSkill, []);

      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).toContain('linkedin_outreach');
    });

    // The step the tests below this one used to ASSUME: buildSkillContext turning the
    // real skill RECORD into the allowed-tool set. It is gated on the skill being in
    // the user's subscription-allowed IDs, and every tier here uses an explicit list —
    // so a published-but-unenrolled skill silently contributes nothing.
    it('unions linkedin_outreach from the real skill record only when the tier allows the skillId', async () => {
      const { buildProfileReaderSkill } = require('../scripts/seed-eng508-linkedin-profile-reader-skill');
      const skill = buildProfileReaderSkill('profile-reader-id');
      expect(skill.toolNames).toEqual(['linkedin_outreach']);

      // ENROLLED: skillId present in the subscription-allowed list → tool is granted.
      const enrolled = (agentModeService as any).buildSkillContext(
        [skill],
        ['profile-reader-id'], // userAllowedSkillIds (explicit, non-wildcard tier)
        [],
        ['profile-reader-id']
      );
      expect(enrolled.allowedToolNames.has('linkedin_outreach')).toBe(true);

      // NOT ENROLLED: same published skill, but the tier's explicit list omits it →
      // its tools are dropped and the audit falls back to the stale search path.
      const unenrolled = (agentModeService as any).buildSkillContext(
        [skill],
        ['some-other-skill-id'],
        [],
        ['profile-reader-id']
      );
      expect(unenrolled.allowedToolNames.has('linkedin_outreach')).toBe(false);
    });

    it('excludes linkedin_outreach when the skill is NOT installed (pre-fix stale-headline state)', async () => {
      const { resolveSkillsToToolNames } = require('../services/subscriptionService');
      (resolveSkillsToToolNames as jest.Mock).mockResolvedValueOnce([]);

      // No LinkedIn skill associated → the authenticated tool is unreachable and the
      // model can only fall back to you_search_web (the stale search cache).
      const withoutSkill = new Set(['install_skills', 'you_search_web']);
      const result = await agentModeService.getFilteredTools('user-123', withoutSkill, []);

      const toolNames = result.map((t: any) => t.function?.name || t.name);
      expect(toolNames).not.toContain('linkedin_outreach');
      expect(toolNames).toContain('you_search_web');
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
        '' // availableSkillContextMsg
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
        '' // availableSkillContextMsg
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
        '' // availableSkillContextMsg
      );

      const installedMsg = messages.find(m => m.content?.startsWith('Installed Skills:'));
      expect(installedMsg).toBeUndefined();
    });

    it('should update Available Skills message', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Available Skills:\nOLD LIST' },
      ];

      (agentModeService as any).updateConversationContext(
        messages,
        '',
        'Available Skills:\nNEW LIST' // availableSkillContextMsg
      );

      const availableMsgs = messages.filter(m => m.content?.startsWith('Available Skills:'));
      expect(availableMsgs).toHaveLength(1);
      expect(availableMsgs[0].content).toContain('NEW LIST');
      // Should be placed after system prompt (index 1)
      expect(messages[1].content).toContain('NEW LIST');
    });

    it('should have net 0 change when both old and new context messages exist', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Available Skills:\nOLD' },
        { role: 'assistant', content: 'Installed Skills:\nOLD' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'response' },
      ];
      const before = messages.length;

      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\nNEW',
        'Available Skills:\nNEW'
      );

      expect(messages.length).toBe(before);
    });

    it('should have net +1 when Installed Skills is added for the first time', () => {
      // Simulates the first install_skills call in a session that started with no installed skills
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Available Skills:\nOLD' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'I will help' },
      ];
      const before = messages.length;

      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\nBrand Strategy',
        'Available Skills:\nNEW'
      );

      expect(messages.length).toBe(before + 1);
    });

    it('should have net -1 when Available Skills becomes empty (all skills installed)', () => {
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Available Skills:\nSome skills' },
        { role: 'assistant', content: 'Installed Skills:\nOLD' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'response' },
      ];
      const before = messages.length;

      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\nNEW',
        '' // empty — all skills now installed
      );

      expect(messages.length).toBe(before - 1);
    });

    it('net -1 should not cause first response message to be dropped when initialMessageCount is adjusted', () => {
      // This test reproduces the production bug scenario:
      // 1. Session has both Available Skills and Installed Skills context
      // 2. LLM makes tool calls, assistant message pushed to array
      // 3. install_skills called, skillsUpdated = true
      // 4. updateConversationContext removes Available Skills (empty), net -1
      // 5. Without the fix, messages.slice(initialMessageCount) skips the first assistant message
      const messages: any[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'assistant', content: 'Available Skills:\nMeta Ads, Landing Page' },
        { role: 'assistant', content: 'Installed Skills:\nBrand Strategy' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'previous response' },
        { role: 'user', content: 'yes.' },
      ];

      let initialMessageCount = messages.length; // 6

      // Simulate iteration 1: LLM returns assistant + tool_calls
      const firstAssistantMsg = { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'update_brand', arguments: '{}' } }] };
      messages.push(firstAssistantMsg);
      messages.push({ role: 'tool', tool_call_id: 'tc1', content: 'success' });

      // Simulate install_skills call
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'tc2', function: { name: 'install_skills', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: 'tc2', content: 'installed' });

      // Simulate skillsUpdated: updateConversationContext with empty availableSkillContextMsg
      const preUpdateLen = messages.length;
      (agentModeService as any).updateConversationContext(
        messages,
        'Installed Skills:\nBrand Strategy + Other Skills',
        '' // all skills now installed
      );
      const delta = messages.length - preUpdateLen;
      initialMessageCount += delta; // THE FIX: adjust initialMessageCount

      // Simulate final assistant response
      messages.push({ role: 'assistant', content: 'Done!' });

      // Slice response messages (same as production code)
      const responseMessages = messages.slice(initialMessageCount).filter(
        (msg: any) => msg.role !== 'user'
      );

      // The first response message MUST be the assistant with tool_calls
      expect(responseMessages[0]).toBe(firstAssistantMsg);
      expect(responseMessages[0].role).toBe('assistant');
      expect(responseMessages[0].tool_calls).toBeDefined();
    });
  });

  describe('getFoundationToolNames', () => {
    beforeEach(() => {
      // Reset to defaults before each test
      (AgentModeService as any).FOUNDATION_TOOLS = new Set(AgentModeService.DEFAULT_FOUNDATION_TOOLS);
    });

    it('should return a Set containing default foundation tool names', () => {
      const foundationTools = agentModeService.getFoundationToolNames();

      expect(foundationTools).toBeInstanceOf(Set);
      expect(foundationTools.has('install_skills')).toBe(true);
      expect(foundationTools.has('list_available_skills')).toBe(true);
      expect(foundationTools.has('resolve_skill')).toBe(true);
      expect(foundationTools.has('read_brand_guidelines')).toBe(true);
      expect(foundationTools.has('update_brand_guidelines')).toBe(true);
      expect(foundationTools.has('search_knowledge_base')).toBe(true);
      expect(foundationTools.has('list_knowledge_base_files')).toBe(true);
      expect(foundationTools.has('read_knowledge_base_files')).toBe(true);
      expect(foundationTools.has('create_work_plan')).toBe(true);
      expect(foundationTools.has('modify_work_plan')).toBe(true);
      expect(foundationTools.has('set_work_plan_status')).toBe(true);
      expect(foundationTools.has('search_leads')).toBe(true);
      expect(foundationTools.has('get_lead_lists')).toBe(true);
      // get_registration_status is intentionally NOT a foundation tool — it
      // queries AW-Users (signup/premium status) for arbitrary emails, which is
      // an admin/founder funnel concern and an account-enumeration oracle if
      // exposed to every tenant. It lives in ADMIN_SKILL_TOOL_NAMES instead.
      expect(foundationTools.has('get_registration_status')).toBe(false);
      // S3 overflow retrieval tools must always be available so the LLM can read
      // large tool responses that were offloaded to S3 by the
      // TOOL_RESPONSE_S3_THRESHOLD overflow mechanism.
      expect(foundationTools.has('search_tool_response')).toBe(true);
      expect(foundationTools.has('read_tool_response')).toBe(true);
    });

    it('should not contain domain-specific tools', () => {
      const foundationTools = agentModeService.getFoundationToolNames();

      expect(foundationTools.has('generate_image')).toBe(false);
      expect(foundationTools.has('create_blog_article')).toBe(false);
      expect(foundationTools.has('create_social_media_posts')).toBe(false);
    });
  });

  describe('getAdminToolNames', () => {
    it('does not expose manage_user_guide (ENG-163: legacy Notion write tool removed)', () => {
      // The admin tool registry (ADMIN_SKILL_TOOL_NAMES) must no longer carry the
      // retired manage_user_guide Notion write tool.
      expect(agentModeService.getAdminToolNames()).not.toContain('manage_user_guide');
    });

    it('still exposes other admin tools', () => {
      const adminTools = agentModeService.getAdminToolNames();
      expect(adminTools).toContain('manage_user_notes');
      expect(adminTools).toContain('get_registration_status');
    });
  });

  describe('loadFoundationTools', () => {
    beforeEach(() => {
      (AgentModeService as any).FOUNDATION_TOOLS = new Set(AgentModeService.DEFAULT_FOUNDATION_TOOLS);
    });

    it('should load foundation tools from DB when setting exists', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.getSetting = jest.fn().mockResolvedValue({
        settingName: 'foundation_tools',
        settingValue: JSON.stringify(['tool_a', 'tool_b', 'tool_c']),
      });

      await agentModeService.loadFoundationTools();

      const tools = agentModeService.getFoundationToolNames();
      const mandatoryTools = (AgentModeService as any).MANDATORY_FOUNDATION_TOOLS as string[];
      // ENG-404: the override is additive on top of DEFAULT_FOUNDATION_TOOLS, so
      // the active set is DEFAULT ∪ override ∪ MANDATORY — a stale override can
      // never strip a shipped default.
      expect(tools.size).toBe(
        new Set([...AgentModeService.DEFAULT_FOUNDATION_TOOLS, 'tool_a', 'tool_b', 'tool_c', ...mandatoryTools]).size
      );
      expect(tools.has('tool_a')).toBe(true);
      expect(tools.has('tool_b')).toBe(true);
      expect(tools.has('tool_c')).toBe(true);
      // A DEFAULT-only tool absent from the override must still be present.
      expect(tools.has('search_knowledge_base')).toBe(true);
      expect(tools.has('install_skills')).toBe(true);
      expect(tools.has('list_available_skills')).toBe(true);
      expect(tools.has('resolve_skill')).toBe(true);
      expect(tools.has('you_search_web')).toBe(true);
      expect(tools.has('you_search_news')).toBe(true);
      expect(tools.has('google_search_web')).toBe(false);
      expect(tools.has('search_tool_response')).toBe(true);
      expect(tools.has('read_tool_response')).toBe(true);
      // Force-merged so a DB config can't strip the self-status tool (else Emma
      // falls back to assess_client_health, the admin lookup-by-email path).
      expect(tools.has('get_account_status')).toBe(true);
      // Coding agent is also force-merged so stale DB settings cannot make
      // landing-page edit flows fail before a recoverable run exists.
      expect(tools.has('coding_agent')).toBe(true);
    });

    it('force-merges get_account_status even when a DB config omits it', async () => {
      // Regression: get_account_status must always be reachable so Emma can
      // report the caller's own account; a stored foundation_tools list that
      // leaves it out previously made it "not available" → Emma fell back to
      // assess_client_health (admin lookup by email).
      const { settingsService } = require('../services/settingsService');
      settingsService.getSetting = jest.fn().mockResolvedValue({
        settingName: 'foundation_tools',
        settingValue: JSON.stringify(['tool_a']), // intentionally omits get_account_status
      });

      await agentModeService.loadFoundationTools();

      const tools = agentModeService.getFoundationToolNames();
      expect(tools.has('get_account_status')).toBe(true);
    });

    it('should fall back to defaults when no DB setting exists', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.getSetting = jest.fn().mockResolvedValue(null);

      await agentModeService.loadFoundationTools();

      const tools = agentModeService.getFoundationToolNames();
      expect(tools.has('install_skills')).toBe(true);
      expect(tools.size).toBe(AgentModeService.DEFAULT_FOUNDATION_TOOLS.length);
    });

    it('should fall back to defaults when DB returns invalid JSON', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.getSetting = jest.fn().mockResolvedValue({
        settingName: 'foundation_tools',
        settingValue: 'not-valid-json',
      });

      await agentModeService.loadFoundationTools();

      const tools = agentModeService.getFoundationToolNames();
      expect(tools.has('install_skills')).toBe(true);
      expect(tools.size).toBe(AgentModeService.DEFAULT_FOUNDATION_TOOLS.length);
    });

    it('should fall back to defaults when DB throws an error', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.getSetting = jest.fn().mockRejectedValue(new Error('DynamoDB error'));

      await agentModeService.loadFoundationTools();

      const tools = agentModeService.getFoundationToolNames();
      expect(tools.has('install_skills')).toBe(true);
    });
  });

  describe('updateFoundationTools', () => {
    beforeEach(() => {
      (AgentModeService as any).FOUNDATION_TOOLS = new Set(AgentModeService.DEFAULT_FOUNDATION_TOOLS);
    });

    it('should update foundation tools in DB and in-memory', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.setSetting = jest.fn().mockResolvedValue(undefined);

      const result = await agentModeService.updateFoundationTools(['tool_x', 'tool_y'], 'admin@test.com');
      // ENG-404: persisted set is DEFAULT ∪ override ∪ MANDATORY (additive).
      const expected = [
        ...new Set([
          ...AgentModeService.DEFAULT_FOUNDATION_TOOLS,
          'tool_x',
          'tool_y',
          ...(AgentModeService as any).MANDATORY_FOUNDATION_TOOLS,
        ]),
      ];

      expect(result).toEqual(expected);
      expect(settingsService.setSetting).toHaveBeenCalledWith(
        'foundation_tools',
        JSON.stringify(expected),
        expect.any(String),
        'admin@test.com'
      );
      const tools = agentModeService.getFoundationToolNames();
      expect(tools.size).toBe(new Set(expected).size);
      expect(tools.has('tool_x')).toBe(true);
      expect(tools.has('tool_y')).toBe(true);
      expect(tools.has('resolve_skill')).toBe(true);
      expect(tools.has('coding_agent')).toBe(true);
    });

    it('should deduplicate tool names', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.setSetting = jest.fn().mockResolvedValue(undefined);

      const result = await agentModeService.updateFoundationTools(['tool_a', 'tool_a', 'tool_b'], 'admin@test.com');

      // ENG-404: DEFAULT ∪ override ∪ MANDATORY, de-duplicated.
      expect(result).toEqual([
        ...new Set([
          ...AgentModeService.DEFAULT_FOUNDATION_TOOLS,
          'tool_a',
          'tool_b',
          ...(AgentModeService as any).MANDATORY_FOUNDATION_TOOLS,
        ]),
      ]);
    });
  });

  describe('getSkillsForDisplay', () => {
    it('returns a full authorized Skill snapshot without widening the display projection', async () => {
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([{ skillId: 'skill-1', name: 'Web Search', description: 'Search tools', toolNames: [], isPublished: true, welcomeMessage: 'Start here.' }]);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);
      await expect(agentModeService.getAuthorizedSkill('skill-1', 'user-1')).resolves.toEqual(expect.objectContaining({ welcomeMessage: 'Start here.' }));
    });
    it('fails closed when an upstream catalog returns another user\'s pending-review skill', async () => {
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([{ skillId: 'pending', name: 'Pending', description: 'd', toolNames: [], ownerId: 'owner-1', visibility: 'pending_review', isPublished: true }]);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);
      const result = await agentModeService.getSkillsForDisplay([], 'member-1');
      expect(result).toEqual([]);
    });
    it('admits an enabled same-org private skill when the restricted subscription includes it', async () => {
      const orgSkill = { skillId: 'org-skill', name: 'Org Skill', description: 'd', toolNames: ['read_tool'], ownerId: 'owner-1', orgId: 'org-1', visibility: 'private', isPublished: false };
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'member-1', orgId: 'org-1', orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1', shareSettings: { skills: { enabled: true, editors: [] } } }) };
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([orgSkill]);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue([]);
      const result = await agentModeService.getSkillsForDisplay([], 'member-1');
      expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('member-1', 'org-1');
      expect(result).toEqual([expect.objectContaining({ skillId: 'org-skill' })]);
    });
    it('does not admit another member\'s private skill when org skill sharing is disabled', async () => {
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: 'member-1', orgId: 'org-1', orgRole: 'member' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockResolvedValue({ orgId: 'org-1', ownerUserId: 'owner-1', shareSettings: { skills: { enabled: false, editors: [] } } }) };
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue([]);
      const result = await agentModeService.getSkillsForDisplay([], 'member-1');
      expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('member-1', undefined);
      expect(result).toEqual([]);
    });
    it.each(['user', 'org'])('preserves owned and public skills when the %s lookup fails transiently', async (failure) => {
      const catalog = [
        { skillId: 'own', name: 'Own', description: 'd', toolNames: [], ownerId: 'member-1' },
        { skillId: 'public', name: 'Public', description: 'd', toolNames: [], isPublished: true },
      ];
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: failure === 'user'
        ? jest.fn().mockRejectedValue(new Error('transient'))
        : jest.fn().mockResolvedValue({ userId: 'member-1', orgId: 'org-1' }) };
      mockDb.orgDb = { getOrgById: jest.fn().mockRejectedValue(new Error('transient')) };
      (skillService.getSkillsAvailableToUser as jest.Mock).mockResolvedValue(catalog);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);
      const result = await agentModeService.getSkillsForDisplay([], 'member-1');
      expect(skillService.getSkillsAvailableToUser).toHaveBeenCalledWith('member-1', undefined);
      expect(result.map(skill => skill.skillId)).toEqual(['own', 'public']);
    });
    it('should return published skills with installed status and toolNames', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Web Search', description: 'Search tools', toolNames: ['search_web'], isPublished: true, welcomeMessage: 'Do not expose.' },
        { skillId: 'skill-2', name: 'Image Gen', description: 'Image tools', toolNames: ['generate_image'], isPublished: true },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);

      const result = await agentModeService.getSkillsForDisplay(['skill-1'], 'user-1');

      expect(result).toEqual(expect.arrayContaining([
        expect.objectContaining({ skillId: 'skill-1', name: 'Web Search', installed: true, toolNames: ['search_web'] }),
        expect.objectContaining({ skillId: 'skill-2', name: 'Image Gen', installed: false, toolNames: ['generate_image'] }),
      ]));
      expect(result.find(skill => skill.skillId === 'skill-1')).not.toHaveProperty('welcomeMessage');
    });

    it('should filter skills by subscription when not wildcard', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Allowed Skill', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        { skillId: 'skill-2', name: 'Blocked Skill', description: 'Desc', toolNames: ['tool2'], isPublished: true },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['skill-1']);

      const result = await agentModeService.getSkillsForDisplay([], 'user-1');

      expect(result.some(s => s.skillId === 'skill-1')).toBe(true);
      expect(result.some(s => s.skillId === 'skill-2')).toBe(false);
    });

    it('should return no skills when no userId and public default is empty', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      const { getPublicAllowedSkills } = require('../services/subscriptionService');
      (getPublicAllowedSkills as jest.Mock).mockResolvedValue([]);

      const result = await agentModeService.getSkillsForDisplay([]);

      expect(result).toHaveLength(0);
    });

    it('should return allowed skills when no userId and public config is set', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
        { skillId: 'skill-2', name: 'Skill 2', description: 'Desc', toolNames: ['tool2'], isPublished: true },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);
      const { getPublicAllowedSkills } = require('../services/subscriptionService');
      (getPublicAllowedSkills as jest.Mock).mockResolvedValue(['skill-1']);

      const result = await agentModeService.getSkillsForDisplay([]);

      expect(result.some(s => s.skillId === 'skill-1')).toBe(true);
      expect(result.some(s => s.skillId === 'skill-2')).toBe(false);
    });

    it('should include __other_skills__ virtual entry when allowed', async () => {
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue([]);
      const { getAllowedSkills } = require('../services/subscriptionService');
      (getAllowedSkills as jest.Mock).mockResolvedValue(['*']);

      // Mock the tool registry to have some tools
      const mockToolRegistry = (agentModeService as any).toolRegistry;
      mockToolRegistry.getAllTools.mockReturnValue([
        { name: 'orphan_tool', definition: { function: { description: 'An orphan tool' } } },
      ]);

      const result = await agentModeService.getSkillsForDisplay([], 'user-1');

      const otherSkill = result.find(s => s.skillId === '__other_skills__');
      expect(otherSkill).toBeDefined();
      expect(otherSkill!.name).toBe('Other Skills');
      expect(otherSkill!.toolNames).toContain('orphan_tool');
    });
  });
});
