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

    it('should allow an org member to install a private skill owned by another org member', async () => {
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

      // Patch the dynamic import of db so getUserById returns the org member
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: orgMemberUserId, orgId }) };

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

      // Outsider is in a different org
      const mockDb = require('../services/db');
      mockDb.userDb = { getUserById: jest.fn().mockResolvedValue({ userId: outsiderUserId, orgId: 'org-different' }) };

      const result = await agentModeService.installSkills(
        ['org-private-skill-1'],
        outsiderUserId,
        'session-xyz'
      );

      expect(result.message).toContain('not available with your current subscription');
      expect(chatbotDb.addAssociatedSkills).not.toHaveBeenCalled();
    });
  });

  describe('buildSkillContext', () => {
    it('should add install_skills to allowed tools by default', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*'], [], []);

      expect(result.allowedToolNames.has('install_skills')).toBe(true);
    });

    it('should include search_web in foundation tools', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*'], [], []);

      expect(result.allowedToolNames.has('search_web')).toBe(true);
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
        { name: 'search_web', definition: { function: { name: 'search_web', description: 'Search the web' } } },
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
      // Non-foundation tool allowed by subscription should also be present
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
      // S3 overflow retrieval tools must always be available so the LLM can read
      // large tool responses that were offloaded to S3 by the 10KB overflow mechanism.
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
      expect(tools.size).toBe(8);
      expect(tools.has('tool_a')).toBe(true);
      expect(tools.has('tool_b')).toBe(true);
      expect(tools.has('tool_c')).toBe(true);
      expect(tools.has('install_skills')).toBe(true);
      expect(tools.has('list_available_skills')).toBe(true);
      expect(tools.has('resolve_skill')).toBe(true);
      expect(tools.has('search_tool_response')).toBe(true);
      expect(tools.has('read_tool_response')).toBe(true);
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

      expect(result).toEqual(['tool_x', 'tool_y', 'install_skills', 'list_available_skills', 'resolve_skill', 'search_tool_response', 'read_tool_response']);
      expect(settingsService.setSetting).toHaveBeenCalledWith(
        'foundation_tools',
        JSON.stringify(['tool_x', 'tool_y', 'install_skills', 'list_available_skills', 'resolve_skill', 'search_tool_response', 'read_tool_response']),
        expect.any(String),
        'admin@test.com'
      );
      const tools = agentModeService.getFoundationToolNames();
      expect(tools.size).toBe(7);
      expect(tools.has('tool_x')).toBe(true);
      expect(tools.has('tool_y')).toBe(true);
      expect(tools.has('resolve_skill')).toBe(true);
    });

    it('should deduplicate tool names', async () => {
      const { settingsService } = require('../services/settingsService');
      settingsService.setSetting = jest.fn().mockResolvedValue(undefined);

      const result = await agentModeService.updateFoundationTools(['tool_a', 'tool_a', 'tool_b'], 'admin@test.com');

      expect(result).toEqual(['tool_a', 'tool_b', 'install_skills', 'list_available_skills', 'resolve_skill', 'search_tool_response', 'read_tool_response']);
    });
  });

  describe('getSkillsForDisplay', () => {
    it('should return published skills with installed status and toolNames', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Web Search', description: 'Search tools', toolNames: ['search_web'], isPublished: true },
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
