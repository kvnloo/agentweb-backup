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

  /** The mcpFetch calls that carry a payload — i.e. everything but the
   *  pre-update read the destructive-steps guard performs (ENG-890). */
  const writeCalls = () => mockMcpFetch.mock.calls.filter((call: any) => call[0].method !== 'GET');

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
    // An update reads the plan before writing (ENG-890), so the first call is a
    // bodyless GET. Index over the write calls to keep asserting on the payload.
    const stepBodyOf = (call: number) => ((writeCalls()[call][0] as any).body.steps);

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

  // The admin route reads category, and the portal sets it — but it was absent
  // from the tool, so an API-only caller had to open the portal to finish a plan
  // it had just created (ENG-889). visibility is deliberately NOT exposed: it
  // publishes to, or hides from, every user.
  describe('manage_predefined_work_plan - category', () => {
    it('maps category on create', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Paid Ads Plan',
        steps: [{ title: 'Step 1' }],
        category: 'Paid Ads',
      }, context);

      expect((mockMcpFetch.mock.calls[0][0] as any).body.category).toBe('Paid Ads');
    });

    it('maps category on update', async () => {
      mockMcpFetch.mockResolvedValue({ message: 'Updated' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        category: 'Strategy',
      }, context);

      expect((mockMcpFetch.mock.calls[0][0] as any).body.category).toBe('Strategy');
    });

    it('omits category when not supplied, leaving the route default alone', async () => {
      mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'create',
        title: 'Plain',
        steps: [{ title: 'Step 1' }],
      }, context);

      expect('category' in (mockMcpFetch.mock.calls[0][0] as any).body).toBe(false);
    });

    it('does not expose visibility on the tool', () => {
      const def: any = mcpToolRegistry.getTool('manage_predefined_work_plan')!.definition;
      expect(def.inputSchema.properties.category).toBeDefined();
      expect(def.inputSchema.properties.visibility).toBeUndefined();
    });

    it.each([['create'], ['update']])(
      'never forwards visibility to the route on %s, even if a caller sends it',
      async (action) => {
        mockMcpFetch.mockResolvedValue({ id: 'wp-new' });

        await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action,
          plan_id: 'wp-1',
          title: 'Plan',
          steps: [{ title: 'Step 1' }],
          visibility: 'public',
        }, context);

        expect('visibility' in (writeCalls()[0][0] as any).body).toBe(false);
      },
    );
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

  // ─── ENG-890: partial step payloads must not silently wipe the plan ──────
  describe('manage_predefined_work_plan - update step safety', () => {
    const existingPlan = {
      planId: 'wp-1',
      title: 'Meta Launch Gate',
      steps_rev: 'rev-1',
      steps: [
        { stepCount: 1, title: 'Step 1: Scope', description: 'old scope', requiredFunctionCalls: ['a'], skillIds: ['s1'] },
        { stepCount: 2, title: 'Step 2: Inventory', description: 'inventory', requiredFunctionCalls: [], skillIds: [] },
        { stepCount: 3, title: 'Step 3: Placements', description: 'placements', requiredFunctionCalls: [], skillIds: [] },
        { stepCount: 4, title: 'Step 4: Audit', description: 'audit', requiredFunctionCalls: [], skillIds: [] },
        { stepCount: 5, title: 'Step 5: Journey', description: 'journey', requiredFunctionCalls: [], skillIds: [] },
        { stepCount: 6, title: 'Step 6: Verdict', description: 'verdict', requiredFunctionCalls: [], skillIds: [] },
        { stepCount: 7, title: 'Step 7: Hand-off', description: 'handoff', requiredFunctionCalls: [], skillIds: [] },
      ],
    };

    /** GET returns the current plan; PUT returns the saved plan. */
    function mockPlanFetches(saved: any = { planId: 'wp-1', message: 'Updated' }) {
      mockMcpFetch.mockImplementation(async (opts: any) =>
        opts.method === 'GET' ? JSON.parse(JSON.stringify(existingPlan)) : saved
      );
    }
    const putCalls = () => mockMcpFetch.mock.calls.filter((c: any) => c[0].method === 'PUT');

    it('refuses a shrinking replace and does NOT issue the PUT', async () => {
      mockPlanFetches();

      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps: [{ title: 'Step 1: Scope', description: 'amended scope' }],
      }, context);

      expect(putCalls()).toHaveLength(0);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toBeDefined();
      expect(payload.stepsWouldBeRemoved).toBe(6);
      expect(payload.removedStepTitles).toContain('Step 7: Hand-off');
    });

    it('rejects a non-array steps payload without calling the API', async () => {
      mockPlanFetches();

      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps: { title: 'Step 1: Scope' },
      }, context);

      expect(putCalls()).toHaveLength(0);
      expect(JSON.parse(result.content[0].text).error).toMatch(/array/i);
    });

    it('fails closed in replace mode when the pre-update read fails', async () => {
      mockMcpFetch.mockImplementation(async (opts: any) => {
        if (opts.method === 'GET') throw new Error('HTTP 503: Service Unavailable');
        return { planId: 'wp-1', message: 'Updated' };
      });

      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps: [{ title: 'Step 1: Scope', description: 'amended scope' }],
      }, context);

      expect(putCalls()).toHaveLength(0);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toMatch(/failed to read its current steps/i);
      expect(payload.error).toContain('HTTP 503: Service Unavailable');
    });

    it('merge mode amends the targeted step and keeps every other step', async () => {
      mockPlanFetches();

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps_mode: 'merge',
        steps: [{ title: 'Step 1: Scope', description: 'amended scope' }],
      }, context);

      const body = (putCalls()[0][0] as any).body;
      expect(body.steps).toHaveLength(7);
      expect(body.steps[0].description).toBe('amended scope');
      expect(body.steps[0].requiredFunctionCalls).toEqual(['a']);
      expect(body.steps[0].skillIds).toEqual(['s1']);
      expect(body.steps[6].title).toBe('Step 7: Hand-off');
    });

    it('merge mode targets by step_count when titles are being renamed', async () => {
      mockPlanFetches();

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps_mode: 'merge',
        steps: [{ step_count: 3, title: 'Step 3: Placement settings' }],
      }, context);

      const body = (putCalls()[0][0] as any).body;
      expect(body.steps).toHaveLength(7);
      expect(body.steps[2].title).toBe('Step 3: Placement settings');
      expect(body.steps[2].description).toBe('placements');
    });

    it('merge mode appends steps that match nothing existing', async () => {
      mockPlanFetches();

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps_mode: 'merge',
        steps: [{ title: 'Step 8: Retro', description: 'new step' }],
      }, context);

      const body = (putCalls()[0][0] as any).body;
      expect(body.steps).toHaveLength(8);
      expect(body.steps[7]).toEqual(expect.objectContaining({ stepCount: 8, title: 'Step 8: Retro' }));
    });

    it('allows a shrinking replace when confirm_step_removal is true and reports the diff', async () => {
      mockPlanFetches();

      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        confirm_step_removal: true,
        steps: [{ title: 'Step 1: Scope', description: 'amended scope' }],
      }, context);

      expect(putCalls()).toHaveLength(1);
      expect((putCalls()[0][0] as any).body.steps).toHaveLength(1);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.stepsChange).toEqual(expect.objectContaining({
        mode: 'replace', stepsBefore: 7, stepsAfter: 1, stepsRemoved: 6,
      }));
    });

    it('replaces without confirmation when no step is dropped', async () => {
      mockPlanFetches();

      // Carries each step's stored fields through: this test is about the step
      // COUNT being unchanged, and a payload that dropped them would (rightly)
      // be stopped by the content guard instead.
      const rewritten = existingPlan.steps.map((s) => ({ ...s, description: 'rewritten' }));
      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps: rewritten,
      }, context);

      expect(putCalls()).toHaveLength(1);
      expect((putCalls()[0][0] as any).body.steps).toHaveLength(7);
      expect(JSON.parse(result.content[0].text).stepsChange.stepsRemoved).toBe(0);
    });

    it('does not read the plan when steps are not being changed', async () => {
      mockPlanFetches();

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        title: 'Renamed plan',
      }, context);

      expect(mockMcpFetch.mock.calls.filter((c: any) => c[0].method === 'GET')).toHaveLength(0);
      expect(putCalls()).toHaveLength(1);
      expect((putCalls()[0][0] as any).body.steps).toBeUndefined();
    });

    // The guard's decision is only as good as the snapshot it read. Staking that
    // read means a plan changed in the meantime fails the write instead of
    // overwriting it with a payload that was only safe against the old steps.
    describe('staking the inspected plan', () => {
      it('sends the revision it read back with the write', async () => {
        mockPlanFetches();

        await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps_mode: 'merge',
          steps: [{ stepCount: 1, description: 'amended' }],
        }, context);

        expect((putCalls()[0][0] as any).body.expectedStepsRev).toBe('rev-1');
      });

      it('stakes null when the plan predates the revision field', async () => {
        mockMcpFetch.mockImplementation(async (opts: any) =>
          opts.method === 'GET'
            ? { planId: 'wp-1', steps: existingPlan.steps }
            : { planId: 'wp-1' }
        );

        await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps_mode: 'merge',
          steps: [{ stepCount: 1, description: 'amended' }],
        }, context);

        const body = (putCalls()[0][0] as any).body;
        expect('expectedStepsRev' in body).toBe(true);
        expect(body.expectedStepsRev).toBeNull();
      });

      it('does not stake a revision on a metadata-only update, which never read one', async () => {
        mockPlanFetches();

        await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          welcome_message: 'hello',
        }, context);

        expect('expectedStepsRev' in (putCalls()[0][0] as any).body).toBe(false);
      });

      it('turns a lost race into a retry instruction rather than an opaque failure', async () => {
        mockMcpFetch.mockImplementation(async (opts: any) => {
          if (opts.method === 'GET') return JSON.parse(JSON.stringify(existingPlan));
          throw new Error('API error (409): Work plan steps changed');
        });

        const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps_mode: 'merge',
          steps: [{ stepCount: 1, description: 'amended' }],
        }, context);

        const payload = JSON.parse(result.content[0].text);
        expect(payload.error).toMatch(/changed while/i);
        expect(payload.howToProceed).toEqual(expect.arrayContaining([expect.stringMatching(/retry/i)]));
      });

      it('does not swallow an unrelated write failure as a lost race', async () => {
        mockMcpFetch.mockImplementation(async (opts: any) => {
          if (opts.method === 'GET') return JSON.parse(JSON.stringify(existingPlan));
          throw new Error('API error (500): Failed to update work plan');
        });

        await expect(mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps_mode: 'merge',
          steps: [{ stepCount: 1, description: 'amended' }],
        }, context)).rejects.toThrow(/500/);
      });
    });

    it('documents the replace semantics and the merge escape hatch in the tool description', () => {
      const def = mcpToolRegistry.getTool('manage_predefined_work_plan')!.definition as any;
      expect(def.description).toMatch(/replaces the entire/i);
      expect(def.inputSchema.properties.steps_mode).toBeDefined();
      expect(def.inputSchema.properties.confirm_step_removal).toBeDefined();
    });
  });

  // ─── ENG-890 residual: the count guard above cannot see a replace that keeps
  // every step but blanks their contents. The admin route rebuilds each step
  // from a fixed field list (services/workPlanSteps.ts), defaulting
  // requiredFunctionCalls/skillIds to [], so re-sending the array as
  // title+description strips every tool requirement and skill attachment with
  // an unchanged step count — invisible to a length check.
  describe('manage_predefined_work_plan - update step content safety', () => {
    const existingPlan = {
      planId: 'wp-1',
      title: 'Meta Pre-Launch Gate',
      steps: [
        { stepCount: 1, title: 'Step 1: Scope', description: 'scope', requiredFunctionCalls: ['list_connected_accounts'], skillIds: ['sk-1'] },
        { stepCount: 2, title: 'Step 2: Inventory', description: 'inventory', requiredFunctionCalls: ['call_meta_marketing_api'], skillIds: ['sk-1'], userInstructions: 'read carefully', expectedAssetCount: 4 },
      ],
    };

    function mockPlanFetches(saved: any = { planId: 'wp-1', message: 'Updated' }) {
      mockMcpFetch.mockImplementation(async (opts: any) =>
        opts.method === 'GET' ? JSON.parse(JSON.stringify(existingPlan)) : saved
      );
    }
    const putCalls = () => mockMcpFetch.mock.calls.filter((c: any) => c[0].method === 'PUT');

    it('refuses a same-count replace that blanks step contents, and does NOT issue the PUT', async () => {
      mockPlanFetches();

      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps: [
          { title: 'Step 1: Scope', description: 'scope' },
          { title: 'Step 2: Inventory', description: 'inventory, reworded' },
        ],
      }, context);

      expect(putCalls()).toHaveLength(0);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.error).toMatch(/would blank/i);
      expect(payload.stepsWouldBeRemoved).toBe(0);
      expect(payload.stepContentLoss).toEqual([
        { stepCount: 1, title: 'Step 1: Scope', fields: ['requiredFunctionCalls', 'skillIds'] },
        { stepCount: 2, title: 'Step 2: Inventory', fields: ['requiredFunctionCalls', 'skillIds', 'userInstructions', 'expectedAssetCount'] },
      ]);
    });

    it('matches by title when the caller renumbers, so a reordered rewrite is still caught', async () => {
      mockPlanFetches();

      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps: [
          { stepCount: 1, title: 'Step 2: Inventory', description: 'inventory' },
          { stepCount: 2, title: 'Step 1: Scope', description: 'scope', required_function_calls: ['list_connected_accounts'], skill_ids: ['sk-1'] },
        ],
      }, context);

      expect(putCalls()).toHaveLength(0);
      const payload = JSON.parse(result.content[0].text);
      // Step 1 kept its contents under its new position; only step 2 lost any.
      expect(payload.stepContentLoss).toEqual([
        { stepCount: 2, title: 'Step 2: Inventory', fields: ['requiredFunctionCalls', 'skillIds', 'userInstructions', 'expectedAssetCount'] },
      ]);
    });

    it('allows the blanking replace once confirm_step_removal is set, and reports the loss', async () => {
      mockPlanFetches();

      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        confirm_step_removal: true,
        steps: [
          { title: 'Step 1: Scope', description: 'scope' },
          { title: 'Step 2: Inventory', description: 'inventory' },
        ],
      }, context);

      expect(putCalls()).toHaveLength(1);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.stepsChange.stepsRemoved).toBe(0);
      expect(payload.stepsChange.stepContentLoss).toHaveLength(2);
    });

    it('does NOT refuse a deliberate rewrite whose steps are all new', async () => {
      mockPlanFetches();

      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps: [
          { title: 'Brand new step A', description: 'a' },
          { title: 'Brand new step B', description: 'b' },
        ],
      }, context);

      // Nothing was kept, so there is no step the caller plainly meant to
      // preserve — the dropped titles in stepsChange already say what happened.
      expect(putCalls()).toHaveLength(1);
      const payload = JSON.parse(result.content[0].text);
      expect(payload.stepsChange.stepContentLoss).toBeUndefined();
      expect(payload.stepsChange.droppedStepTitles).toEqual(['Step 1: Scope', 'Step 2: Inventory']);
    });

    it('does not fire when the replace preserves the step contents', async () => {
      mockPlanFetches();

      await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps: existingPlan.steps.map((s) => ({ ...s })),
      }, context);

      expect(putCalls()).toHaveLength(1);
    });

    // A title is only an identity if it is unique. Two steps sharing one is
    // legal and does happen ("Review", "Follow up"), and both the diff and the
    // content matcher have to stay honest when it does.
    describe('duplicate step titles', () => {
      const duplicatePlan = {
        planId: 'wp-1',
        steps: [
          { stepCount: 1, title: 'Review', description: 'first review', requiredFunctionCalls: ['a'] },
          { stepCount: 2, title: 'Review', description: 'second review', requiredFunctionCalls: ['b'] },
          { stepCount: 3, title: 'Ship', description: 'ship it' },
        ],
      };
      function mockDuplicateFetches() {
        mockMcpFetch.mockImplementation(async (opts: any) =>
          opts.method === 'GET' ? JSON.parse(JSON.stringify(duplicatePlan)) : { planId: 'wp-1' }
        );
      }

      // Raised by Greptile on PR #2269. The diff matcher already refuses to
      // treat a shared title as an identity; merge did not, so a title-only
      // amendment silently landed on whichever duplicate came first.
      it('refuses a title-only merge when the title matches more than one step', async () => {
        mockDuplicateFetches();

        const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps_mode: 'merge',
          steps: [{ title: 'Review', description: 'which one?' }],
        }, context);

        expect(putCalls()).toHaveLength(0);
        const payload = JSON.parse(result.content[0].text);
        expect(payload.error).toMatch(/matches more than one step/i);
        expect(payload.ambiguousSteps).toEqual([
          { title: 'Review', matchingStepCounts: [1, 2] },
        ]);
      });

      // Second Greptile round on PR #2269. The ambiguity check skipped any step
      // carrying a stepCount, but the merge only USES that count if it matches
      // an existing step — otherwise it falls back to first-match-by-title. So a
      // stale or invented count was a way straight past the guard and onto the
      // wrong duplicate.
      it('refuses when the stepCount does not exist and the title is ambiguous', async () => {
        mockDuplicateFetches();

        const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps_mode: 'merge',
          steps: [{ stepCount: 99, title: 'Review', description: 'stale count' }],
        }, context);

        expect(putCalls()).toHaveLength(0);
        expect(JSON.parse(result.content[0].text).ambiguousSteps).toEqual([
          { title: 'Review', matchingStepCounts: [1, 2] },
        ]);
      });

      it('still falls back to a unique title when the stepCount does not exist', async () => {
        mockDuplicateFetches();

        await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps_mode: 'merge',
          steps: [{ stepCount: 99, title: 'Ship', description: 'shipped' }],
        }, context);

        // 'Ship' names exactly one step, so there is nothing ambiguous to refuse.
        const body = (putCalls()[0][0] as any).body;
        expect(body.steps).toHaveLength(3);
        expect(body.steps[2].description).toBe('shipped');
      });

      it('accepts the same merge once a stepCount disambiguates it', async () => {
        mockDuplicateFetches();

        await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps_mode: 'merge',
          steps: [{ stepCount: 2, title: 'Review', description: 'the second one' }],
        }, context);

        const body = (putCalls()[0][0] as any).body;
        expect(body.steps[1].description).toBe('the second one');
        expect(body.steps[0].description).toBe('first review');
      });

      // Third Greptile round on PR #2269, and the structural one. The preflight
      // resolved titles against the plan as READ, but application resolved them
      // against the array as it was being mutated. One request could therefore
      // rename a step and then, with an already-validated later entry, fail to
      // find it — turning an amendment into an append.
      it('refuses two entries that resolve to the same step, instead of letting one undo the other', async () => {
        mockMcpFetch.mockImplementation(async (opts: any) =>
          opts.method === 'GET'
            ? { planId: 'wp-1', steps: [
                { stepCount: 1, title: 'Alpha', description: 'a' },
                { stepCount: 2, title: 'Beta', description: 'b' },
              ] }
            : { planId: 'wp-1' }
        );

        const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps_mode: 'merge',
          steps: [
            { stepCount: 1, title: 'Renamed' },
            { title: 'Alpha', description: 'also me' },
          ],
        }, context);

        // Applying both in array order would let the second entry's title put
        // 'Alpha' back, silently undoing the rename. Under the previous
        // mutating resolution it instead appended a spurious third step.
        expect(putCalls()).toHaveLength(0);
        const payload = JSON.parse(result.content[0].text);
        expect(payload.error).toMatch(/resolves to the same existing step/i);
        expect(payload.conflictingSteps).toEqual([
          { stepCount: 1, title: 'Alpha', entries: 2 },
        ]);
      });

      it('gives the same result whichever order the entries arrive in', async () => {
        mockMcpFetch.mockImplementation(async (opts: any) =>
          opts.method === 'GET'
            ? { planId: 'wp-1', steps: [
                { stepCount: 1, title: 'Alpha', description: 'a' },
                { stepCount: 2, title: 'Beta', description: 'b' },
              ] }
            : { planId: 'wp-1' }
        );

        await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps_mode: 'merge',
          steps: [
            { title: 'Beta', description: 'beta amended' },
            { stepCount: 1, title: 'Renamed' },
          ],
        }, context);

        const body = (putCalls()[0][0] as any).body;
        expect(body.steps).toHaveLength(2);
        expect(body.steps[0].title).toBe('Renamed');
        expect(body.steps[1].description).toBe('beta amended');
      });

      it('reports a dropped step whose title still exists on another step', async () => {
        mockDuplicateFetches();

        const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          confirm_step_removal: true,
          steps: [
            { stepCount: 1, title: 'Review', description: 'first review', requiredFunctionCalls: ['a'] },
            { stepCount: 2, title: 'Ship', description: 'ship it' },
          ],
        }, context);

        const { stepsChange } = JSON.parse(result.content[0].text);
        expect(stepsChange.stepsRemoved).toBe(1);
        // One 'Review' survived, so a set-membership diff would call this empty.
        expect(stepsChange.droppedStepTitles).toEqual(['Review']);
      });

      it('pairs steps by position, not by an ambiguous title, when detecting content loss', async () => {
        mockDuplicateFetches();

        const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
          action: 'update',
          plan_id: 'wp-1',
          steps: [
            { stepCount: 1, title: 'Review', description: 'first review', requiredFunctionCalls: ['a'] },
            { stepCount: 2, title: 'Review', description: 'second review' },
            { stepCount: 3, title: 'Ship', description: 'ship it' },
          ],
        }, context);

        const payload = JSON.parse(result.content[0].text);
        // Only step 2 lost its requiredFunctionCalls. Matching on the shared
        // title would have paired both against step 1 and reported nothing.
        expect(payload.stepContentLoss).toEqual([
          { stepCount: 2, title: 'Review', fields: ['requiredFunctionCalls'] },
        ]);
      });
    });

    it('never fires in merge mode, which cannot blank a field it was not given', async () => {
      mockPlanFetches();

      const result = await mcpToolRegistry.execute('manage_predefined_work_plan', {
        action: 'update',
        plan_id: 'wp-1',
        steps_mode: 'merge',
        steps: [{ stepCount: 1, description: 'amended scope' }],
      }, context);

      expect(putCalls()).toHaveLength(1);
      const body = (putCalls()[0][0] as any).body;
      expect(body.steps[0].requiredFunctionCalls).toEqual(['list_connected_accounts']);
      expect(body.steps[1].expectedAssetCount).toBe(4);
      expect(JSON.parse(result.content[0].text).stepsChange.stepContentLoss).toBeUndefined();
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
