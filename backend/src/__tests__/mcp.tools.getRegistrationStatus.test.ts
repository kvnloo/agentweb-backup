/**
 * Tests for `get_registration_status` — the agent-mode tool that joins a batch
 * of (lead) emails against AW-Users so the funnel report can attribute which
 * leads signed up and which became premium. Routes to
 * POST /api/crm/registration-status.
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

const USER_ID = 'tenant-1';
const context = { userId: USER_ID, agentUserId: USER_ID };

describe('get_registration_status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers the tool in mcpToolRegistry', () => {
    const handler = mcpToolRegistry.getTool('get_registration_status');
    expect(handler).toBeDefined();
    expect(handler?.definition.name).toBe('get_registration_status');
  });

  it('is an admin-only tool (account-enumeration over AW-Users)', () => {
    // Must live in ADMIN_SKILL_TOOL_NAMES so non-admin callers cannot execute it
    // through Emma; the route also enforces isAdmin server-side.
    const { agentModeService } = jest.requireActual('../services/agentModeService');
    const adminNames: string[] = agentModeService.getAdminToolNames();
    expect(adminNames).toContain('get_registration_status');
  });

  it('requires an emails array in its schema', () => {
    const handler = mcpToolRegistry.getTool('get_registration_status');
    const schema = handler?.definition.inputSchema as any;
    expect(schema.properties.emails).toBeDefined();
    expect(schema.properties.emails.type).toBe('array');
    expect(schema.required).toContain('emails');
  });

  it('routes to POST /api/crm/registration-status with the emails body', async () => {
    mockMcpFetch.mockResolvedValue({ statuses: [], summary: { total: 0, registered: 0, premium: 0 } });
    await mcpToolRegistry.execute(
      'get_registration_status',
      { emails: ['a@x.com', 'b@x.com'] },
      context,
    );
    expect(mockMcpFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/crm/registration-status',
        body: { emails: ['a@x.com', 'b@x.com'] },
      }),
    );
  });

  it('passes through the structured response verbatim', async () => {
    const payload = {
      statuses: [
        { email: 'paid@x.com', registered: true, isPremium: true, userId: 'u-1', subscriptionStatus: 'active' },
        { email: 'ghost@x.com', registered: false, isPremium: false },
      ],
      summary: { total: 2, registered: 1, premium: 1 },
    };
    mockMcpFetch.mockResolvedValue(payload);

    const result = await mcpToolRegistry.execute(
      'get_registration_status',
      { emails: ['paid@x.com', 'ghost@x.com'] },
      context,
    );

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed).toEqual(payload);
  });

  it('coerces non-string entries out of the emails array before sending', async () => {
    mockMcpFetch.mockResolvedValue({ statuses: [], summary: { total: 0, registered: 0, premium: 0 } });
    await mcpToolRegistry.execute(
      'get_registration_status',
      { emails: ['a@x.com', 123, null, '  b@x.com  '] },
      context,
    );
    const body = (mockMcpFetch.mock.calls[0][0] as any).body;
    expect(body.emails).toEqual(['a@x.com', 'b@x.com']);
  });
});
