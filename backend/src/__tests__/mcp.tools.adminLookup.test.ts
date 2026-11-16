/**
 * ENG-481: get_session_transcript / get_user_by_id admin MCP tools.
 */
jest.mock('../mcp/server/httpClient', () => ({
  mcpFetch: jest.fn(),
  generateSelfCallToken: jest.fn().mockReturnValue('mock-token'),
  clearUserCache: jest.fn(),
}));

import { mcpToolRegistry } from '../mcp/server/registry';
import { mcpFetch } from '../mcp/server/httpClient';
import { TRANSCRIPT_MESSAGE_CHAR_CAP, TRANSCRIPT_PAGE_SIZE_MAX } from '../mcp/server/adminLookupTools';
import { ADMIN_SKILL_TOOL_NAMES } from '../services/agentModeService';
import { CROSS_ACCOUNT_USER_DATA_TOOLS } from '../services/scheduledReportAccess';

const mockFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;
const context = { userId: 'admin-1', agentUserId: 'admin-1' };
const parse = (r: any) => JSON.parse(r.content[0].text);

describe('ENG-481 admin lookup tools', () => {
  beforeEach(() => jest.clearAllMocks());

  it('are registered and gated as admin-only, cross-account tools', () => {
    for (const name of ['get_session_transcript', 'get_user_by_id']) {
      expect(mcpToolRegistry.getTool(name)).toBeDefined();
      expect(ADMIN_SKILL_TOOL_NAMES).toContain(name);
      expect(CROSS_ACCOUNT_USER_DATA_TOOLS).toContain(name);
    }
  });

  describe('get_session_transcript', () => {
    it('fetches the admin session route and returns message-level transcript', async () => {
      mockFetch.mockResolvedValue({
        sessions: [{
          sessionId: 's/1', userId: 'u1', createdAt: 'c', updatedAt: 'u',
          messages: [
            { role: 'user', content: 'hello', timestamp: 't1' },
            { role: 'assistant', content: [{ type: 'text', text: 'hi' }], llm: 'claude-x' },
          ],
        }],
      });
      const out = parse(await mcpToolRegistry.execute('get_session_transcript', { session_id: ' s/1 ' }, context));
      expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'GET', path: '/api/admin/chat-sessions?sessionId=s%2F1',
      }));
      expect(out).toMatchObject({ found: true, userId: 'u1', messageCount: 2 });
      expect(out.messages[0]).toMatchObject({ role: 'user', content: 'hello', timestamp: 't1' });
      expect(out.messages[1]).toMatchObject({ role: 'assistant', content: 'hi', model: 'claude-x' });
    });

    it('bounds the total payload with offset pagination', async () => {
      const n = TRANSCRIPT_PAGE_SIZE_MAX + 5;
      const msgs = Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i}` }));
      mockFetch.mockResolvedValue({ sessions: [{ sessionId: 's', messages: msgs }] });
      const p1 = parse(await mcpToolRegistry.execute('get_session_transcript', { session_id: 's', limit: 1000 }, context));
      expect(p1).toMatchObject({ messageCount: n, returned: TRANSCRIPT_PAGE_SIZE_MAX, hasMore: true, nextOffset: TRANSCRIPT_PAGE_SIZE_MAX });
      const p2 = parse(await mcpToolRegistry.execute('get_session_transcript', { session_id: 's', offset: p1.nextOffset }, context));
      expect(p2).toMatchObject({ returned: 5, hasMore: false });
      expect(p2.nextOffset).toBeUndefined();
      expect(p2.messages[0].content).toBe(`m${TRANSCRIPT_PAGE_SIZE_MAX}`);
    });

    it('truncates oversized messages and flags them', async () => {
      const big = 'x'.repeat(TRANSCRIPT_MESSAGE_CHAR_CAP + 10);
      mockFetch.mockResolvedValue({ sessions: [{ sessionId: 's', messages: [{ role: 'user', content: big }] }] });
      const out = parse(await mcpToolRegistry.execute('get_session_transcript', { session_id: 's' }, context));
      expect(out.messages[0].content).toHaveLength(TRANSCRIPT_MESSAGE_CHAR_CAP);
      expect(out.messages[0]).toMatchObject({ truncated: true, originalLength: big.length });
    });

    it('returns found=false for unknown sessions and rejects a missing id without fetching', async () => {
      mockFetch.mockResolvedValue({ sessions: [] });
      expect(parse(await mcpToolRegistry.execute('get_session_transcript', { session_id: 'nope' }, context)))
        .toEqual({ sessionId: 'nope', found: false });
      mockFetch.mockClear();
      expect(parse(await mcpToolRegistry.execute('get_session_transcript', {}, context)).error).toMatch(/required/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('propagates the server-side admin denial for non-admin callers', async () => {
      mockFetch.mockRejectedValue(new Error('API error (403): Admin access required'));
      await expect(mcpToolRegistry.execute('get_session_transcript', { session_id: 's' }, { userId: 'cust', agentUserId: 'cust' }))
        .rejects.toThrow(/403/);
    });
  });

  describe('get_user_by_id', () => {
    it('resolves a userId to profile fields and never returns secrets', async () => {
      mockFetch.mockResolvedValue({
        userId: 'u1', email: 'a@b.com', displayName: 'A', isAdmin: false,
        createdAt: 'c', lastLogin: 'l', secretNames: ['OPENAI_KEY'], secrets: { OPENAI_KEY: 'enc' },
      });
      const out = parse(await mcpToolRegistry.execute('get_user_by_id', { user_id: 'u1' }, context));
      expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/api/admin/users/u1' }));
      expect(out).toMatchObject({ found: true, userId: 'u1', email: 'a@b.com', displayName: 'A', isActive: true });
      expect(JSON.stringify(out)).not.toMatch(/secret|OPENAI_KEY|enc/i);
    });

    it('maps a 404 to found=false', async () => {
      mockFetch.mockRejectedValue(new Error('API error (404): User not found'));
      expect(parse(await mcpToolRegistry.execute('get_user_by_id', { user_id: 'x' }, context)))
        .toEqual({ userId: 'x', found: false });
    });

    it('propagates the server-side admin denial (403) instead of masking it as not-found', async () => {
      mockFetch.mockRejectedValue(new Error('API error (403): Admin access required'));
      await expect(mcpToolRegistry.execute('get_user_by_id', { user_id: 'u1' }, { userId: 'cust', agentUserId: 'cust' }))
        .rejects.toThrow(/403/);
    });
  });

  describe('inspect_client_usage (ENG-2771)', () => {
    it('is registered and gated as an admin-only, cross-account tool', () => {
      expect(mcpToolRegistry.getTool('inspect_client_usage')).toBeDefined();
      expect(ADMIN_SKILL_TOOL_NAMES).toContain('inspect_client_usage');
      expect(CROSS_ACCOUNT_USER_DATA_TOOLS).toContain('inspect_client_usage');
    });

    it('reads the admin enforcement route by email with GET only', async () => {
      mockFetch.mockResolvedValue({ billingUserId: 'o1', enforcement: { available: true, paused: true, gatedBy: 'cost' } });
      const out = parse(await mcpToolRegistry.execute('inspect_client_usage', { email: ' a@b.com ' }, context));
      expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/api/admin/usage/enforcement?email=a%40b.com' }));
      expect(out).toMatchObject({ found: true, internalAdminOnly: true, billingUserId: 'o1', enforcement: { paused: true } });
    });

    it('requires an identifier and maps 404 to found=false', async () => {
      expect(parse(await mcpToolRegistry.execute('inspect_client_usage', {}, context))).toEqual({ error: 'email or user_id is required.' });
      mockFetch.mockRejectedValue(new Error('API error (404): User not found'));
      expect(parse(await mcpToolRegistry.execute('inspect_client_usage', { user_id: 'x' }, context))).toEqual({ found: false, userId: 'x' });
    });

    it('propagates the server-side admin denial (403) for a non-admin caller', async () => {
      mockFetch.mockRejectedValue(new Error('API error (403): Admin access required'));
      await expect(mcpToolRegistry.execute('inspect_client_usage', { user_id: 'u1' }, { userId: 'cust', agentUserId: 'cust' }))
        .rejects.toThrow(/403/);
    });
  });
});
