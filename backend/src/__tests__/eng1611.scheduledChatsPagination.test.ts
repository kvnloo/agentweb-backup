/**
 * ENG-1611 acceptance: list_scheduled_chats is bounded for large (admin
 * client_id-scoped) accounts, while the portal's unpaged response is unchanged.
 */
jest.mock('../mcp/server/httpClient', () => ({ mcpFetch: jest.fn() }));
jest.mock('../services/skillService', () => ({ skillService: {} }));
jest.mock('../services/subscriptionService', () => ({}));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));

import { parseScheduledChatsPage, encodeScheduledChatsCursor } from '../utils/scheduledChatsPage';
import { mcpFetch } from '../mcp/server/httpClient';
import { mcpToolRegistry } from '../mcp/server/registry';
import '../mcp/server/apiTools';

const mockMcpFetch = mcpFetch as jest.MockedFunction<typeof mcpFetch>;

describe('parseScheduledChatsPage', () => {
  it('returns null when the caller does not opt in (legacy bare-array response)', () => {
    expect(parseScheduledChatsPage({})).toBeNull();
    expect(parseScheduledChatsPage(undefined)).toBeNull();
  });

  it('clamps limit to [1, 100]', () => {
    expect(parseScheduledChatsPage({ limit: '5000' })).toEqual({ limit: 100, offset: 0 });
    expect(parseScheduledChatsPage({ limit: '0' })).toEqual({ limit: 1, offset: 0 });
    expect(parseScheduledChatsPage({ limit: '20' })).toEqual({ limit: 20, offset: 0 });
  });

  it('round-trips a cursor and defaults limit to 50', () => {
    expect(parseScheduledChatsPage({ cursor: encodeScheduledChatsCursor(150) })).toEqual({ limit: 50, offset: 150 });
  });

  it('rejects malformed input', () => {
    expect(parseScheduledChatsPage({ limit: 'abc' })).toEqual({ error: 'limit must be a number' });
    expect(parseScheduledChatsPage({ cursor: 'not-a-cursor' })).toEqual({ error: 'cursor is invalid' });
    expect(parseScheduledChatsPage({ cursor: encodeScheduledChatsCursor(-1) })).toEqual({ error: 'cursor is invalid' });
    expect(parseScheduledChatsPage({ cursor: ['a', 'b'] })).toEqual({ error: 'cursor is invalid' });
  });
});

describe('list_scheduled_chats MCP tool', () => {
  const context = { userId: 'user-123', agentUserId: 'user-123' };
  beforeEach(() => {
    jest.clearAllMocks();
    mockMcpFetch.mockResolvedValue({ items: [], nextCursor: null });
  });

  it('always requests a bounded page (default 50)', async () => {
    await mcpToolRegistry.getTool('list_scheduled_chats')!.execute({}, context);
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      path: '/api/agent-mode/scheduled-chats',
      queryParams: { limit: '50' },
    }));
  });

  it('caps an oversized limit at 100 and forwards the cursor', async () => {
    await mcpToolRegistry.getTool('list_scheduled_chats')!.execute({ limit: 10000, cursor: 'abc' }, context);
    expect(mockMcpFetch).toHaveBeenCalledWith(expect.objectContaining({
      queryParams: { limit: '100', cursor: 'abc' },
    }));
  });

  it('advertises limit and cursor in its schema', () => {
    const def = mcpToolRegistry.getTool('list_scheduled_chats')!.definition as any;
    expect(Object.keys(def.inputSchema.properties)).toEqual(expect.arrayContaining(['client_id', 'limit', 'cursor']));
  });
});
