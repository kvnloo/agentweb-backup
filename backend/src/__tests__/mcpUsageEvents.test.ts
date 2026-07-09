import type { DynamoAttributeMap } from '../loops/core/ports';
import {
  EMMA_MCP_LOOP_ID,
  buildMcpUsageReport,
  classifyMcpClient,
  recordMcpConnectionAttempt,
  recordMcpFirstToolUse,
  recordMcpToolUse,
  recordMcpOAuthAuthorized,
  recordMcpOAuthStarted,
  recordMcpOAuthTokenIssued,
} from '../services/mcpUsageEventsService';

function fakeStore(seed: DynamoAttributeMap[] = []) {
  const items = new Map<string, DynamoAttributeMap>();
  for (const item of seed) {
    items.set(`${item.loopId}#${item.tsSession}`, item);
  }

  return {
    items,
    put: jest.fn(async (item: DynamoAttributeMap, options?: { condition?: 'attribute_not_exists' }) => {
      const key = `${item.loopId}#${item.tsSession}`;
      if (options?.condition === 'attribute_not_exists' && items.has(key)) {
        const err: any = new Error('conditional failed');
        err.code = 'ConditionalCheckFailedException';
        throw err;
      }
      items.set(key, item);
    }),
    queryByLoopId: jest.fn(async (loopId: string) => [...items.values()].filter((item) => item.loopId === loopId)),
  };
}

