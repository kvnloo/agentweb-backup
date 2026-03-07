/**
 * Tests for mcp/server/apiTools.ts
 * Verifies tool registrations, HTTP call patterns, and response mapping.
 */

// Mock httpClient before importing apiTools
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

// Mock skillService and subscriptionService for install_skills/list_available_skills
jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([
      { skillId: 'skill-1', name: 'Skill One', description: 'Test skill', toolNames: ['tool_a'] },
    ]),
  },
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn().mockResolvedValue({ success: true }),
    getUnassociatedToolNames: jest.fn().mockReturnValue(['unassociated_tool']),
  },
}));

// Fresh registry for each test
import { McpToolRegistry } from '../mcp/server/registry';
import { mcpFetch } from '../mcp/server/httpClient';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

// Import the registry (which gets populated by apiTools import)
import { mcpToolRegistry } from '../mcp/server/registry';

// Import apiTools to trigger tool registrations
import '../mcp/server/apiTools';

describe('apiTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const context = { userId: 'user-123', agentUserId: 'user-123' };

  // ─── Registration checks ──────────────────────────────────────────────

  describe('tool registrations', () => {
    it('should NOT register install_skills or list_available_skills (internal-only)', () => {
      const names = mcpToolRegistry.getToolNames();
      expect(names).not.toContain('install_skills');
      expect(names).not.toContain('list_available_skills');
    });

    it('should register API-wrapping tools', () => {
      const names = mcpToolRegistry.getToolNames();
      const expectedTools = [
        'emma_create_session', 'emma_send_message', 'emma_get_session', 'emma_list_sessions',
        'list_tasks', 'manage_task', 'execute_task', 'list_task_executions',
        'list_schedules', 'manage_schedule',
        'list_lead_lists', 'manage_lead_list', 'manage_leads', 'search_leads',
        'list_gtm_plans', 'manage_gtm_plan', 'manage_gtm_items',
        'list_knowledge_bases', 'search_knowledge_base', 'read_knowledge_base_files',
        'manage_brand', 'manage_market_strategy',
        'generate_blog_post', 'publish_blog_post',
        'list_connected_accounts', 'post_on_account',
      ];
      for (const tool of expectedTools) {
        expect(names).toContain(tool);
      }
    });

    it('should register internal tools but hide them from external MCP clients', () => {
      const allNames = mcpToolRegistry.getToolNames();
      const externalDefs = mcpToolRegistry.getToolDefinitions();
      const externalNames = externalDefs.map((d: any) => d.name);
      const internalTools = ['search_web', 'generate_image', 'send_email', 'save_file'];
      for (const name of internalTools) {
        // Registered in the registry (available to Emma internally)
        expect(allNames).toContain(name);
        // But NOT exposed to external MCP clients
        expect(externalNames).not.toContain(name);
      }
    });

    it('should NOT register old tool names (portal_*, read_brand_guidelines, etc.)', () => {
      const names = mcpToolRegistry.getToolNames();
      const oldNames = [
        'portal_list_tasks', 'portal_create_task', 'portal_execute_task',
        'read_brand_guidelines', 'update_brand_guidelines',
        'read_market_strategy', 'update_market_strategy',
        'get_lead_lists', 'list_knowledge_base_files',
        'create_work_plan', 'modify_work_plan', 'set_work_plan_status',
      ];
      for (const name of oldNames) {
        expect(names).not.toContain(name);
      }
    });
  });

  // ─── FAIL tests ───────────────────────────────────────────────────────

  describe('error handling', () => {
    it('should propagate HTTP errors from mcpFetch', async () => {
      mockMcpFetch.mockRejectedValue(new Error('API error (403): Forbidden'));

      await expect(
        mcpToolRegistry.execute('list_tasks', {}, context)
      ).rejects.toThrow('API error (403): Forbidden');
    });

    it('should pass correct context to mcpFetch', async () => {
      mockMcpFetch.mockResolvedValue({ tasks: [] });

      await mcpToolRegistry.execute('list_tasks', {}, context);

      expect(mockMcpFetch).toHaveBeenCalledWith({
        method: 'GET',
        path: '/api/tasks',
        context: { userId: 'user-123', agentUserId: 'user-123' },
      });
    });

    it('should handle manage_task with unknown action', async () => {
      const result = await mcpToolRegistry.execute('manage_task', { action: 'bogus' }, context);
      expect(result.content[0].text).toContain('Unknown action');
    });
  });

  // ─── SUCCESS tests ────────────────────────────────────────────────────

  describe('list_tasks', () => {
    it('should call GET /api/tasks', async () => {
      mockMcpFetch.mockResolvedValue([{ taskId: 't1', name: 'Test' }]);

      const result = await mcpToolRegistry.execute('list_tasks', {}, context);

      expect(mockMcpFetch).toHaveBeenCalledWith({
        method: 'GET',
        path: '/api/tasks',
        context: { userId: 'user-123', agentUserId: 'user-123' },
      });
      expect(result.content[0].text).toContain('t1');
    });
  });

  describe('manage_task - create', () => {
    it('should call POST /api/tasks with body', async () => {
      mockMcpFetch.mockResolvedValue({ taskId: 'new-1', name: 'New Task' });

      await mcpToolRegistry.execute('manage_task', {
        action: 'create', name: 'New Task', prompt: 'Do stuff'
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/tasks',
        body: expect.objectContaining({ name: 'New Task', prompt: 'Do stuff' }),
      }));
    });
  });

  describe('manage_task - delete', () => {
    it('should call DELETE /api/tasks/:id', async () => {
      mockMcpFetch.mockResolvedValue({ deleted: true });

      await mcpToolRegistry.execute('manage_task', { action: 'delete', task_id: 't1' }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'DELETE',
        path: '/api/tasks/t1',
      }));
    });
  });

  describe('execute_task', () => {
    it('should call POST /api/tasks/:id/execute', async () => {
      mockMcpFetch.mockResolvedValue({ executionId: 'exec-1' });

      await mcpToolRegistry.execute('execute_task', { task_id: 't1' }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/tasks/t1/execute',
      }));
    });
  });

  describe('manage_brand - read', () => {
    it('should call GET /api/brand/guidelines', async () => {
      mockMcpFetch.mockResolvedValue({ company_name: 'Test Corp' });

      await mcpToolRegistry.execute('manage_brand', { action: 'read' }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/brand/guidelines',
      }));
    });
  });

  describe('manage_brand - update', () => {
    it('should call POST /api/brand/guidelines with body', async () => {
      mockMcpFetch.mockResolvedValue({ success: true });

      await mcpToolRegistry.execute('manage_brand', {
        action: 'update', company_name: 'New Corp'
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/brand/guidelines',
        body: { company_name: 'New Corp' },
      }));
    });
  });

  describe('list_connected_accounts', () => {
    it('should call GET /api/oauth/connected-accounts with platform filter', async () => {
      mockMcpFetch.mockResolvedValue({ accounts: [] });

      await mcpToolRegistry.execute('list_connected_accounts', { platform: 'linkedin' }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/oauth/connected-accounts',
        queryParams: { platform: 'linkedin' },
      }));
    });
  });

  describe('manage_gtm_items - add_phase', () => {
    it('should call POST /api/gtm-plan/:id/phases', async () => {
      mockMcpFetch.mockResolvedValue({ phaseId: 'phase-1' });

      await mcpToolRegistry.execute('manage_gtm_items', {
        action: 'add_phase', plan_id: 'plan-1',
        name: 'Launch Phase', description: 'Product launch'
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/gtm-plan/plan-1/phases',
        body: { name: 'Launch Phase', description: 'Product launch', status: undefined },
      }));
    });
  });

});
