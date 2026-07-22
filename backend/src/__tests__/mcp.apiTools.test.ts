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
    it('should register install_skills and list_available_skills as internal tools', () => {
      const allNames = mcpToolRegistry.getToolNames();
      const externalDefs = mcpToolRegistry.getToolDefinitions();
      const externalNames = externalDefs.map((d: any) => d.name);
      // Registered (available to Emma internally)
      expect(allNames).toContain('install_skills');
      expect(allNames).toContain('list_available_skills');
      // But NOT exposed to external MCP clients
      expect(externalNames).not.toContain('install_skills');
      expect(externalNames).not.toContain('list_available_skills');
    });

    it('should register API-wrapping tools', () => {
      const names = mcpToolRegistry.getToolNames();
      const expectedTools = [
        'emma_create_session', 'emma_send_message', 'emma_get_session', 'emma_list_sessions',
        'list_tasks', 'manage_task', 'execute_task', 'list_task_executions',
        'list_schedules', 'manage_schedule',
        'list_scheduled_chats', 'manage_scheduled_chat', 'test_scheduled_chat',
        'get_scheduled_chat_test_history', 'submit_scheduled_chat_variables',
        'list_lead_lists', 'create_lead_list', 'manage_leads', 'search_leads',
        'list_gtm_plans', 'manage_gtm_plan', 'manage_gtm_items',
        'list_knowledge_bases', 'search_knowledge_base', 'read_knowledge_base_files',
        'manage_brand', 'manage_market_strategy',
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
      const internalTools = ['install_skills', 'list_available_skills', 'create_blog_article', 'publish_blog_article', 'you_search_web', 'you_search_news', 'google_search_web', 'generate_image', 'send_email', 'save_file'];
      for (const name of internalTools) {
        // Registered in the registry (available to Emma internally)
        expect(allNames).toContain(name);
        // But NOT exposed to external MCP clients
        expect(externalNames).not.toContain(name);
      }
      expect(allNames).not.toContain('search_web');
    });

    it('should NOT register old tool names (portal_*, read_brand_guidelines, etc.)', () => {
      const names = mcpToolRegistry.getToolNames();
      const oldNames = [
        'portal_list_tasks', 'portal_create_task', 'portal_execute_task',
        'read_brand_guidelines', 'update_brand_guidelines',
        'read_market_strategy', 'update_market_strategy',
        'get_lead_lists', 'list_knowledge_base_files',
        'create_work_plan', 'modify_work_plan', 'set_work_plan_status',
        'generate_blog_post', 'publish_blog_post',
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

  // ─── emma_send_message media_urls ────────────────────────────────────

  describe('emma_send_message', () => {
    it('should send message without media_urls', async () => {
      mockMcpFetch.mockResolvedValue({ response: 'Hello!' });

      await mcpToolRegistry.execute('emma_send_message', {
        session_id: 'sess-1',
        message: 'Hi Emma',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/agent-mode/generate',
        body: expect.objectContaining({
          sessionId: 'sess-1',
          userMessage: 'Hi Emma',
        }),
      }));
      // No attachments when media_urls not provided
      const callBody = mockMcpFetch.mock.calls[0][0].body as any;
      expect(callBody.attachments).toBeUndefined();
    });

    it('should map media_urls to attachments array', async () => {
      mockMcpFetch.mockResolvedValue({ response: 'Got the images!' });

      await mcpToolRegistry.execute('emma_send_message', {
        session_id: 'sess-1',
        message: 'Check these screenshots',
        media_urls: ['https://s3.amazonaws.com/img1.png', 'https://s3.amazonaws.com/img2.jpg'],
      }, context);

      const callBody = mockMcpFetch.mock.calls[0][0].body as any;
      expect(callBody.attachments).toEqual([
        { url: 'https://s3.amazonaws.com/img1.png', filename: 'img1.png' },
        { url: 'https://s3.amazonaws.com/img2.jpg', filename: 'img2.jpg' },
      ]);
    });

    it('should handle empty media_urls array (no attachments)', async () => {
      mockMcpFetch.mockResolvedValue({ response: 'OK' });

      await mcpToolRegistry.execute('emma_send_message', {
        session_id: 'sess-1',
        message: 'No images',
        media_urls: [],
      }, context);

      const callBody = mockMcpFetch.mock.calls[0][0].body as any;
      expect(callBody.attachments).toBeUndefined();
    });

    it('should extract filename from URL path', async () => {
      mockMcpFetch.mockResolvedValue({ response: 'OK' });

      await mcpToolRegistry.execute('emma_send_message', {
        session_id: 'sess-1',
        message: 'test',
        media_urls: ['https://bucket.s3.us-west-2.amazonaws.com/uploads/screenshot-dashboard.png'],
      }, context);

      const callBody = mockMcpFetch.mock.calls[0][0].body as any;
      expect(callBody.attachments[0].filename).toBe('screenshot-dashboard.png');
    });

    it('should include media_urls in tool input schema', () => {
      const defs = mcpToolRegistry.getToolDefinitions();
      const emmaSend = defs.find((d: any) => d.name === 'emma_send_message');
      expect(emmaSend).toBeDefined();
      expect(emmaSend!.inputSchema.properties.media_urls).toBeDefined();
      expect(emmaSend!.inputSchema.properties.media_urls.type).toBe('array');
    });
  });

  // ─── Emma delegation capability discovery (ENG-257) ──────────────────
  // External MCP clients (e.g. Claude) only see these tool descriptions, and
  // there is no ads/marketing execution tool in the external set — that work
  // happens by delegating to Emma. If the delegation tools don't tell the client
  // to hand marketing/growth requests to Emma, it pre-judges feasibility from the
  // visible tools and hallucinates that the capability is unsupported.
  //
  // The fix is a GENERAL delegation directive, NOT a capability catalogue: the
  // description must NOT enumerate Emma's capabilities (platforms OR feature list).
  // Enumerations undersell (anything not listed gets denied) and go stale as Emma
  // gains skills — verified live: an enumerated list under-delegated a non-listed
  // capability (SEO) while the general directive delegated it. So these assertions
  // check the delegate/don't-pre-judge/don't-deny contract and FORBID enumeration.
  describe('emma delegation capability discovery', () => {
    const getDesc = (name: string) => {
      const def = mcpToolRegistry.getToolDefinitions().find((d: any) => d.name === name);
      expect(def).toBeDefined();
      return def!.description as string;
    };

    it('emma_send_message tells the client to delegate and NOT pre-judge feasibility, and not to deny it itself', () => {
      const desc = getDesc('emma_send_message').toLowerCase();
      expect(desc).toContain('delegate');                 // route the request to Emma
      expect(desc).toMatch(/pre-judge|feasib|determine/); // let Emma decide, don't guess
      expect(desc).toMatch(/unsupported|unavailable/);    // don't-deny guidance
    });

    it('emma_create_session signals Emma is a full GTM agent to delegate marketing work to', () => {
      const desc = getDesc('emma_create_session').toLowerCase();
      expect(desc).toContain('gtm');
      expect(desc).toContain('delegate');
      expect(desc).toMatch(/feasib|pre-judge|determine/);
    });

    it('descriptions do NOT enumerate capabilities — no platform names, no feature catalogue (maintainability / no-undersell guard)', () => {
      // A capability list means editing prose on every new skill/platform AND
      // undersells anything omitted. The general delegation directive must carry
      // the meaning instead. Forbid specific platforms and enumerated feature nouns.
      const forbidden = [
        'meta', 'facebook', 'instagram', 'linkedin', 'tiktok', 'google ads', // platforms
        'crm', 'landing page', 'blog', 'work plan', 'seo',                    // feature catalogue
      ];
      for (const name of ['emma_create_session', 'emma_send_message']) {
        const desc = getDesc(name).toLowerCase();
        for (const term of forbidden) {
          expect(desc).not.toContain(term);
        }
      }
    });
  });

  describe('enable_lead_list_public_access', () => {
    it('should call the dedicated public-access endpoint with { enabled: true }', async () => {
      mockMcpFetch.mockResolvedValue({ success: true, publicAccessEnabled: true });

      await mcpToolRegistry.execute('enable_lead_list_public_access', {
        list_id: 'list_123',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'PUT',
        path: '/api/crm/lists/list_123/public-access',
        body: { enabled: true },
      }));
    });

    it('should NOT post publicAccessEnabled to the generic list-update endpoint', async () => {
      mockMcpFetch.mockResolvedValue({ success: true });

      await mcpToolRegistry.execute('enable_lead_list_public_access', {
        list_id: 'list_456',
      }, context);

      const call = mockMcpFetch.mock.calls[0][0];
      // The generic PUT /api/crm/lists/:id route silently ignores
      // publicAccessEnabled, so the tool must not use it.
      expect(call.path).not.toBe('/api/crm/lists/list_456');
      expect((call.body as any)?.publicAccessEnabled).toBeUndefined();
    });

    it('should propagate a 403 from the access check', async () => {
      mockMcpFetch.mockRejectedValue(new Error('API error (403): Access denied'));

      await expect(
        mcpToolRegistry.execute('enable_lead_list_public_access', { list_id: 'list_789' }, context)
      ).rejects.toThrow('API error (403): Access denied');
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

  // ─── get_chat_history ─────────────────────────────────────────────────

  describe('get_chat_history', () => {
    it('should return all metadata fields and exclude raw messages', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-1',
          userId: 'user-1',
          title: 'Test Session',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          portalType: 'customer',
          sessionType: 'regular',
          llmModel: 'claude-sonnet-4-6',
          totalTokens: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          totalCost: 0.003,
          satisfactionScore: { score: 4, reason: 'Good', evaluatedAt: '2026-03-28T01:00:00Z', evaluatedMessageIndex: 3 },
          judgeScores: { judge1: { score: 5, reason: 'Great', evaluatedAt: '2026-03-28T01:00:00Z', evaluatedMessageIndex: 3, judgeName: 'Judge 1' } },
          workPlan: {
            title: 'Plan A',
            steps: [{ stepCount: 1, title: 'Step 1', description: 'Do something', status: 'completed' }],
            createdAt: '2026-03-28T00:00:00Z',
            updatedAt: '2026-03-28T00:30:00Z',
          },
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there', metadata: { feedback: { type: 'like' }, timestamp: '2026-03-28T00:01:00Z' } },
            { role: 'assistant', content: 'More info', metadata: {
              feedback: { type: 'dislike' },
              iterationTimings: [{ llmDurationMs: 5000 }, { llmDurationMs: 3000 }],
              memoryUsage: { currentHeapUsedMB: 2500 },
              timestamp: '2026-03-28T00:02:00Z',
            }},
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const parsed = JSON.parse((result as any).content[0].text);
      const session = parsed.sessions[0];

      // All metadata fields present
      expect(session.sessionId).toBe('sess-1');
      expect(session.portalType).toBe('customer');
      expect(session.llmModel).toBe('claude-sonnet-4-6');
      expect(session.sessionType).toBe('regular');
      expect(session.messageCount).toBe(3);
      expect(session.totalTokens).toEqual({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
      expect(session.totalCost).toBe(0.003);
      expect(session.satisfactionScore).toBeDefined();
      expect(session.judgeScores).toBeDefined();

      // Computed metrics
      expect(session.feedback).toEqual({ likes: 1, dislikes: 1 });
      expect(session.longestWaitMs).toBe(8000);
      expect(session.maxHeapMB).toBe(2500);

      // Work plan summary (no description field)
      expect(session.workPlan).toEqual({
        title: 'Plan A',
        steps: [{ stepCount: 1, title: 'Step 1', status: 'completed' }],
      });

      // Raw messages NOT included
      expect(session.messages).toBeUndefined();
    });

    it('should handle sessions with no messages gracefully', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-2',
          userId: 'user-2',
          title: null,
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T00:00:00Z',
          messages: [],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const parsed = JSON.parse((result as any).content[0].text);
      const session = parsed.sessions[0];

      expect(session.messageCount).toBe(0);
      expect(session.portalType).toBeNull();
      expect(session.llmModel).toBeNull();
      expect(session.sessionType).toBeNull();
      expect(session.feedback).toBeNull();
      expect(session.longestWaitMs).toBeNull();
      expect(session.maxHeapMB).toBeNull();
      expect(session.workPlan).toBeNull();
      expect(session.messages).toBeUndefined();
    });

    it('should handle sessions with no feedback or timing data', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-3',
          userId: 'user-3',
          title: 'Plain Session',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          llmModel: 'gpt-4o',
          portalType: 'partner',
          messages: [
            { role: 'user', content: 'test' },
            { role: 'assistant', content: 'response', metadata: { timestamp: '2026-03-28T00:01:00Z' } },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const parsed = JSON.parse((result as any).content[0].text);
      const session = parsed.sessions[0];

      expect(session.llmModel).toBe('gpt-4o');
      expect(session.portalType).toBe('partner');
      expect(session.messageCount).toBe(2);
      // No feedback, timings, or heap data
      expect(session.feedback).toBeNull();
      expect(session.longestWaitMs).toBeNull();
      expect(session.maxHeapMB).toBeNull();
    });

    it('should include delegateInfo when session was started by admin delegation', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-delegate',
          userId: 'user-customer',
          title: 'Delegated Session',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          sessionType: 'regular',
          delegateInfo: { adminUserId: 'admin-1', adminEmail: 'admin@example.com', isDelegated: true },
          messages: [{ role: 'user', content: 'Hello' }],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const parsed = JSON.parse((result as any).content[0].text);
      const session = parsed.sessions[0];

      expect(session.delegateInfo).toEqual({ adminUserId: 'admin-1', adminEmail: 'admin@example.com', isDelegated: true });
    });

    it('should return null delegateInfo for non-delegated sessions', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-normal',
          userId: 'user-1',
          title: 'Normal Session',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          sessionType: 'regular',
          messages: [],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const parsed = JSON.parse((result as any).content[0].text);
      const session = parsed.sessions[0];

      expect(session.delegateInfo).toBeNull();
    });
  });

  // ─── get_account_status ───────────────────────────────────────────────
  //
  // Behavioral contract (from Notion spec — agent must satisfy these):
  //  - Tool name: get_account_status
  //  - Input: {} (no args)
  //  - Output: { email, subscription_plan, subscription_status,
  //              current_period_end, allowed_features, api_key_count }
  //  - Wraps GET /api/auth/me (plan/status) + GET /api/v1/agent/api-keys (count)
  //  - Registered + exposed to external MCP clients.

  describe('get_account_status', () => {
    const meResponse = {
      userId: 'user-123',
      email: 'jane@acme.com',
      subscriptionType: 'Pro',
      subscription_status: 'active',
      current_period_end: '2026-07-01T00:00:00Z',
      allowedPages: ['chat', 'crm', 'reports'],
      // Extra raw fields that must NOT leak into the curated output:
      password: 'should-never-appear',
      stripe_customer_id: 'cus_secret',
    };

    it('should register get_account_status and expose it to external MCP clients', () => {
      const allNames = mcpToolRegistry.getToolNames();
      expect(allNames).toContain('get_account_status');

      const externalNames = mcpToolRegistry.getToolDefinitions().map((d: any) => d.name);
      expect(externalNames).toContain('get_account_status');
    });

    it('should declare a no-arg input schema (object with no required fields)', () => {
      const def = mcpToolRegistry.getToolDefinitions().find((d: any) => d.name === 'get_account_status');
      expect(def).toBeDefined();
      expect(def!.inputSchema.type).toBe('object');
      expect(def!.inputSchema.required ?? []).toEqual([]);
    });

    it('should call GET /api/auth/me and GET /api/v1/agent/api-keys with the caller context', async () => {
      mockMcpFetch.mockImplementation(async (opts: any) => {
        if (opts.path === '/api/auth/me') return meResponse;
        if (opts.path === '/api/v1/agent/api-keys') return { keys: [{ keyId: 'k1' }, { keyId: 'k2' }] };
        throw new Error(`Unexpected path: ${opts.path}`);
      });

      await mcpToolRegistry.execute('get_account_status', {}, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/auth/me',
        context: { userId: 'user-123', agentUserId: 'user-123' },
      }));
      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET',
        path: '/api/v1/agent/api-keys',
        context: { userId: 'user-123', agentUserId: 'user-123' },
      }));
    });

    it('should return exactly the curated output shape (mapping subscriptionType→plan, allowedPages→features, key count)', async () => {
      mockMcpFetch.mockImplementation(async (opts: any) => {
        if (opts.path === '/api/auth/me') return meResponse;
        if (opts.path === '/api/v1/agent/api-keys') return { keys: [{ keyId: 'k1' }, { keyId: 'k2' }, { keyId: 'k3' }] };
        throw new Error(`Unexpected path: ${opts.path}`);
      });

      const result = await mcpToolRegistry.execute('get_account_status', {}, context);
      const parsed = JSON.parse((result as any).content[0].text);

      expect(parsed).toEqual({
        email: 'jane@acme.com',
        subscription_plan: 'Pro',
        subscription_status: 'active',
        current_period_end: '2026-07-01T00:00:00Z',
        allowed_features: ['chat', 'crm', 'reports'],
        api_key_count: 3,
      });
    });

    it('should never leak sensitive raw fields (password, stripe_customer_id) into the output', async () => {
      mockMcpFetch.mockImplementation(async (opts: any) => {
        if (opts.path === '/api/auth/me') return meResponse;
        if (opts.path === '/api/v1/agent/api-keys') return { keys: [] };
        throw new Error(`Unexpected path: ${opts.path}`);
      });

      const result = await mcpToolRegistry.execute('get_account_status', {}, context);
      const text = (result as any).content[0].text;

      expect(text).not.toContain('password');
      expect(text).not.toContain('should-never-appear');
      expect(text).not.toContain('stripe_customer_id');
      expect(text).not.toContain('cus_secret');
    });

    it('should default missing plan/status fields to safe values and zero api keys', async () => {
      mockMcpFetch.mockImplementation(async (opts: any) => {
        // Free user with no Stripe subscription and no allowedPages resolved.
        if (opts.path === '/api/auth/me') return { email: 'free@acme.com' };
        if (opts.path === '/api/v1/agent/api-keys') return { keys: [] };
        throw new Error(`Unexpected path: ${opts.path}`);
      });

      const result = await mcpToolRegistry.execute('get_account_status', {}, context);
      const parsed = JSON.parse((result as any).content[0].text);

      expect(parsed).toEqual({
        email: 'free@acme.com',
        subscription_plan: 'Free',
        subscription_status: 'inactive',
        current_period_end: null,
        allowed_features: [],
        api_key_count: 0,
      });
    });

    it('should treat a missing/non-array keys payload as zero api keys', async () => {
      mockMcpFetch.mockImplementation(async (opts: any) => {
        if (opts.path === '/api/auth/me') return meResponse;
        if (opts.path === '/api/v1/agent/api-keys') return {}; // no keys field
        throw new Error(`Unexpected path: ${opts.path}`);
      });

      const result = await mcpToolRegistry.execute('get_account_status', {}, context);
      const parsed = JSON.parse((result as any).content[0].text);

      expect(parsed.api_key_count).toBe(0);
    });

    it('should still report account status even if the api-keys call fails (count falls back to 0)', async () => {
      mockMcpFetch.mockImplementation(async (opts: any) => {
        if (opts.path === '/api/auth/me') return meResponse;
        if (opts.path === '/api/v1/agent/api-keys') throw new Error('API error (500): keys unavailable');
        throw new Error(`Unexpected path: ${opts.path}`);
      });

      const result = await mcpToolRegistry.execute('get_account_status', {}, context);
      const parsed = JSON.parse((result as any).content[0].text);

      expect(parsed.email).toBe('jane@acme.com');
      expect(parsed.subscription_plan).toBe('Pro');
      expect(parsed.api_key_count).toBe(0);
    });

    it('should propagate an auth error from the /me call (cannot resolve account)', async () => {
      mockMcpFetch.mockImplementation(async (opts: any) => {
        if (opts.path === '/api/auth/me') throw new Error('API error (401): Unauthorized');
        return { keys: [] };
      });

      await expect(
        mcpToolRegistry.execute('get_account_status', {}, context)
      ).rejects.toThrow('API error (401): Unauthorized');
    });
  });

});