describe('mcpUsageEventsService', () => {
  const now = new Date('2026-07-09T20:00:00Z');

  it('records OAuth funnel events without storing secrets', async () => {
    const store = fakeStore();

    await recordMcpOAuthStarted(
      {
        clientId: 'client-1',
        clientName: 'Claude Code',
        redirectUri: 'http://127.0.0.1:49152/callback',
        scope: 'mcp:tools',
        userAgent: 'ClaudeCode/1.0',
        now,
      },
      store,
    );
    await recordMcpOAuthAuthorized(
      {
        userId: 'user-1',
        clientId: 'client-1',
        clientName: 'Claude Code',
        redirectUri: 'http://127.0.0.1:49152/callback',
        scope: 'mcp:tools',
        now: new Date('2026-07-09T20:01:00Z'),
      },
      store,
    );
    await recordMcpOAuthTokenIssued(
      {
        userId: 'user-1',
        clientId: 'client-1',
        clientName: 'Claude Code',
        redirectUri: 'http://127.0.0.1:49152/callback',
        scope: 'mcp:tools',
        now: new Date('2026-07-09T20:02:00Z'),
      },
      store,
    );

    expect(store.put).toHaveBeenCalledTimes(3);
    const rows = [...store.items.values()] as any[];
    expect(rows.map((row) => row.eventType)).toEqual([
      'mcp_oauth_started',
      'mcp_oauth_authorized',
      'mcp_oauth_token_issued',
    ]);
    expect(rows[0].subjectId).toBe('client:client-1');
    expect(rows[1].subjectId).toBe('user-1');
    expect(JSON.stringify(rows)).not.toContain('access-token');
    expect(JSON.stringify(rows)).not.toContain('refresh-token');
  });

  it('records external MCP connection attempts with non-secret auth dimensions', async () => {
    const store = fakeStore();

    await recordMcpConnectionAttempt(
      {
        userId: 'user-1',
        authMethod: 'api_key',
        apiKeyId: 'key-1',
        sessionId: 'session-1',
        userAgent: 'ClaudeCode/1.0',
        requestId: 'req-1',
        now,
      },
      store,
    );

    expect(store.put).toHaveBeenCalledTimes(1);
    const item = [...store.items.values()][0] as any;
    expect(item.loopId).toBe(EMMA_MCP_LOOP_ID);
    expect(item.eventType).toBe('mcp_connection_attempted');
    expect(item.subjectId).toBe('user-1');
    expect(item.dimensions).toEqual({
      authMethod: 'api_key',
      apiKeyId: 'key-1',
      clientType: 'claude_code',
      sessionId: 'session-1',
      userAgent: 'ClaudeCode/1.0',
      requestId: 'req-1',
    });
    expect(JSON.stringify(item)).not.toContain('aw_');
  });

  it('records all successful tool uses while first-use remains once per user', async () => {
    const store = fakeStore();

    await recordMcpToolUse(
      {
        userId: 'user-1',
        toolName: 'install_skills',
        authMethod: 'oauth',
        clientId: 'client-1',
        clientName: 'Claude Code',
        sessionId: 'session-1',
        now,
      },
      store,
    );
    await recordMcpToolUse(
      {
        userId: 'user-1',
        toolName: 'create_gtm_plan',
        authMethod: 'oauth',
        clientId: 'client-1',
        clientName: 'Claude Code',
        sessionId: 'session-1',
        now: new Date('2026-07-09T20:04:00Z'),
      },
      store,
    );
    const first = await recordMcpFirstToolUse(
      {
        userId: 'user-1',
        toolName: 'install_skills',
        authMethod: 'oauth',
        clientId: 'client-1',
        clientName: 'Claude Code',
        sessionId: 'session-1',
        now,
      },
      store,
    );
    const duplicate = await recordMcpFirstToolUse(
      {
        userId: 'user-1',
        toolName: 'create_gtm_plan',
        authMethod: 'oauth',
        clientId: 'client-1',
        clientName: 'Claude Code',
        sessionId: 'session-2',
        now: new Date('2026-07-09T20:05:00Z'),
      },
      store,
    );

    expect(first).toBe(true);
    expect(duplicate).toBe(false);
    expect(store.put).toHaveBeenCalledTimes(4);
    const rows = [...store.items.values()] as any[];
    expect(rows.filter((row) => row.eventType === 'mcp_tool_used')).toHaveLength(2);
    const firstUseRows = rows.filter((row) => row.eventType === 'mcp_first_tool_used');
    expect(firstUseRows).toHaveLength(1);
    expect(firstUseRows[0].tsSession).toBe('first_use#user-1');
    expect(firstUseRows[0].dimensions.toolName).toBe('install_skills');
  });

  it('builds a GTM-readable report with counts and per-user first-use state', async () => {
    const store = fakeStore([
      {
        loopId: EMMA_MCP_LOOP_ID,
        tsSession: '2026-07-09T19:58:00.000Z#client-1#mcp_oauth_started#req-0',
        eventType: 'mcp_oauth_started',
        subjectId: 'client:client-1',
        ts: '2026-07-09T19:58:00.000Z',
        dimensions: { clientId: 'client-1', clientName: 'Claude Code', clientType: 'claude_code' },
      },
      {
        loopId: EMMA_MCP_LOOP_ID,
        tsSession: 'mcp_oauth_authorized#user-1#client-1',
        eventType: 'mcp_oauth_authorized',
        subjectId: 'user-1',
        ts: '2026-07-09T19:59:00.000Z',
        dimensions: { authMethod: 'oauth', clientId: 'client-1', clientName: 'Claude Code', clientType: 'claude_code' },
      },
      {
        loopId: EMMA_MCP_LOOP_ID,
        tsSession: 'mcp_oauth_token_issued#user-1#client-1',
        eventType: 'mcp_oauth_token_issued',
        subjectId: 'user-1',
        ts: '2026-07-09T19:59:30.000Z',
        dimensions: { authMethod: 'oauth', clientId: 'client-1', clientName: 'Claude Code', clientType: 'claude_code' },
      },
      {
        loopId: EMMA_MCP_LOOP_ID,
        tsSession: '2026-07-09T20:00:00.000Z#user-1#mcp_connection_attempted#req-1',
        eventType: 'mcp_connection_attempted',
        subjectId: 'user-1',
        ts: '2026-07-09T20:00:00.000Z',
        dimensions: { authMethod: 'api_key', apiKeyId: 'key-1', userAgent: 'ClaudeCode/1.0' },
      },
      {
        loopId: EMMA_MCP_LOOP_ID,
        tsSession: '2026-07-09T20:10:00.000Z#user-1#mcp_connection_attempted#req-2',
        eventType: 'mcp_connection_attempted',
        subjectId: 'user-1',
        ts: '2026-07-09T20:10:00.000Z',
        dimensions: { authMethod: 'api_key', apiKeyId: 'key-1', userAgent: 'ClaudeCode/1.0' },
      },
      {
        loopId: EMMA_MCP_LOOP_ID,
        tsSession: '2026-07-09T20:10:30.000Z#user-1#mcp_tool_used#call-1',
        eventType: 'mcp_tool_used',
        subjectId: 'user-1',
        ts: '2026-07-09T20:10:30.000Z',
        dimensions: { authMethod: 'api_key', toolName: 'install_skills', userAgent: 'ClaudeCode/1.0' },
      },
      {
        loopId: EMMA_MCP_LOOP_ID,
        tsSession: '2026-07-09T20:12:00.000Z#user-1#mcp_tool_used#call-2',
        eventType: 'mcp_tool_used',
        subjectId: 'user-1',
        ts: '2026-07-09T20:12:00.000Z',
        dimensions: { authMethod: 'api_key', toolName: 'create_gtm_plan', userAgent: 'ClaudeCode/1.0' },
      },
      {
        loopId: EMMA_MCP_LOOP_ID,
        tsSession: 'first_use#user-1',
        eventType: 'mcp_first_tool_used',
        subjectId: 'user-1',
        ts: '2026-07-09T20:11:00.000Z',
        dimensions: { authMethod: 'api_key', toolName: 'install_skills', userAgent: 'ClaudeCode/1.0' },
      },
      {
        loopId: EMMA_MCP_LOOP_ID,
        tsSession: '2026-07-10T20:00:00.000Z#user-2#mcp_connection_attempted#req-3',
        eventType: 'mcp_connection_attempted',
        subjectId: 'user-2',
        ts: '2026-07-10T20:00:00.000Z',
        dimensions: { authMethod: 'oauth', clientId: 'client-2' },
      },
    ]);

    const report = await buildMcpUsageReport(
      { start: '2026-07-09', end: '2026-07-09' },
      store,
      async (userIds) => new Map(userIds.map((userId) => [userId, { email: `${userId}@example.com`, companyName: 'Acme' }])),
    );

    expect(report.summary).toEqual({
      oauthStarts: 1,
      authorizedUsers: 1,
      tokenIssuedUsers: 1,
      connectionAttempts: 2,
      connectedUsers: 1,
      toolCalls: 2,
      firstUseUsers: 1,
      firstUseRate: 1,
    });
    expect(report.clients).toEqual([
      {
        clientType: 'claude_code',
        oauthStarts: 1,
        authorizedUsers: 1,
        tokenIssuedUsers: 1,
        connectionAttempts: 2,
        connectedUsers: 1,
        toolCalls: 2,
        firstUseUsers: 1,
        clientNames: ['Claude Code'],
      },
    ]);
    expect(report.users).toEqual([
      {
        userId: 'user-1',
        email: 'user-1@example.com',
        companyName: 'Acme',
        oauthAuthorizedAt: '2026-07-09T19:59:00.000Z',
        tokenIssuedAt: '2026-07-09T19:59:30.000Z',
        connectionAttempts: 2,
        firstConnectedAt: '2026-07-09T20:00:00.000Z',
        lastConnectedAt: '2026-07-09T20:10:00.000Z',
        toolCalls: 2,
        lastUsedAt: '2026-07-09T20:12:00.000Z',
        lastToolName: 'create_gtm_plan',
        firstUsedAt: '2026-07-09T20:11:00.000Z',
        firstToolName: 'install_skills',
        authMethods: ['api_key', 'oauth'],
        apiKeyIds: ['key-1'],
        clientIds: ['client-1'],
        clientNames: ['Claude Code'],
        clientTypes: ['claude_code'],
      },
    ]);
  });

  it('returns an empty report when there are no events in the requested range', async () => {
    const store = fakeStore();

    const report = await buildMcpUsageReport({ start: '2026-07-09', end: '2026-07-09' }, store);

    expect(report.summary).toEqual({
      oauthStarts: 0,
      authorizedUsers: 0,
      tokenIssuedUsers: 0,
      connectionAttempts: 0,
      connectedUsers: 0,
      toolCalls: 0,
      firstUseUsers: 0,
      firstUseRate: 0,
    });
    expect(report.clients).toEqual([]);
    expect(report.users).toEqual([]);
  });

  it('classifies major MCP client families from client names and user agents', () => {
    expect(classifyMcpClient({ clientName: 'Claude Code' })).toBe('claude_code');
    expect(classifyMcpClient({ clientName: 'Claude.ai custom connector' })).toBe('claude_ai');
    expect(classifyMcpClient({ userAgent: 'OpenAI-Codex/1.0' })).toBe('codex');
    expect(classifyMcpClient({ clientName: 'ChatGPT custom app' })).toBe('chatgpt');
    expect(classifyMcpClient({ clientName: 'Hermes MCP' })).toBe('hermes');
    expect(classifyMcpClient({ clientName: 'OpenClaw' })).toBe('openclaw');
    expect(classifyMcpClient({ authMethod: 'api_key' })).toBe('api_key');
  });
});
