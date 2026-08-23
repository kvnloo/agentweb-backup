/**
 * ENG-1472 — recommend_predefined_work_plan Emma tool + AgentModeService.recommendPredefinedWorkPlan.
 *
 * Mirrors the mocking style of agentModeService.applyWorkPlan.test.ts: a real
 * AgentModeService instance with its heavy dependencies (chatbotDb, workPlanService)
 * mocked, so the actual access-resolution + dedupe + boundary-validation logic runs
 * for real. A separate thin "tool wiring" block proves the registered Emma tool
 * delegates to this exact service method with correctly-parsed arguments — it does
 * NOT re-verify the business logic already covered by the direct service-level tests.
 */
import { AgentModeService, agentModeService } from '../services/agentModeService';
import { chatbotDb } from '../services/chatbotService';
import { workPlanService } from '../services/workPlanService';

jest.mock('aws-sdk');
jest.mock('../services/db', () => ({
  getSession: jest.fn(),
  saveMessage: jest.fn(),
  updateSession: jest.fn(),
  getTask: jest.fn(),
  getTaskExecution: jest.fn(),
  getUserById: jest.fn(),
  userDb: { getUserById: jest.fn().mockResolvedValue(null) },
  taskTemplateDb: { listTemplates: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/chatbotService');
jest.mock('../services/settingsService');
jest.mock('../utils/secretsManager');
jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    getWorkPlansByVisibility: jest.fn().mockResolvedValue([]),
    getWorkPlansByOwner: jest.fn().mockResolvedValue([]),
    getWorkPlansByOrg: jest.fn().mockResolvedValue([]),
    getPublicPlansForAgentMode: jest.fn().mockResolvedValue([]),
  },
}));

const mockWorkPlanService = workPlanService as jest.Mocked<typeof workPlanService>;

