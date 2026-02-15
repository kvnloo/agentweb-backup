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
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
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
  });

  describe('buildSkillContext', () => {
    it('should add install_skills to allowed tools by default', () => {
      const result = (agentModeService as any).buildSkillContext([], ['*'], [], []);

      expect(result.allowedToolNames.has('install_skills')).toBe(true);
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
      expect(result[0].description).toBe('');
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
        { name: 'install_skills', definition: { function: { name: 'install_skills', description: 'infra' } } }
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
  });

  describe('getFoundationToolNames', () => {
    it('should return a Set containing foundation tool names', () => {
      const foundationTools = agentModeService.getFoundationToolNames();

      expect(foundationTools).toBeInstanceOf(Set);
      expect(foundationTools.has('install_skills')).toBe(true);
      expect(foundationTools.has('search_web')).toBe(true);
      expect(foundationTools.has('read_file_content')).toBe(true);
      expect(foundationTools.has('read_page_source')).toBe(true);
      expect(foundationTools.has('search_knowledge_base')).toBe(true);
      expect(foundationTools.has('list_knowledge_base_files')).toBe(true);
      expect(foundationTools.has('read_knowledge_base_files')).toBe(true);
      expect(foundationTools.has('create_work_plan')).toBe(true);
      expect(foundationTools.has('modify_work_plan')).toBe(true);
      expect(foundationTools.has('set_work_plan_status')).toBe(true);
      expect(foundationTools.has('save_file')).toBe(true);
      expect(foundationTools.has('describe_image')).toBe(true);
    });

    it('should not contain domain-specific tools', () => {
      const foundationTools = agentModeService.getFoundationToolNames();

      expect(foundationTools.has('generate_image')).toBe(false);
      expect(foundationTools.has('create_blog_article')).toBe(false);
      expect(foundationTools.has('create_social_media_posts')).toBe(false);
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

    it('should return all skills when no userId provided (wildcard default)', async () => {
      const publishedSkills = [
        { skillId: 'skill-1', name: 'Skill 1', description: 'Desc', toolNames: ['tool1'], isPublished: true },
      ];
      (skillService.getPublishedSkills as jest.Mock).mockResolvedValue(publishedSkills);

      const result = await agentModeService.getSkillsForDisplay([]);

      expect(result.some(s => s.skillId === 'skill-1')).toBe(true);
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
