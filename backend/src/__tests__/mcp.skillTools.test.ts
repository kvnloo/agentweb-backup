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
  },
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
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

describe('Skill Management MCP Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const context = { userId: 'user-123', agentUserId: 'user-123' };

  // ─── FAIL tests: invalid inputs, boundary conditions, error paths ────

  describe('registration', () => {
    it('should register both skill tools', () => {
      const names = mcpToolRegistry.getToolNames();
      expect(names).toContain('list_skills');
      expect(names).toContain('manage_skill');
    });

    it('should expose skill tools to external MCP clients', () => {
      const externalDefs = mcpToolRegistry.getToolDefinitions();
      const externalNames = externalDefs.map((d: any) => d.name);
      expect(externalNames).toContain('list_skills');
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
      expect(result.content[0].text).toContain('skill_id is required');
    });

    it('should return error when skill_id missing for delete', async () => {
      const result = await mcpToolRegistry.execute('manage_skill', { action: 'delete' }, context);
      expect(result.content[0].text).toContain('skill_id is required');
    });

    it('should return error when skill_id missing for get', async () => {
      const result = await mcpToolRegistry.execute('manage_skill', { action: 'get' }, context);
      expect(result.content[0].text).toContain('skill_id is required');
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
