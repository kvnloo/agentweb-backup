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
import { extractRegistrationStatusEmails } from '../mcp/server/apiTools';

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
        body: { emails: ['a@x.com', 'b@x.com'], includeChatSessionCount: false },
      }),
    );
  });

  it('passes include_chat_session_count through to the request body', async () => {
    mockMcpFetch.mockResolvedValue({ statuses: [], summary: { total: 0, registered: 0, premium: 0 } });
    await mcpToolRegistry.execute(
      'get_registration_status',
      { emails: ['a@x.com'], include_chat_session_count: true },
      context,
    );
    const body = (mockMcpFetch.mock.calls[0][0] as any).body;
    expect(body).toEqual({ emails: ['a@x.com'], includeChatSessionCount: true });
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

  // ENG-3189: the model sent strings / empty lists and the route 400'd.
  describe('input coercion (ENG-3189)', () => {
    beforeEach(() => {
      mockMcpFetch.mockResolvedValue({ statuses: [], summary: { total: 0, registered: 0, premium: 0 } });
    });

    it.each([
      ['comma-separated string', 'a@x.com, b@x.com'],
      ['JSON-encoded array string', '["a@x.com","b@x.com"]'],
      ['newline/semicolon separated string', 'a@x.com;\nb@x.com'],
    ])('accepts a %s', async (_label, raw) => {
      await mcpToolRegistry.execute('get_registration_status', { emails: raw }, context);
      expect(mockMcpFetch).toHaveBeenCalledWith(
        expect.objectContaining({ body: { emails: ['a@x.com', 'b@x.com'], includeChatSessionCount: false } }),
      );
    });

    it.each([
      ['display-name contact', 'Jane Doe <a@x.com>, b@x.com'],
      ['quoted list typed as text', '"a@x.com", "b@x.com"'],
      ['object entries', [{ email: 'a@x.com' }, 'b@x.com']],
    ])('extracts only the addresses from a %s', async (_label, raw) => {
      await mcpToolRegistry.execute('get_registration_status', { emails: raw }, context);
      expect(mockMcpFetch).toHaveBeenCalledWith(
        expect.objectContaining({ body: { emails: ['a@x.com', 'b@x.com'], includeChatSessionCount: false } }),
      );
    });

    it('reports entries that held no address instead of dropping them silently', async () => {
      const result: any = await mcpToolRegistry.execute('get_registration_status', { emails: ['a@x.com', { id: 1 }] }, context);
      expect(JSON.parse(result.content[0].text).skipped).toEqual([{ id: 1 }]);
    });

    it.each([
      ['empty array', []],
      ['blank strings only', ['  ', '']],
      ['missing emails', undefined],
    ])('turns the route 400 into an actionable error for %s', async (_label, raw) => {
      mockMcpFetch.mockRejectedValue(new Error('API error (400): Invalid body. Required: emails (non-empty array of strings)'));
      const result: any = await mcpToolRegistry.execute('get_registration_status', { emails: raw }, context);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('needs at least one email');
    });

    it('lets the admin 403 through for a non-admin with an empty list', async () => {
      mockMcpFetch.mockRejectedValue(new Error('API error (403): Admin access required'));
      await expect(mcpToolRegistry.execute('get_registration_status', { emails: [] }, context)).rejects.toThrow('403');
    });
  });

  it('keeps full addresses with RFC 5322 atext characters (no suffix match)', () => {
    expect(extractRegistrationStatusEmails(['a!b@example.com', 'x=y/z@acme.io']).emails).toEqual([
      'a!b@example.com',
      'x=y/z@acme.io',
    ]);
  });
});
