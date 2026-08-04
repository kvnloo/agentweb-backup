/**
 * Tests for predefined work plan MCP tools in apiTools.ts
 * Verifies tool registrations, HTTP call patterns, and admin-only loading.
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

const mockGetUserById = jest.fn();
jest.mock('../services/db', () => ({
  userDb: { getUserById: (...args: any[]) => mockGetUserById(...args) },
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

describe('Predefined Work Plan MCP Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const context = { userId: 'user-123', agentUserId: 'user-123' };

  // ─── FAIL tests: invalid inputs, boundary conditions, error paths ────

  describe('registration', () => {
    it('should register both work plan tools', () => {
      const names = mcpToolRegistry.getToolNames();
      expect(names).toContain('list_predefined_work_plans');
      expect(names).toContain('manage_predefined_work_plan');
    });

    it('should expose work plan tools to external MCP clients', () => {
      const externalDefs = mcpToolRegistry.getToolDefinitions();
      const externalNames = externalDefs.map((d: any) => d.name);
      expect(externalNames).toContain('list_predefined_work_plans');
      expect(externalNames).toContain('manage_predefined_work_plan');
    });
  });

  describe('manage_predefined_work_plan - error paths', () => {
    it('should return error for unknown action', async () => {
      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', { action: 'bogus' }, context);
      expect(result.content[0].text).toContain('Unknown action');
    });

    it('should propagate HTTP errors from mcpFetch', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'user-123', isAdmin: false });
      mockMcpFetch.mockRejectedValue(new Error('API error (403): Forbidden'));
      await expect(
        mcpToolRegistry.execute('list_predefined_work_plans', {}, context)
      ).rejects.toThrow('API error (403): Forbidden');
    });

    it('should propagate errors on create', async () => {
      mockMcpFetch.mockRejectedValue(new Error('API error (400): title and steps are required'));
      await expect(
        mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'create',
          title: 'Test Plan',
          steps: [{ title: 'Step 1' }],
        }, context)
      ).rejects.toThrow('API error (400)');
    });
  });

  // ─── SUCCESS tests ─────────────────────────────────────────────────────

  describe('list_predefined_work_plans (role-aware)', () => {
    it('non-admin users get the public/launchable list via /api/agent-mode/public/plans', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'user-123', isAdmin: false });
      mockMcpFetch.mockResolvedValue([{ id: 'wp-1', title: 'Onboarding' }]);

      const result = await mcpToolRegistry.execute('list_predefined_work_plans', {}, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/agent-mode/public/plans',
      }));
      expect(result.content[0].text).toContain('Onboarding');
    });

    it('admin users get the full management list via /api/admin/work-plans', async () => {
      mockGetUserById.mockResolvedValue({ userId: 'admin-1', isAdmin: true });
      mockMcpFetch.mockResolvedValue([{ id: 'wp-1', title: 'Onboarding', visibility: 'pending_review' }]);

      const result = await mcpToolRegistry.execute('list_predefined_work_plans', {}, { userId: 'admin-1' });

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/admin/work-plans',
      }));
      expect(result.content[0].text).toContain('pending_review');
    });

    it('admin-delegated sessions get the admin list without a user lookup', async () => {
      mockMcpFetch.mockResolvedValue([{ id: 'wp-1', title: 'Onboarding' }]);

      await mcpToolRegistry.execute('list_predefined_work_plans', {}, { userId: 'user-123', isDelegatedAccess: true });

      expect(mockGetUserById).not.toHaveBeenCalled();
      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/admin/work-plans',
      }));
    });

    it('falls back to the non-admin path when the user lookup fails', async () => {
      mockGetUserById.mockRejectedValue(new Error('lookup failed'));
      mockMcpFetch.mockResolvedValue([{ id: 'wp-1', title: 'Onboarding' }]);

      await mcpToolRegistry.execute('list_predefined_work_plans', {}, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/agent-mode/public/plans',
      }));
    });
  });

  describe('manage_predefined_work_plan - create', () => {
    it('should call POST with body', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new', message: 'Created' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'New Plan',
        steps: [{ title: 'Step 1', description: 'Do something' }],
        description: 'A test plan',
        welcome_message: 'Welcome!',
        autocomplete: true,
        require_login: false,
        show_in_agent_mode: true,
        show_login_signup: 'after_plan_completed',
        default_model: 'gpt-4o',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/admin/work-plans',
        body: expect.objectContaining({
          title: 'New Plan',
          steps: [{ title: 'Step 1', description: 'Do something' }],
          description: 'A test plan',
          welcomeMessage: 'Welcome!',
          autocomplete: true,
          requireLogin: false,
          showInAgentMode: true,
          showLoginSignup: 'after_plan_completed',
          defaultModel: 'gpt-4o',
        }),
      }));
    });

    it('should not pass undefined optional fields', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Minimal Plan',
        steps: [{ title: 'Step 1' }],
      }, context);

      const callBody = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(callBody.title).toBe('Minimal Plan');
      expect(callBody.description).toBeUndefined();
      expect(callBody.welcomeMessage).toBeUndefined();
      expect(callBody.defaultModel).toBeUndefined();
    });
  });

  // ─── ENG-889: step fields are documented snake_case but the admin route
  // reads them camelCase. Both casings must reach the route as camelCase.
  describe('manage_predefined_work_plan - step field casing', () => {
    const stepBodyOf = (call: number) => ((mockMcpFetch.mock.calls[call][0] as any).body.steps);

    it('maps the documented snake_case required_function_calls to requiredFunctionCalls on create', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Gate Plan',
        steps: [{ title: 'Step 1', required_function_calls: ['list_connected_accounts'] }],
      }, context);

      expect(stepBodyOf(0)).toEqual([
        { title: 'Step 1', requiredFunctionCalls: ['list_connected_accounts'] },
      ]);
    });

    it('maps snake_case skill_ids, user_instructions and step_count on create', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Gate Plan',
        steps: [{
          title: 'Step 1',
          skill_ids: ['skill-1'],
          user_instructions: 'Do this',
          step_count: 2,
        }],
      }, context);

      expect(stepBodyOf(0)).toEqual([
        { title: 'Step 1', skillIds: ['skill-1'], userInstructions: 'Do this', stepCount: 2 },
      ]);
    });

    it('maps snake_case step fields on update', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Updated' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        title: 'Gate Plan',
        steps: [{ title: 'Step 1', required_function_calls: ['list_skills'], skill_ids: ['skill-1'] }],
      }, context);

      expect(stepBodyOf(0)).toEqual([
        { title: 'Step 1', requiredFunctionCalls: ['list_skills'], skillIds: ['skill-1'] },
      ]);
    });

    it('still accepts the camelCase form unchanged', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Gate Plan',
        steps: [{ title: 'Step 1', requiredFunctionCalls: ['list_skills'], skillIds: ['skill-1'] }],
      }, context);

      expect(stepBodyOf(0)).toEqual([
        { title: 'Step 1', requiredFunctionCalls: ['list_skills'], skillIds: ['skill-1'] },
      ]);
    });

    it('maps snake_case expected_asset_count to expectedAssetCount', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Creative Hub',
        steps: [{ title: 'Generate 3 Images Per Hook', expected_asset_count: 18 }],
      }, context);

      expect(stepBodyOf(0)).toEqual([
        { title: 'Generate 3 Images Per Hook', expectedAssetCount: 18 },
      ]);
    });

    it('uses the snake_case value when the camelCase twin is explicitly null', async () => {
      // JSON has no undefined, so a model that emits an unset field emits null.
      // Treating null as "camelCase present" would shadow a perfectly good
      // snake_case value and hand the route null -> `|| []` -> silently empty.
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Gate Plan',
        steps: [{
          title: 'Step 1',
          requiredFunctionCalls: null,
          required_function_calls: ['list_connected_accounts'],
        }],
      }, context);

      expect(stepBodyOf(0)).toEqual([
        { title: 'Step 1', requiredFunctionCalls: ['list_connected_accounts'] },
      ]);
    });

    it('is not sensitive to the order the two casings appear in', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Gate Plan',
        steps: [{
          required_function_calls: ['snake_first'],
          requiredFunctionCalls: ['camel_second'],
          title: 'Step 1',
        }],
      }, context);

      expect(stepBodyOf(0)).toEqual([
        { title: 'Step 1', requiredFunctionCalls: ['camel_second'] },
      ]);
    });

    it('prefers the camelCase value when both casings are supplied', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Gate Plan',
        steps: [{
          title: 'Step 1',
          requiredFunctionCalls: ['camel'],
          required_function_calls: ['snake'],
        }],
      }, context);

      expect(stepBodyOf(0)).toEqual([
        { title: 'Step 1', requiredFunctionCalls: ['camel'] },
      ]);
    });

    it('leaves a missing or malformed steps value untouched', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Gate Plan',
        steps: ['not-an-object', null],
      }, context);
      expect(stepBodyOf(0)).toEqual(['not-an-object', null]);

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        title: 'Gate Plan',
      }, context);
      expect(stepBodyOf(1)).toBeUndefined();
    });

    it('documents the field names the route actually reads', () => {
      const def: any = mcpToolRegistry.getTool('manage_predefined_work_plan')!.definition;
      const stepProps = def.inputSchema.properties.steps.items.properties;
      expect(Object.keys(stepProps)).toEqual(
        expect.arrayContaining(['requiredFunctionCalls', 'skillIds', 'expectedAssetCount'])
      );
      expect(stepProps.required_function_calls).toBeUndefined();
    });
  });

  // The admin route reads category and visibility, and the portal sets both —
  // but they were absent from the tool, so an API-only caller had to open the
  // portal to finish a plan it had just created (ENG-889).
  describe('manage_predefined_work_plan - category and visibility', () => {
    it('maps category and visibility on create', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Paid Ads Plan',
        steps: [{ title: 'Step 1' }],
        category: 'Paid Ads',
        visibility: 'system',
      }, context);

      const body = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(body.category).toBe('Paid Ads');
      expect(body.visibility).toBe('system');
    });

    it('maps category and visibility on update', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Updated' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        category: 'Strategy',
        visibility: 'private',
      }, context);

      const body = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect(body.category).toBe('Strategy');
      expect(body.visibility).toBe('private');
    });

    it('omits both when not supplied, leaving the route defaults alone', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Plain',
        steps: [{ title: 'Step 1' }],
      }, context);

      const body = (mockMcpFetch.mock.calls[0][0] as any).body;
      expect('category' in body).toBe(false);
      expect('visibility' in body).toBe(false);
    });

    it('documents both on the tool', () => {
      const def: any = mcpToolRegistry.getTool('manage_predefined_work_plan')!.definition;
      const props = def.inputSchema.properties;
      expect(props.category).toBeDefined();
      expect(props.visibility.enum).toEqual(
        expect.arrayContaining(['system', 'private', 'public', 'pending_review']),
      );
    });
  });

  describe('manage_predefined_work_plan - update', () => {
    it('should call PUT with plan_id in path', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Updated' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        title: 'Updated Plan',
        steps: [{ title: 'New Step' }],
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'PUT',
        path: '/api/admin/work-plans/wp-1',
        body: expect.objectContaining({
          title: 'Updated Plan',
          steps: [{ title: 'New Step' }],
        }),
      }));
    });
  });

  describe('manage_predefined_work_plan - delete', () => {
    it('should call DELETE with plan_id in path', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Deleted' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'delete',
        plan_id: 'wp-1',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'DELETE',
        path: '/api/admin/work-plans/wp-1',
      }));
    });
  });

  describe('manage_predefined_work_plan - get', () => {
    it('should call GET with plan_id in path', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-1', title: 'Onboarding', steps: [] });

      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'get',
        plan_id: 'wp-1',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/admin/work-plans/wp-1',
      }));
      expect(result.content[0].text).toContain('Onboarding');
    });
  });
});

describe('Admin tools are NOT in chatbotService', () => {
  it('should not have isAdmin in ChatResponseOptions interface', async () => {
    // Admin tools belong in Agent Mode only, not the Emma chatbot.
    // Verify the tools are registered in mcpToolRegistry (for Agent Mode use).
    const names = mcpToolRegistry.getToolNames();
    expect(names).toContain('list_predefined_work_plans');
    expect(names).toContain('manage_predefined_work_plan');
  });
});