const systemPlan: any = {
  planId: 'plan-onboard',
  title: 'Client Onboarding',
  description: 'Get a new client set up in five steps.',
  visibility: 'system',
  isBuiltIn: true,
  steps: [
    { stepCount: 1, title: 'Analyze website' },
    { stepCount: 2, title: 'Update brand guidelines' },
    { stepCount: 3, title: 'Draft the first campaign' },
    { stepCount: 4, title: 'Review with the client' },
    { stepCount: 5, title: 'Launch' },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const privatePlanOwnedByOther: any = {
  ...systemPlan,
  planId: 'plan-private-other',
  visibility: 'private',
  ownerId: 'someone-else',
};

describe('AgentModeService.recommendPredefinedWorkPlan', () => {
  let service: AgentModeService;
  const sessionId = 'sess-reco-1';

  beforeEach(() => {
    service = new AgentModeService();
    jest.clearAllMocks();
    mockWorkPlanService.getWorkPlansByVisibility.mockResolvedValue([]);
    mockWorkPlanService.getWorkPlansByOwner.mockResolvedValue([]);
    mockWorkPlanService.getWorkPlansByOrg.mockResolvedValue([]);
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({ sessionId, userId: 'user-1', messages: [] });
  });

  it('returns a structured recommendation built ONLY from server-resolved plan data', async () => {
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
      v === 'system' ? [systemPlan] : []
    );

    const result = await service.recommendPredefinedWorkPlan(
      'plan-onboard',
      'The user just said they want to onboard a new client.',
      sessionId,
      'user-1',
    );

    expect(result.success).toBe(true);
    expect(result.type).toBe('workplan_recommendation');
    expect(result.version).toBe(1);
    expect(typeof result.recommendationId).toBe('string');
    expect(result.recommendationId.length).toBeGreaterThan(0);
    expect(result.plan).toEqual({
      id: 'plan-onboard',
      title: 'Client Onboarding',
      summary: 'Get a new client set up in five steps.',
      // Clamped to the first 4 steps even though the plan has 5.
      steps: [
        { position: 1, label: 'Analyze website' },
        { position: 2, label: 'Update brand guidelines' },
        { position: 3, label: 'Draft the first campaign' },
        { position: 4, label: 'Review with the client' },
      ],
    });
    expect(result.reason).toBe('The user just said they want to onboard a new client.');
  });

  it('includes a thumbnail when the resolved plan has a valid thumbnail_url', async () => {
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
      v === 'system' ? [{ ...systemPlan, thumbnail_url: 'https://cdn.example.com/x.png', thumbnail_alt_text: 'An icon' }] : []
    );

    const result = await service.recommendPredefinedWorkPlan(
      'plan-onboard',
      'reason',
      sessionId,
      'user-1',
    );

    expect(result.plan.thumbnail).toEqual({ url: 'https://cdn.example.com/x.png', alt: 'An icon' });
  });

  it('omits thumbnail entirely when the resolved plan has no thumbnail_url', async () => {
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
      v === 'system' ? [systemPlan] : []
    );

    const result = await service.recommendPredefinedWorkPlan(
      'plan-onboard',
      'reason',
      sessionId,
      'user-1',
    );

    expect(result.plan).not.toHaveProperty('thumbnail');
  });

  it('produces a deterministic recommendationId from sessionId+planId, distinct across sessions', async () => {
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
      v === 'system' ? [systemPlan] : []
    );

    // Same session + same plan, no persisted history yet either time -> identical hash.
    const first = await service.recommendPredefinedWorkPlan('plan-onboard', 'reason A', sessionId, 'user-1');
    const again = await service.recommendPredefinedWorkPlan('plan-onboard', 'reason A', sessionId, 'user-1');
    expect(again.recommendationId).toBe(first.recommendationId);

    // Different session -> different (still deterministic) hash.
    const otherSession = await service.recommendPredefinedWorkPlan('plan-onboard', 'reason A', 'sess-reco-2', 'user-1');
    expect(otherSession.recommendationId).not.toBe(first.recommendationId);
  });

  it('rejects a planId belonging to a private plan owned by a different user (private cross-user rejection)', async () => {
    mockWorkPlanService.getWorkPlansByOwner.mockImplementation(async (ownerId: string) =>
      ownerId === 'someone-else' ? [privatePlanOwnedByOther] : []
    );

    const result = await service.recommendPredefinedWorkPlan(
      'plan-private-other',
      'Trying to recommend a plan I should not see.',
      sessionId,
      'user-1',
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not available/i);
    expect(result.type).toBeUndefined();
  });

  it('rejects a deleted/nonexistent planId', async () => {
    const result = await service.recommendPredefinedWorkPlan(
      'plan-does-not-exist',
      'reason',
      sessionId,
      'user-1',
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not available/i);
  });

  it('rejects a malformed plan record (steps not an array) the same way as a missing plan', async () => {
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
      v === 'system' ? [{ ...systemPlan, planId: 'plan-malformed', steps: 'nope' }] : []
    );

    const result = await service.recommendPredefinedWorkPlan(
      'plan-malformed',
      'reason',
      sessionId,
      'user-1',
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not available/i);
  });

  it('rejects an empty/whitespace-only planId with a structured, non-sensitive error', async () => {
    const result = await service.recommendPredefinedWorkPlan('   ', 'reason', sessionId, 'user-1');
    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
    expect(mockWorkPlanService.getWorkPlansByVisibility).not.toHaveBeenCalled();
  });

  it('rejects a reason longer than 240 characters', async () => {
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
      v === 'system' ? [systemPlan] : []
    );
    const result = await service.recommendPredefinedWorkPlan('plan-onboard', 'x'.repeat(241), sessionId, 'user-1');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/240/);
  });

  it('rejects an empty reason', async () => {
    const result = await service.recommendPredefinedWorkPlan('plan-onboard', '', sessionId, 'user-1');
    expect(result.success).toBe(false);
  });

  it('returns the SAME persisted proposal on a duplicate call for the same plan in the same session (duplicate proposal)', async () => {
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
      v === 'system' ? [systemPlan] : []
    );

    const first = await service.recommendPredefinedWorkPlan('plan-onboard', 'first reason', sessionId, 'user-1');

    // Simulate the first recommendation now being persisted in session history —
    // exactly the shape extractMinimalToolResult stores on message.metadata.toolCalls.
    (chatbotDb.getChatSession as jest.Mock).mockResolvedValue({
      sessionId,
      userId: 'user-1',
      messages: [
        {
          role: 'assistant',
          metadata: {
            timestamp: '2026-01-01T00:00:00.000Z',
            toolCalls: [{ id: 'tc-1', name: 'recommend_predefined_work_plan', arguments: {}, result: first }],
          },
        },
      ],
    });

    const second = await service.recommendPredefinedWorkPlan('plan-onboard', 'a completely different reason', sessionId, 'user-1');

    expect(second.recommendationId).toBe(first.recommendationId);
    // The stored reason wins — a duplicate call never overwrites the original proposal.
    expect(second.reason).toBe('first reason');
  });

  it('stamps source:"completion_next" only when explicitly requested', async () => {
    mockWorkPlanService.getWorkPlansByVisibility.mockImplementation(async (v: any) =>
      v === 'system' ? [systemPlan] : []
    );

    const ordinary = await service.recommendPredefinedWorkPlan('plan-onboard', 'reason', sessionId, 'user-1');
    expect(ordinary.source).toBeUndefined();

    const completion = await service.recommendPredefinedWorkPlan(
      'plan-onboard', 'reason', 'sess-reco-3', 'user-1', { source: 'completion_next' },
    );
    expect(completion.source).toBe('completion_next');
  });
});

describe('recommend_predefined_work_plan Emma tool wiring', () => {
  const toolName = 'recommend_predefined_work_plan';

  it('is registered in emmaToolRegistry and exposes only planId + reason', () => {
    // Imported lazily so the earlier describe block's jest.mock('../services/chatbotService')
    // etc. do not interfere with module resolution order.
    const { emmaToolRegistry } = require('../emma/registry');
    require('../emma/tools');

    const tool = emmaToolRegistry.getTool(toolName);
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe(toolName);

    const schema = tool?.definition.inputSchema;
    expect(schema.required).toEqual(expect.arrayContaining(['planId', 'reason']));
    expect(Object.keys(schema.properties).sort()).toEqual(['planId', 'reason']);
  });

  it('delegates to agentModeService.recommendPredefinedWorkPlan with parsed args + context', async () => {
    const { emmaToolRegistry } = require('../emma/registry');
    require('../emma/tools');
    const tool = emmaToolRegistry.getTool(toolName);
    if (!tool) throw new Error(`Tool ${toolName} not found`);

    const spy = jest.spyOn(agentModeService, 'recommendPredefinedWorkPlan').mockResolvedValue({ success: true, type: 'workplan_recommendation' });

    const context = { sessionId: 'sess-x', userId: 'user-x' };
    await tool.execute({ planId: 'plan-onboard', reason: 'because X' }, context);

    expect(spy).toHaveBeenCalledWith('plan-onboard', 'because X', 'sess-x', 'user-x');
    spy.mockRestore();
  });
});
