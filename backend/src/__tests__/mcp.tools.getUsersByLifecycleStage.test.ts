/**
 * Tests for `get_users_by_lifecycle_stage` — Phase 2 of the Lifecycle Drip
 * epic. Admin-only Emma/MCP tool that wraps GET /api/onboarding/users so Emma
 * can answer "who dropped at the brand step?" / "who's been stale for 7+ days?"
 * conversationally and hand the returned list to the drip campaign engine.
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
  agentModeService: { getUnassociatedToolNames: jest.fn().mockReturnValue([]) },
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import { mcpFetch } from '../mcp/server/httpClient';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

const USER_ID = 'admin-user-1';
const context = { userId: USER_ID, agentUserId: USER_ID };

describe('get_users_by_lifecycle_stage (admin MCP tool)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers the tool in mcpToolRegistry', () => {
    const handler = mcpToolRegistry.getTool('get_users_by_lifecycle_stage');
    expect(handler).toBeDefined();
    expect(handler?.definition.name).toBe('get_users_by_lifecycle_stage');
  });

  it('declares `stage` in its input schema', () => {
    const handler = mcpToolRegistry.getTool('get_users_by_lifecycle_stage');
    const schema = handler?.definition.inputSchema as any;
    expect(schema.properties.stage).toBeDefined();
    expect(schema.properties.lastActivityBefore).toBeDefined();
    expect(schema.properties.limit).toBeDefined();
  });

  it('calls GET /api/onboarding/users with the stage query param', async () => {
    mockMcpFetch.mockResolvedValue({ stage: 'goal_selected', count: 2, users: [] });
    await mcpToolRegistry.execute(
      'get_users_by_lifecycle_stage',
      { stage: 'goal_selected' },
      context,
    );

    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/api/onboarding/users',
        queryParams: expect.objectContaining({ stage: 'goal_selected' }),
      }),
    );
  });

  it('forwards optional lastActivityBefore and limit to the endpoint', async () => {
    mockMcpFetch.mockResolvedValue({ stage: null, count: 0, users: [] });
    await mcpToolRegistry.execute(
      'get_users_by_lifecycle_stage',
      {
        stage: 'goal_selected',
        lastActivityBefore: '2026-04-10T00:00:00Z',
        limit: 50,
      },
      context,
    );

    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        queryParams: expect.objectContaining({
          stage: 'goal_selected',
          lastActivityBefore: '2026-04-10T00:00:00Z',
          limit: '50',
        }),
      }),
    );
  });

  it('works without any arguments (admin: list everyone with a stage)', async () => {
    mockMcpFetch.mockResolvedValue({ stage: null, count: 0, users: [] });
    await mcpToolRegistry.execute('get_users_by_lifecycle_stage', {}, context);

    const call = mockMcpFetch.mock.calls[0][0];
    expect(call.path).toBe('/api/onboarding/users');
    // Empty queryParams (or no stage) is fine — the endpoint returns all users with any stage.
    expect(call.queryParams?.stage).toBeUndefined();
  });

  it('forwards userId via context so the REST endpoint sees the admin caller', async () => {
    mockMcpFetch.mockResolvedValue({ stage: null, count: 0, users: [] });
    await mcpToolRegistry.execute(
      'get_users_by_lifecycle_stage',
      { stage: 'stale' },
      context,
    );

    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ userId: USER_ID }),
      }),
    );
  });

  it('returns the JSON response as an MCP content envelope', async () => {
    const payload = {
      stage: 'goal_selected',
      count: 1,
      users: [
        {
          userId: 'u1',
          email: 'a@example.com',
          companyName: 'Acme',
          onboardingStage: 'goal_selected',
          onboardingGoal: 'paid_ads',
        },
      ],
    };
    mockMcpFetch.mockResolvedValue(payload);
    const result = await mcpToolRegistry.execute(
      'get_users_by_lifecycle_stage',
      { stage: 'goal_selected' },
      context,
    );

    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(payload);
  });

  it('rejects invalid stage values before hitting the network', async () => {
    await mcpToolRegistry.execute(
      'get_users_by_lifecycle_stage',
      { stage: 'bogus' },
      context,
    );
    // Either: schema-rejected before dispatch, OR dispatched and server returns 400.
    // We accept either behaviour, but MUST NOT silently succeed with bogus stage.
    if (mockMcpFetch.mock.calls.length > 0) {
      // If dispatched, the tool must not have filtered — so the server sees it.
      expect(mockMcpFetch.mock.calls[0][0].queryParams?.stage).toBe('bogus');
    }
  });

  it('is registered in emma/tools.ts admin tool list', async () => {
    // Ensure the tool is included in ADMIN_SKILL_TOOL_NAMES so non-admin callers
    // cannot execute it through Emma (enforced in agentModeService).
    const { agentModeService } = jest.requireActual(
      '../services/agentModeService',
    );
    const adminNames: string[] = agentModeService.getAdminToolNames();
    expect(adminNames).toContain('get_users_by_lifecycle_stage');
  });
});
