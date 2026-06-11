/**
 * Tests for skill management MCP tools in apiTools.ts
 * Verifies tool registrations, HTTP call patterns, and error paths.
 */

jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([]),
    getSkillsAvailableToUser: jest.fn(),
    getAllSkills: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
  },
}));

jest.mock('../services/orgShareService', () => ({
  isFeatureEffectivelyEnabled: jest.fn().mockReturnValue(true),
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
  },
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import { skillService } from '../services/skillService';
import { userDb, orgDb } from '../services/db';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const mockSkillService = skillService as jest.Mocked<typeof skillService>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;

describe('Skill Management MCP Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserDb.getUserById.mockImplementation(async (userId: string) => {
      if (userId === 'admin-123') return { userId, email: 'admin@agentweb.pro', isAdmin: true } as any;
      if (userId === 'owner-123') return { userId, email: 'teammate@agentweb.pro', isAdmin: false } as any;
      return { userId, email: 'user@agentweb.pro', isAdmin: false } as any;
    });
    mockOrgDb.getOrgById.mockResolvedValue({ orgId: 'org-123', shareSettings: { skills: { enabled: true } } } as any);
  });

  const context = { userId: 'user-123', agentUserId: 'user-123' };
  const adminContext = { userId: 'admin-123', agentUserId: 'admin-123' };

  // ─── FAIL tests: invalid inputs, boundary conditions, error paths ────

  describe('registration', () => {
    it('should register skill tools', () => {
      const names = mcpToolRegistry.getToolNames();
      expect(names).toContain('list_skills');
      expect(names).toContain('resolve_skill');
      expect(names).toContain('manage_skill');
    });

    it('should expose skill tools to external MCP clients', () => {
      const externalDefs = mcpToolRegistry.getToolDefinitions();
      const externalNames = externalDefs.map((d: any) => d.name);
      expect(externalNames).toContain('list_skills');
      expect(externalNames).toContain('resolve_skill');
      expect(externalNames).toContain('manage_skill');
    });
  });

  describe('manage_skill - error paths', () => {
    it('should return error for unknown action', async () => {
      const result = await mcpToolRegistry.execute('manage_skill', { action: 'bogus' }, context);
      expect(result.content[0].text).toContain('Unknown action');
    });

    it('should return error when skill_id missing for update', async () => {
      const result = await mcpToolRegistry.execute('manage_skill', { action: 'update', name: 'New Name' }, context);
      expect(result.content[0].text).toContain('Call resolve_skill');
    });

    it('should return error when skill_id missing for delete', async () => {
      const result = await mcpToolRegistry.execute('manage_skill', { action: 'delete' }, context);
      expect(result.content[0].text).toContain('Call resolve_skill');
    });

    it('should return error when skill_id missing for get', async () => {
      const result = await mcpToolRegistry.execute('manage_skill', { action: 'get' }, context);
      expect(result.content[0].text).toContain('Call resolve_skill');
    });

    it('should propagate HTTP errors from mcpFetch', async () => {
      mockMcpFetch.mockRejectedValue(new Error('API error (403): Forbidden'));
      await expect(
        mcpToolRegistry.execute('list_skills', {}, context)
      ).rejects.toThrow('API error (403): Forbidden');
    });

    it('should propagate errors on create', async () => {
      mockMcpFetch.mockRejectedValue(new Error('API error (400): Name and description are required'));
      await expect(
        mcpToolRegistry.execute('manage_skill', {
          action: 'create',
          name: 'Test Skill',
          description: 'A test skill',
        }, context)
      ).rejects.toThrow('API error (400)');
    });
  });

  // ─── SUCCESS tests ─────────────────────────────────────────────────────

  describe('list_skills', () => {
    it('should call GET /api/skills', async () => {
      mockMcpFetch.mockResolvedValue([
        { skillId: 'sk-1', name: 'SEO Analytics', toolNames: ['get_seo_metrics'], isPublished: true },
      ]);

      const result = await mcpToolRegistry.execute('list_skills', {}, context);

      expect(mockMcpFetch).toHaveBeenCalledWith({
        method: 'GET',
        path: '/api/skills',
        context: { userId: 'user-123', agentUserId: 'user-123' },
      });
      expect(result.content[0].text).toContain('sk-1');
      expect(result.content[0].text).toContain('SEO Analytics');
    });
  });

  describe('resolve_skill', () => {
    const skills = [
      {
        skillId: 'luma-1',
        name: 'Luma Event Lead Engagement Engine',
        description: 'Run event lead engagement for Luma and yacht event workflows',
        ownerEmail: 'founders@agentweb.pro',
        visibility: 'private',
        isPublished: false,
        systemPrompt: 'SECRET FULL PROMPT SHOULD NOT RETURN',
      },
      {
        skillId: 'social-1',
        name: 'Screenshot Social Media Posts',
        description: 'Capture screenshots of social posts',
        ownerEmail: 'founders@agentweb.pro',
        visibility: 'public',
        isPublished: true,
        systemPrompt: 'ANOTHER SECRET PROMPT',
      },
      {
        skillId: 'event-2',
        name: 'Event Followup Writer',
        description: 'Draft post-event followup messages',
        ownerEmail: 'ops@agentweb.pro',
        visibility: 'private',
        isPublished: true,
      },
    ];

    it('should resolve an exact skill name without returning systemPrompt', async () => {
      mockSkillService.getSkillsAvailableToUser.mockResolvedValue(skills as any);

      const result = await mcpToolRegistry.execute('resolve_skill', {
        query: 'Luma Event Lead Engagement Engine',
      }, context);
      const parsed = JSON.parse(result.content[0].text);

      expect(mockSkillService.getSkillsAvailableToUser).toHaveBeenCalledWith('user-123', undefined);
      expect(parsed.scope).toBe('user_accessible');
      expect(parsed.canManageSkills).toBe(false);
      expect(parsed.resolution).toBe('single_strong_match');
      expect(parsed.matches[0]).toMatchObject({
        skill_id: 'luma-1',
        name: 'Luma Event Lead Engagement Engine',
        ownerEmail: 'founders@agentweb.pro',
        visibility: 'private',
        isPublished: false,
      });
      expect(JSON.stringify(parsed)).not.toContain('SECRET FULL PROMPT');
      expect(parsed.matches[0].matchScore).toBeGreaterThanOrEqual(100);
    });

    it('should resolve partial event skill queries in ranked order', async () => {
      mockSkillService.getSkillsAvailableToUser.mockResolvedValue(skills as any);

      const result = await mcpToolRegistry.execute('resolve_skill', {
        query: 'Event skill',
        limit: 2,
      }, context);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.matches).toHaveLength(2);
      expect(parsed.matches.map((match: any) => match.skill_id)).toEqual(['event-2', 'luma-1']);
      expect(parsed.resolution).toBe('multiple_matches');
    });

    it('should return no_match when no skills match the query', async () => {
      mockSkillService.getSkillsAvailableToUser.mockResolvedValue(skills as any);

      const result = await mcpToolRegistry.execute('resolve_skill', {
        query: 'Healthcare RFP Assistant',
      }, context);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.resolution).toBe('no_match');
      expect(parsed.matches).toEqual([]);
      expect(parsed.nextStep).toContain('no matching skill');
    });

    it('should preserve private and org-visible metadata in compact matches', async () => {
      mockUserDb.getUserById.mockImplementation(async (userId: string) => {
        if (userId === 'user-123') return { userId, email: 'user@agentweb.pro', isAdmin: false, orgId: 'org-123', orgRole: 'member' } as any;
        if (userId === 'owner-123') return { userId, email: 'teammate@agentweb.pro', isAdmin: false } as any;
        return null;
      });
      mockSkillService.getSkillsAvailableToUser.mockResolvedValue([
        {
          skillId: 'org-1',
          name: 'Org Shared Event Skill',
          description: 'Shared inside the org',
          ownerId: 'owner-123',
          visibility: 'private',
          isPublished: false,
          orgId: 'org-123',
          systemPrompt: 'ORG SECRET',
        },
      ] as any);

      const result = await mcpToolRegistry.execute('resolve_skill', {
        query: 'shared event',
      }, context);
      const parsed = JSON.parse(result.content[0].text);

      expect(mockSkillService.getSkillsAvailableToUser).toHaveBeenCalledWith('user-123', 'org-123');
      expect(parsed.scope).toBe('user_accessible_with_org');
      expect(parsed.matches[0]).toEqual(expect.objectContaining({
        skill_id: 'org-1',
        name: 'Org Shared Event Skill',
        ownerEmail: 'teammate@agentweb.pro',
        visibility: 'private',
        isPublished: false,
      }));
      expect(JSON.stringify(parsed)).not.toContain('ORG SECRET');
    });

    it('should use admin-visible scope for admin users', async () => {
      mockSkillService.getAllSkills.mockResolvedValue(skills as any);

      const result = await mcpToolRegistry.execute('resolve_skill', {
        query: 'Event skill',
      }, adminContext);
      const parsed = JSON.parse(result.content[0].text);

      expect(mockSkillService.getAllSkills).toHaveBeenCalled();
      expect(mockSkillService.getSkillsAvailableToUser).not.toHaveBeenCalled();
      expect(parsed.scope).toBe('admin_visible');
      expect(parsed.canManageSkills).toBe(true);
    });
  });

  describe('manage_skill - create', () => {
    it('should call POST with body', async () => {
      mockMcpFetch.mockResolvedValue({ skillId: 'sk-new', name: 'New Skill' });

      await mcpToolRegistry.execute('manage_skill', {
        action: 'create',
        name: 'New Skill',
        description: 'A new skill',
        tool_names: ['get_seo_metrics', 'get_website_analytics'],
        system_prompt: 'You are an SEO expert.',
        is_published: true,
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/skills',
        body: expect.objectContaining({
          name: 'New Skill',
          description: 'A new skill',
          toolNames: ['get_seo_metrics', 'get_website_analytics'],
          systemPrompt: 'You are an SEO expert.',
          isPublished: true,
        }),
      }));
    });

    it('should default toolNames to empty array when not provided', async () => {
      mockMcpFetch.mockResolvedValue({ skillId: 'sk-new' });

      await mcpToolRegistry.execute('manage_skill', {
        action: 'create',
        name: 'Minimal Skill',
        description: 'Minimal',
      }, context);

      const callBody = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(callBody.toolNames).toEqual([]);
      expect(callBody.systemPrompt).toBeUndefined();
      expect(callBody.isPublished).toBeUndefined();
    });
  });

  describe('manage_skill - update', () => {
    it('should call PUT with skill_id in path', async () => {
      mockMcpFetch.mockResolvedValue({ skillId: 'sk-1', name: 'Updated Skill' });

      await mcpToolRegistry.execute('manage_skill', {
        action: 'update',
        skill_id: 'sk-1',
        name: 'Updated Skill',
        tool_names: ['get_seo_metrics'],
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'PUT',
        path: '/api/skills/sk-1',
        body: expect.objectContaining({
          name: 'Updated Skill',
          toolNames: ['get_seo_metrics'],
        }),
      }));
    });

    it('should only include provided fields in update body', async () => {
      mockMcpFetch.mockResolvedValue({ skillId: 'sk-1' });

      await mcpToolRegistry.execute('manage_skill', {
        action: 'update',
        skill_id: 'sk-1',
        is_published: false,
      }, context);

      const callBody = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(callBody.isPublished).toBe(false);
      expect(callBody.name).toBeUndefined();
      expect(callBody.description).toBeUndefined();
      expect(callBody.toolNames).toBeUndefined();
    });
  });

  describe('manage_skill - delete', () => {
    it('should call DELETE with skill_id in path', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Skill deleted successfully' });

      await mcpToolRegistry.execute('manage_skill', {
        action: 'delete',
        skill_id: 'sk-1',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'DELETE',
        path: '/api/skills/sk-1',
      }));
    });
  });

  describe('manage_skill - get', () => {
    it('should call GET with skill_id in path', async () => {
      mockMcpFetch.mockResolvedValue({ skillId: 'sk-1', name: 'SEO Analytics', toolNames: ['get_seo_metrics'] });

      const result = await mcpToolRegistry.execute('manage_skill', {
        action: 'get',
        skill_id: 'sk-1',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/skills/sk-1',
      }));
      expect(result.content[0].text).toContain('SEO Analytics');
    });
  });
});
