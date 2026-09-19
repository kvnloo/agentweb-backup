/**
 * ENG-2057 — work-plan lifecycle over the external MCP registry.
 *
 * MOCKABLE contract test: the REST boundary is mocked, while the real registry
 * handlers prove list -> launch -> poll -> answer routing and payload shapes.
 */
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
}));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    installSkills: jest.fn(),
    getUnassociatedToolNames: jest.fn().mockReturnValue([]),
  },
}));

import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const context = { userId: 'user-123', agentUserId: 'user-123', externalMcp: true };
const parsed = (result: any) => JSON.parse(result.content[0].text);

describe('ENG-2057 MCP work-plan lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('round-trips list -> launch -> poll -> answer through the registry', async () => {
    mockMcpFetch
      .mockResolvedValueOnce([{ id: 'plan-1', title: 'Launch Plan', display: { steps: [] } }])
      .mockResolvedValueOnce({ success: true, workPlan: { templatePlanId: 'plan-1', title: 'Launch Plan' } })
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        workPlan: { templatePlanId: 'plan-1', title: 'Launch Plan' },
        pendingWorkPlanInput: {
          requestId: 'request-1',
          status: 'awaiting',
          fields: [{ id: 'audience', label: 'Audience', type: 'text', required: true }],
        },
      })
      .mockResolvedValueOnce({ success: true, response: 'Continuing the plan.' });

    const listed = parsed(await mcpToolRegistry.execute('list_predefined_work_plans', {}, context));
    expect(listed[0].id).toBe('plan-1');

    await mcpToolRegistry.execute('emma_launch_work_plan', {
      session_id: 'session-1',
      work_plan_id: listed[0].id,
    }, context);
    expect(mockMcpFetch).toHaveBeenNthCalledWith(2, {
      method: 'POST',
      path: '/api/agent-mode/session/session-1/work-plan',
      context: { userId: 'user-123', agentUserId: 'user-123' },
      body: { planId: 'plan-1' },
    });

    const status = parsed(await mcpToolRegistry.execute('emma_get_session', { session_id: 'session-1' }, context));
    expect(status.pendingWorkPlanInput).toEqual(expect.objectContaining({ requestId: 'request-1', status: 'awaiting' }));

    await mcpToolRegistry.execute('emma_answer_work_plan_input', {
      session_id: 'session-1',
      work_plan_request_id: status.pendingWorkPlanInput.requestId,
      values: { audience: 'Founders' },
    }, context);
    expect(mockMcpFetch).toHaveBeenNthCalledWith(4, {
      method: 'POST',
      path: '/api/agent-mode/generate',
      context: { userId: 'user-123', agentUserId: 'user-123' },
      body: {
        sessionId: 'session-1',
        userMessage: 'Submitted requested work plan details.',
        workPlanInputAnswer: { requestId: 'request-1', values: { audience: 'Founders' } },
      },
    });
  });

  it('lists both lifecycle tools externally and account-gates launch', () => {
    const externalNames = mcpToolRegistry.getToolDefinitions().map((definition: any) => definition.name);
    expect(externalNames).toEqual(expect.arrayContaining([
      'emma_launch_work_plan',
      'emma_answer_work_plan_input',
    ]));
    expect(mcpToolRegistry.getTool('emma_launch_work_plan')?.requiresUserAccount).toBe(true);
  });
});
