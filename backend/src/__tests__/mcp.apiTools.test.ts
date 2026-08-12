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
        'emma_create_session', 'emma_send_message', 'emma_answer_question', 'emma_get_session', 'emma_list_sessions',
        'list_tasks', 'manage_task', 'execute_task', 'list_task_executions',
        'list_schedules', 'manage_schedule',
        'list_scheduled_chats', 'manage_scheduled_chat', 'test_scheduled_chat',
        'get_scheduled_chat_test_history', 'submit_scheduled_chat_variables',
        'list_lead_lists', 'create_lead_list', 'manage_leads', 'search_leads',
        'list_gtm_plans', 'manage_gtm_plan', 'manage_gtm_items',
        'list_knowledge_bases', 'search_knowledge_base', 'read_knowledge_base_files',
        'manage_brand', 'manage_market_strategy',
        'list_connected_accounts', 'post_on_account',
        'emma_get_onboarding_status', 'emma_update_onboarding',
        'emma_record_onboarding_event', 'emma_start_brand_build',
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

  });

  // ─── emma_answer_question (ENG-400: MCP transport for the AskUserQuestion primitive) ───

  describe('emma_answer_question', () => {
    it('posts a direct pick through the structured questionAnswer channel, using option_id as the default label', async () => {
      mockMcpFetch.mockResolvedValue({ response: 'OK' });

      await mcpToolRegistry.execute('emma_answer_question', {
        session_id: 'sess-1',
        question_id: 'q-1',
        option_id: 'leads',
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        path: '/api/agent-mode/generate',
        body: {
          sessionId: 'sess-1',
          userMessage: 'leads',
          questionAnswer: { questionId: 'q-1', optionId: 'leads', delegated: false },
        },
      }));
    });

    it('uses a provided label as the human-readable chat message instead of the raw option_id', async () => {
      mockMcpFetch.mockResolvedValue({ response: 'OK' });

      await mcpToolRegistry.execute('emma_answer_question', {
        session_id: 'sess-1',
        question_id: 'q-1',
        option_id: 'leads',
        label: 'Leads',
      }, context);

      const callBody = mockMcpFetch.mock.calls[0][0].body as any;
      expect(callBody.userMessage).toBe('Leads');
    });

    it('posts a delegation ("Let Emma decide") with delegated:true and no option_id required', async () => {
      mockMcpFetch.mockResolvedValue({ response: 'OK' });

      await mcpToolRegistry.execute('emma_answer_question', {
        session_id: 'sess-1',
        question_id: 'q-1',
        delegate: true,
      }, context);

      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        body: {
          sessionId: 'sess-1',
          userMessage: 'Let Emma decide',
          questionAnswer: { questionId: 'q-1', optionId: undefined, delegated: true },
        },
      }));
    });

    it('refuses (without calling the API) a direct pick missing option_id', async () => {
      const result = await mcpToolRegistry.execute('emma_answer_question', {
        session_id: 'sess-1',
        question_id: 'q-1',
      }, context);

      expect(mockMcpFetch).not.toHaveBeenCalled();
      expect(JSON.parse(result.content[0].text).success).toBe(false);
    });

    it('is registered with session_id and question_id required', () => {
      const defs = mcpToolRegistry.getToolDefinitions();
      const answerQuestion = defs.find((d: any) => d.name === 'emma_answer_question');
      expect(answerQuestion).toBeDefined();
      expect(answerQuestion.inputSchema.required).toEqual(['session_id', 'question_id']);
    });
  });

  describe('emma_send_message input schema', () => {
    it('should include media_urls in tool input schema', () => {
      const defs = mcpToolRegistry.getToolDefinitions();
      const emmaSend = defs.find((d: any) => d.name === 'emma_send_message');
      expect(emmaSend).toBeDefined();
      expect(emmaSend!.inputSchema.properties.media_urls).toBeDefined();
      expect(emmaSend!.inputSchema.properties.media_urls.type).toBe('array');
    });
  });

  // ─── generate_image category declaration (ENG-343) ───────────────────
  // The service guard makes a missing category fail visibly, but the guard alone
  // only converts a silent miscategorization into a hard failure — it cannot make
  // the model supply the value. `required` is what actually gets the category
  // declared. If it is dropped here, the model stops sending it and EVERY image
  // generation fails at the guard, so this schema is load-bearing, not cosmetic.
  // `generate_image` is `internal: true`, so it is absent from getToolDefinitions()
  // — read it via getTool() or this assertion silently tests nothing.
  describe('generate_image category declaration (ENG-343)', () => {
    const schema = () => mcpToolRegistry.getTool('generate_image')!.definition.inputSchema;

    it('requires category so the model must declare the eval use case', () => {
      expect(schema().required).toContain('category');
    });

    it('constrains category to exactly the two reviewable use cases', () => {
      expect(schema().properties.category.enum).toEqual(['ad', 'organic_post']);
    });

    it('does not offer uncategorized as a producible value', () => {
      expect(schema().properties.category.enum).not.toContain('uncategorized');
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

    // ENG-892: `llmModel` is only the model picker's selection — it records what a
    // client PATCHed, not what generated the text. The per-message `llm` written after
    // model resolution is the real provenance, and the two diverge often enough to
    // mis-label the daily satisfaction and cost reports.
    it('should report the models that actually generated turns, not just the picker', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-picker-mismatch',
          userId: 'user-4',
          title: 'Picker says one thing, transcript says another',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          // A live voice model: callLLM throws for these, so it cannot have produced a token.
          llmModel: 'gemini-3.1-flash-live-preview',
          messages: [
            { role: 'user', content: 'Analyse my funnel' },
            { role: 'assistant', content: 'Working on it', llm: 'anthropic.claude-opus-5' },
            { role: 'tool', content: '{}', name: 'get_website_analytics' },
            { role: 'assistant', content: 'Here are the results', llm: 'anthropic.claude-opus-5' },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      // Both kept — the mismatch between them is itself signal.
      expect(session.llmModel).toBe('gemini-3.1-flash-live-preview');
      expect(session.generationModels).toEqual(['anthropic.claude-opus-5']);
    });

    it('should list every generation model when a session switches mid-run', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-backup-switch',
          userId: 'user-5',
          title: 'Backup model kicked in',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          llmModel: 'claude-sonnet-4-5',
          messages: [
            { role: 'user', content: 'Go' },
            { role: 'assistant', content: 'First', llm: 'anthropic.claude-opus-5' },
            { role: 'assistant', content: 'Second', llm: 'gpt-5-chat-2' },
            // Deduped, not repeated.
            { role: 'assistant', content: 'Third', llm: 'anthropic.claude-opus-5' },
            // Assistant turns with no recorded provenance contribute nothing.
            { role: 'assistant', content: 'Fourth' },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      expect(session.generationModels).toEqual(['anthropic.claude-opus-5', 'gpt-5-chat-2']);
    });

    it('should return null generationModels when no message records a model', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-no-provenance',
          userId: 'user-6',
          title: 'Legacy session',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          llmModel: 'gpt-4o',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi' },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      // null, not [] — degrades to the pre-ENG-892 behaviour of reporting only the picker.
      expect(session.generationModels).toBeNull();
      expect(session.llmModel).toBe('gpt-4o');
      // ...but attribution still resolves, flagged as unverified.
      expect(session.attributedModels).toEqual(['gpt-4o']);
      expect(session.attributionBasis).toBe('selection-only');
    });

    it('should pre-resolve attributedModels from the transcript when provenance exists', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-eng829',
          userId: 'user-7',
          title: 'GA4 Upstream Funnel Tracking',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          // The ENG-829 shape: picker holds a live voice model that cannot emit a token.
          llmModel: 'gemini-3.1-flash-live-preview',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi', llm: 'anthropic.claude-opus-5' },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      // The agent is handed the answer, not a choice between two model-shaped fields.
      expect(session.attributedModels).toEqual(['anthropic.claude-opus-5']);
      expect(session.attributionBasis).toBe('transcript');
      // Both underlying fields stay available — the mismatch is still signal.
      expect(session.llmModel).toBe('gemini-3.1-flash-live-preview');
    });

    it('should null both attribution fields when nothing is recorded at all', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-empty',
          userId: 'user-8',
          title: 'No model anywhere',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          messages: [{ role: 'user', content: 'Hello' }],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      expect(session.attributedModels).toBeNull();
      expect(session.attributionBasis).toBeNull();
    });

    // Cache tokens are billed but excluded from total_tokens, so cost/token ratios
    // computed from totalTokens alone are off by ~100x on cache-heavy scheduled runs
    // (a real session: 371 total_tokens, 156,013 cache-creation tokens, $2.94).
    it('should surface cache tokens so cost is reconcilable against tokens', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-cache-heavy',
          userId: 'user-9',
          title: 'Scheduled: connection watcher',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          messages: [
            { role: 'user', content: 'run' },
            {
              role: 'assistant', content: 'ok', llm: 'anthropic.claude-opus-4-8',
              usage: {
                prompt_tokens: 299, completion_tokens: 72, total_tokens: 371,
                cache_creation_input_tokens: 156013, cache_read_input_tokens: 0,
                estimated_cost: 2.93512875,
              },
            },
            {
              role: 'assistant', content: 'done', llm: 'anthropic.claude-opus-4-8',
              usage: {
                prompt_tokens: 98, completion_tokens: 542, total_tokens: 640,
                cache_creation_input_tokens: 0, cache_read_input_tokens: 4000,
                estimated_cost: 0.28309575,
              },
            },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      expect(session.cacheTokens).toEqual({ creation: 156013, read: 4000 });
    });

    it('should return null cacheTokens when no turn recorded any cache usage', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-no-cache',
          userId: 'user-10',
          title: 'No caching',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          messages: [
            { role: 'user', content: 'hi' },
            {
              role: 'assistant', content: 'hello', llm: 'gpt-5-chat-2',
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, estimated_cost: 0.001 },
            },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      // null, not {creation:0,read:0} — nothing to explain for non-caching sessions.
      expect(session.cacheTokens).toBeNull();
    });

    // Greptile P1: attributedModels listed every model but totalCost stayed a single
    // session-wide number, so a per-model cost breakdown had to guess, duplicate or
    // drop the cost. The per-turn data to split it already exists.
    it('should allocate cost per model on a multi-model session', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-multi',
          userId: 'user-11',
          title: 'Mixed-model session',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          totalCost: 1.5,
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'a', llm: 'anthropic.claude-opus-5', usage: { estimated_cost: 1.0 } },
            { role: 'assistant', content: 'b', llm: 'gemini-3.5-flash', usage: { estimated_cost: 0.3 } },
            { role: 'assistant', content: 'c', llm: 'anthropic.claude-opus-5', usage: { estimated_cost: 0.2 } },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      expect(session.costByModel).toEqual({
        'anthropic.claude-opus-5': 1.2,
        'gemini-3.5-flash': 0.3,
      });
      expect(session.unattributedCost).toBeNull();
    });

    // Greptile P1: a session mixing labelled and unlabelled assistant turns still
    // returned a non-null generationModels, so a partial set read as complete.
    // Surface the unattributed spend instead of silently dropping it.
    it('should surface spend on turns that recorded no model', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-partial',
          userId: 'user-12',
          title: 'Partially labelled',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          totalCost: 1.4,
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'a', llm: 'anthropic.claude-opus-5', usage: { estimated_cost: 1.0 } },
            { role: 'assistant', content: 'b', usage: { estimated_cost: 0.4 } },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      expect(session.costByModel).toEqual({ 'anthropic.claude-opus-5': 1.0 });
      // Non-null means the model list does NOT account for all spend.
      expect(session.unattributedCost).toBe(0.4);
      expect(session.attributionBasis).toBe('partial-transcript');
    });

    // Greptile 4/5 follow-up: an unlabelled turn carrying no cost left
    // unattributedCost null, so a partial transcript still claimed 'transcript'.
    // Real shape — prod session 8fb98376 has 2 unlabelled turns and a ~$0 delta.
    it('should mark attribution partial even when the unlabelled turn has no cost', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-partial-nocost',
          userId: 'user-14',
          title: 'Partial, no cost on the gap',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          totalCost: 1.0,
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'a', llm: 'anthropic.claude-opus-5', usage: { estimated_cost: 1.0 } },
            { role: 'assistant', content: 'b' },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      expect(session.attributionBasis).toBe('partial-transcript');
      expect(session.unattributedCost).toBeNull();
    });

    // Greptile 4/5 follow-up: totalCost includes tool spend that never lands on an
    // assistant turn, so costByModel alone understates the session. Real shape —
    // prod session 7cac004d: $100.19 total vs $98.28 across turns.
    it('should count non-turn (tool) spend as unattributed', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-tool-cost',
          userId: 'user-15',
          title: 'Tool spend outside the turns',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          totalCost: 3.0,
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'a', llm: 'anthropic.claude-opus-5', usage: { estimated_cost: 2.0 } },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      // Every assistant turn is labelled, so attribution is not partial...
      expect(session.attributionBasis).toBe('transcript');
      // ...but $1.00 of session spend still is not attributable to any model.
      expect(session.unattributedCost).toBe(1.0);
      // The invariant consumers can rely on: sum(costByModel) + unattributed = totalCost.
      const summed = Object.values(session.costByModel as Record<string, number>)
        .reduce((a, b) => a + b, 0);
      expect(summed + session.unattributedCost).toBeCloseTo(session.totalCost, 6);
    });

    it('should null costByModel and unattributedCost when no turn records cost', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-nocost',
          userId: 'user-13',
          title: 'No usage',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello', llm: 'gpt-5-chat-2' },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      expect(session.costByModel).toBeNull();
      expect(session.unattributedCost).toBeNull();
    });

    // Greptile: buckets were rounded individually while the residual was derived
    // from unrounded buckets and totalCost was rounded separately, so the three
    // could disagree — on a contract the description tells consumers to rely on.
    // Sub-micro-dollar turn costs make the drift visible: each bucket rounds to
    // zero, so a residual computed from unrounded values reported nothing while
    // totalCost still rounded up to 1 micro-dollar.
    it('should keep cost components reconciling under rounding', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-rounding',
          userId: 'user-16',
          title: 'Sub-micro turn costs',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          totalCost: 0.0000008,
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'a', llm: 'model-a', usage: { estimated_cost: 0.0000004 } },
            { role: 'assistant', content: 'b', llm: 'model-b', usage: { estimated_cost: 0.0000004 } },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      // Compare in whole micro-dollars — the unit the payload is rounded to.
      const micro = (n: number) => Math.round(n * 1e6);
      const bucketMicro = Object.values(session.costByModel ?? {})
        .reduce((a: number, b) => a + micro(b as number), 0);
      const residualMicro = micro(session.unattributedCost ?? 0);

      expect(bucketMicro + residualMicro).toBe(micro(session.totalCost));
    });

    // Real shape: prod sessions 12b68d41 and 6219e856 have per-turn costs summing a
    // few micro-dollars ABOVE the stored session total. Report null rather than a
    // negative "unattributed spend", and never rescale the buckets to force a fit.
    it('should report null rather than a negative residual when turns exceed the total', async () => {
      mockMcpFetch.mockResolvedValue({
        sessions: [{
          sessionId: 'sess-over',
          userId: 'user-17',
          title: 'Turn costs slightly exceed the session total',
          createdAt: '2026-03-28T00:00:00Z',
          updatedAt: '2026-03-28T01:00:00Z',
          totalCost: 1.000000,
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'a', llm: 'model-a', usage: { estimated_cost: 0.600002 } },
            { role: 'assistant', content: 'b', llm: 'model-b', usage: { estimated_cost: 0.400002 } },
          ],
        }],
        nextCursor: null,
      });

      const result = await mcpToolRegistry.execute('get_chat_history', {
        start_time: '2026-03-28T00:00:00Z',
        end_time: '2026-03-29T00:00:00Z',
      }, context);

      const session = JSON.parse((result as any).content[0].text).sessions[0];

      expect(session.unattributedCost).toBeNull();
      // Buckets are reported as measured, not scaled down to fit totalCost.
      expect(session.costByModel).toEqual({ 'model-a': 0.600002, 'model-b': 0.400002 });
    });

    it('should tell consumers to split cost with costByModel, not the model list', () => {
      const description = mcpToolRegistry.getTool('get_chat_history')!.definition.description!;
      expect(description).toContain('costByModel');
      expect(description).toContain('unattributedCost');
    });

    it('should warn that totalTokens excludes billed cache tokens', () => {
      const description = mcpToolRegistry.getTool('get_chat_history')!.definition.description!;
      expect(description).toContain('totalTokens EXCLUDES');
      expect(description).toContain('cacheTokens');
    });

    it('should direct attribution to attributedModels and override stale cost-grouping guidance', () => {
      const description = mcpToolRegistry.getTool('get_chat_history')!.definition.description!;
      // The guidance, not just the field names — the reports name a model because the
      // payload label invites it, so the primacy instruction is the fix's mechanism.
      expect(description).toContain('use attributedModels');
      // A live account memory on the reporting account still tells the agent to group
      // cost by llmModel; the description has to outrank it explicitly.
      expect(description).toContain('Never group or attribute cost by llmModel');
      expect(description).toContain('saved memory');
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
        if (opts.path === '/api/subscription/usage') return { used: 100, allowance: 1000, effectiveAllowance: 1000, percentUsed: 10, warning: false };
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
        usage: { used: 100, allowance: 1000, remaining_allowance: 900, percent_used: 10, warning: false },
        next_tier: 'Managed',
        upgrade_url: 'https://calendly.com/harsha-agentweb/30min',
        upgrade_message: 'You have reached your plan limit. Book a call to move to Managed.',
      });
    });

    it('should never leak sensitive raw fields (password, stripe_customer_id) into the output', async () => {
      mockMcpFetch.mockImplementation(async (opts: any) => {
        if (opts.path === '/api/auth/me') return meResponse;
        if (opts.path === '/api/v1/agent/api-keys') return { keys: [] };
        if (opts.path === '/api/subscription/usage') return { used: 0, allowance: 100, effectiveAllowance: 100, percentUsed: 0, warning: false };
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
        usage: null,
        next_tier: 'Starter',
        upgrade_url: 'https://app.agentweb.pro/pricing?upgrade=starter&source=mcp',
        upgrade_message: 'You have reached your plan limit. Upgrade to Starter to keep going.',
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

  describe('MCP onboarding tools', () => {
    it('reads onboarding state from the existing authenticated routes', async () => {
      mockMcpFetch
        .mockResolvedValueOnce({ onboardingProgress: { step: 'brand' }, onboardingDismissed: false })
        .mockResolvedValueOnce({
          onboardingStage: 'brand_submitted',
          onboardingEvents: [{ event: 'goal_selected' }, { event: 'brand_submitted' }],
        })
        .mockResolvedValueOnce({ status: 'building' });

      const result = await mcpToolRegistry.execute('emma_get_onboarding_status', {}, context);
      const parsed = JSON.parse((result as any).content[0].text);
      expect(parsed).toEqual({
        onboarding_progress: { step: 'brand' },
        onboarding_dismissed: false,
        stage: 'brand_submitted',
        event_count: 2,
        brand_build: 'building',
      });
      expect(mockMcpFetch).toHaveBeenNthCalledWith(1, expect.objectContaining({ path: '/api/users/me/onboarding' }));
      expect(mockMcpFetch).toHaveBeenNthCalledWith(2, expect.objectContaining({ path: '/api/onboarding/events/me' }));
      expect(mockMcpFetch).toHaveBeenNthCalledWith(3, expect.objectContaining({ path: '/api/onboarding/brand-build/status' }));
    });

    it('persists progress and records events without exposing a second auth path', async () => {
      mockMcpFetch.mockResolvedValue({ ok: true });
      await mcpToolRegistry.execute('emma_update_onboarding', { onboarding_progress: { step: 'goal' } }, context);
      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'PATCH', path: '/api/users/me/onboarding',
        body: { onboardingProgress: { step: 'goal' } },
      }));

      jest.clearAllMocks();
      mockMcpFetch.mockResolvedValue({ stage: 'goal_selected' });
      await mcpToolRegistry.execute('emma_record_onboarding_event', { event: 'goal_selected', data: { goal: 'seo' } }, context);
      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST', path: '/api/onboarding/events',
        body: { event: 'goal_selected', data: { goal: 'seo' } },
      }));
    });

    it('starts the existing brand-build flow from MCP', async () => {
      mockMcpFetch.mockResolvedValue({ status: 'building' });
      await mcpToolRegistry.execute('emma_start_brand_build', { company_url: 'https://example.com', goal: 'positioning' }, context);
      expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST', path: '/api/onboarding/brand-build/start',
        body: { companyUrl: 'https://example.com', companyName: undefined, goal: 'positioning' },
      }));
    });
  });

});
