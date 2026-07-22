import type { DynamoAttributeMap } from '../loops/core/ports';
import {
  EMMA_MCP_LOOP_ID,
  McpUsageEventStore,
  buildMcpUsageReport,
  recordMcpConnectionAttempt,
  recordMcpFirstToolUse,
  recordMcpOAuthAuthorized,
  recordMcpOAuthStarted,
  recordMcpOAuthTokenIssued,
  recordMcpToolUse,
} from '../services/mcpUsageEventsService';

function fakeStore(): McpUsageEventStore & { items: Map<string, DynamoAttributeMap> } {
  const items = new Map<string, DynamoAttributeMap>();

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

interface McpSetupSimulation {
  name: string;
  persona: string;
  setupPath: 'claude.ai-connector-to-claude-code' | 'raw-codex' | 'openclaw-api-key' | 'hermes-remote-oauth';
  run(store: McpUsageEventStore): Promise<void>;
}

const simulations: McpSetupSimulation[] = [
  {
    name: 'Claude.ai account connector syncs into Claude Code usage',
    persona: 'new founder adds Emma from claude.ai, then calls Emma from Claude Code without knowing AgentWeb internals',
    setupPath: 'claude.ai-connector-to-claude-code',
    async run(store) {
      await recordMcpOAuthStarted(
        {
          clientId: 'claude-ai-client',
          clientName: 'Claude.ai custom connector',
          redirectUri: 'https://claude.ai/settings/connectors/oauth/callback',
          scope: 'mcp:tools',
          userAgent: 'Claude/Connector',
          now: new Date('2026-07-09T20:00:00Z'),
        },
        store,
      );
      await recordMcpOAuthAuthorized(
        {
          userId: 'user-claude',
          clientId: 'claude-ai-client',
          clientName: 'Claude.ai custom connector',
          now: new Date('2026-07-09T20:01:00Z'),
        },
        store,
      );
      await recordMcpOAuthTokenIssued(
        {
          userId: 'user-claude',
          clientId: 'claude-ai-client',
          clientName: 'Claude.ai custom connector',
          now: new Date('2026-07-09T20:02:00Z'),
        },
        store,
      );
      await recordMcpConnectionAttempt(
        {
          userId: 'user-claude',
          authMethod: 'oauth',
          clientId: 'claude-ai-client',
          clientName: 'Claude Code',
          sessionId: 'claude-code-session',
          userAgent: 'ClaudeCode/1.0',
          requestId: 'claude-code-connect',
          now: new Date('2026-07-09T20:03:00Z'),
        },
        store,
      );
      await recordMcpToolUse(
        {
          userId: 'user-claude',
          toolName: 'get_registration_status',
          authMethod: 'oauth',
          clientId: 'claude-ai-client',
          clientName: 'Claude Code',
          sessionId: 'claude-code-session',
          userAgent: 'ClaudeCode/1.0',
          now: new Date('2026-07-09T20:04:00Z'),
        },
        store,
      );
      await recordMcpFirstToolUse(
        {
          userId: 'user-claude',
          toolName: 'get_registration_status',
          authMethod: 'oauth',
          clientId: 'claude-ai-client',
          clientName: 'Claude Code',
          sessionId: 'claude-code-session',
          userAgent: 'ClaudeCode/1.0',
          now: new Date('2026-07-09T20:04:00Z'),
        },
        store,
      );
      await recordMcpToolUse(
        {
          userId: 'user-claude',
          toolName: 'install_skills',
          authMethod: 'oauth',
          clientId: 'claude-ai-client',
          clientName: 'Claude Code',
          sessionId: 'claude-code-session',
          userAgent: 'ClaudeCode/1.0',
          now: new Date('2026-07-09T20:05:00Z'),
        },
        store,
      );
    },
  },
  {
    name: 'Raw Codex install can connect and first-use Emma',
    persona: 'new technical user pastes the Emma MCP URL into a clean Codex config and runs codex mcp login emma',
    setupPath: 'raw-codex',
    async run(store) {
      await recordMcpOAuthStarted(
        {
          clientId: 'codex-client',
          clientName: 'OpenAI Codex',
          redirectUri: 'http://127.0.0.1:1455/oauth/callback',
          scope: 'mcp:tools',
          userAgent: 'OpenAI-Codex/1.0',
          now: new Date('2026-07-09T21:00:00Z'),
        },
        store,
      );
      await recordMcpOAuthAuthorized(
        {
          userId: 'user-codex',
          clientId: 'codex-client',
          clientName: 'OpenAI Codex',
          now: new Date('2026-07-09T21:01:00Z'),
        },
        store,
      );
      await recordMcpOAuthTokenIssued(
        {
          userId: 'user-codex',
          clientId: 'codex-client',
          clientName: 'OpenAI Codex',
          now: new Date('2026-07-09T21:02:00Z'),
        },
        store,
      );
      await recordMcpConnectionAttempt(
        {
          userId: 'user-codex',
          authMethod: 'oauth',
          clientId: 'codex-client',
          clientName: 'OpenAI Codex',
          sessionId: 'codex-session',
          userAgent: 'OpenAI-Codex/1.0',
          requestId: 'codex-connect',
          now: new Date('2026-07-09T21:03:00Z'),
        },
        store,
      );
      await recordMcpToolUse(
        {
          userId: 'user-codex',
          toolName: 'get_registration_status',
          authMethod: 'oauth',
          clientId: 'codex-client',
          clientName: 'OpenAI Codex',
          sessionId: 'codex-session',
          userAgent: 'OpenAI-Codex/1.0',
          now: new Date('2026-07-09T21:04:00Z'),
        },
        store,
      );
      await recordMcpFirstToolUse(
        {
          userId: 'user-codex',
          toolName: 'get_registration_status',
          authMethod: 'oauth',
          clientId: 'codex-client',
          clientName: 'OpenAI Codex',
          sessionId: 'codex-session',
          userAgent: 'OpenAI-Codex/1.0',
          now: new Date('2026-07-09T21:04:00Z'),
        },
        store,
      );
    },
  },
  {
    name: 'Power-user OpenClaw session is visible as repeated MCP usage',
    persona: 'Harsha-style power user calls Emma repeatedly from a local MCP client',
    setupPath: 'openclaw-api-key',
    async run(store) {
      await recordMcpConnectionAttempt(
        {
          userId: 'user-harsha',
          authMethod: 'api_key',
          apiKeyId: 'key-harsha',
          sessionId: 'openclaw-session-1',
          userAgent: 'OpenClaw/0.9',
          requestId: 'openclaw-connect-1',
          now: new Date('2026-07-09T22:00:00Z'),
        },
        store,
      );
      await recordMcpToolUse(
        {
          userId: 'user-harsha',
          toolName: 'create_gtm_plan',
          authMethod: 'api_key',
          apiKeyId: 'key-harsha',
          sessionId: 'openclaw-session-1',
          userAgent: 'OpenClaw/0.9',
          now: new Date('2026-07-09T22:01:00Z'),
        },
        store,
      );
      await recordMcpFirstToolUse(
        {
          userId: 'user-harsha',
          toolName: 'create_gtm_plan',
          authMethod: 'api_key',
          apiKeyId: 'key-harsha',
          sessionId: 'openclaw-session-1',
          userAgent: 'OpenClaw/0.9',
          now: new Date('2026-07-09T22:01:00Z'),
        },
        store,
      );
      await recordMcpToolUse(
        {
          userId: 'user-harsha',
          toolName: 'search_web',
          authMethod: 'api_key',
          apiKeyId: 'key-harsha',
          sessionId: 'openclaw-session-1',
          userAgent: 'OpenClaw/0.9',
          now: new Date('2026-07-09T22:02:00Z'),
        },
        store,
      );
      await recordMcpConnectionAttempt(
        {
          userId: 'user-harsha',
          authMethod: 'api_key',
          apiKeyId: 'key-harsha',
          sessionId: 'openclaw-session-2',
          userAgent: 'OpenClaw/0.9',
          requestId: 'openclaw-connect-2',
          now: new Date('2026-07-09T22:03:00Z'),
        },
        store,
      );
      await recordMcpToolUse(
        {
          userId: 'user-harsha',
          toolName: 'create_social_media_posts',
          authMethod: 'api_key',
          apiKeyId: 'key-harsha',
          sessionId: 'openclaw-session-2',
          userAgent: 'OpenClaw/0.9',
          now: new Date('2026-07-09T22:04:00Z'),
        },
        store,
      );
    },
  },
  {
    name: 'Hermes remote MCP OAuth smoke path is separately attributed',
    persona: 'agentic coding user connects Emma through Hermes remote MCP',
    setupPath: 'hermes-remote-oauth',
    async run(store) {
      await recordMcpOAuthAuthorized(
        {
          userId: 'user-hermes',
          clientId: 'hermes-client',
          clientName: 'Hermes MCP',
          now: new Date('2026-07-09T23:00:00Z'),
        },
        store,
      );
      await recordMcpOAuthTokenIssued(
        {
          userId: 'user-hermes',
          clientId: 'hermes-client',
          clientName: 'Hermes MCP',
          now: new Date('2026-07-09T23:01:00Z'),
        },
        store,
      );
      await recordMcpConnectionAttempt(
        {
          userId: 'user-hermes',
          authMethod: 'oauth',
          clientId: 'hermes-client',
          clientName: 'Hermes MCP',
          sessionId: 'hermes-session',
          userAgent: 'Hermes/1.0',
          requestId: 'hermes-connect',
          now: new Date('2026-07-09T23:02:00Z'),
        },
        store,
      );
      await recordMcpToolUse(
        {
          userId: 'user-hermes',
          toolName: 'install_skills',
          authMethod: 'oauth',
          clientId: 'hermes-client',
          clientName: 'Hermes MCP',
          sessionId: 'hermes-session',
          userAgent: 'Hermes/1.0',
          now: new Date('2026-07-09T23:03:00Z'),
        },
        store,
      );
      await recordMcpFirstToolUse(
        {
          userId: 'user-hermes',
          toolName: 'install_skills',
          authMethod: 'oauth',
          clientId: 'hermes-client',
          clientName: 'Hermes MCP',
          sessionId: 'hermes-session',
          userAgent: 'Hermes/1.0',
          now: new Date('2026-07-09T23:03:00Z'),
        },
        store,
      );
    },
  },
];

describe('Emma MCP setup telemetry simulations', () => {
  it('answers who connected, who first-used, and which client path they used', async () => {
    const store = fakeStore();

    for (const simulation of simulations) {
      await simulation.run(store);
    }

    const report = await buildMcpUsageReport(
      { start: '2026-07-09', end: '2026-07-09' },
      store,
      async (userIds) =>
        new Map(
          userIds.map((userId) => [
            userId,
            {
              email: `${userId}@example.com`,
              companyName: userId === 'user-harsha' ? 'AgentWeb' : 'Demo Account',
            },
          ]),
        ),
    );

    expect([...store.items.values()].every((item) => item.loopId === EMMA_MCP_LOOP_ID)).toBe(true);
    expect(simulations.map((simulation) => simulation.setupPath).sort()).toEqual([
      'claude.ai-connector-to-claude-code',
      'hermes-remote-oauth',
      'openclaw-api-key',
      'raw-codex',
    ]);
    expect(report.summary).toEqual({
      oauthStarts: 2,
      authorizedUsers: 3,
      tokenIssuedUsers: 3,
      connectionAttempts: 5,
      connectedUsers: 4,
      toolCalls: 7,
      firstUseUsers: 4,
      firstUseRate: 1,
    });

    const clients = new Map(report.clients.map((client) => [client.clientType, client]));
    expect(clients.get('claude_ai')).toMatchObject({
      oauthStarts: 1,
      authorizedUsers: 1,
      tokenIssuedUsers: 1,
      connectionAttempts: 0,
      toolCalls: 0,
      clientNames: ['Claude.ai custom connector'],
    });
    expect(clients.get('claude_code')).toMatchObject({
      connectionAttempts: 1,
      connectedUsers: 1,
      toolCalls: 2,
      firstUseUsers: 1,
      clientNames: ['Claude Code'],
    });
    expect(clients.get('codex')).toMatchObject({
      oauthStarts: 1,
      authorizedUsers: 1,
      tokenIssuedUsers: 1,
      connectionAttempts: 1,
      toolCalls: 1,
      firstUseUsers: 1,
      clientNames: ['OpenAI Codex'],
    });
    expect(clients.get('openclaw')).toMatchObject({
      connectionAttempts: 2,
      connectedUsers: 1,
      toolCalls: 3,
      firstUseUsers: 1,
    });
    expect(clients.get('hermes')).toMatchObject({
      authorizedUsers: 1,
      tokenIssuedUsers: 1,
      connectionAttempts: 1,
      toolCalls: 1,
      firstUseUsers: 1,
      clientNames: ['Hermes MCP'],
    });

    const users = new Map(report.users.map((user) => [user.userId, user]));
    expect(users.get('user-claude')).toMatchObject({
      connectionAttempts: 1,
      toolCalls: 2,
      firstToolName: 'get_registration_status',
      lastToolName: 'install_skills',
      authMethods: ['oauth'],
      clientNames: ['Claude Code', 'Claude.ai custom connector'],
      clientTypes: ['claude_ai', 'claude_code'],
    });
    expect(users.get('user-codex')).toMatchObject({
      connectionAttempts: 1,
      toolCalls: 1,
      firstToolName: 'get_registration_status',
      clientNames: ['OpenAI Codex'],
      clientTypes: ['codex'],
    });
    expect(users.get('user-harsha')).toMatchObject({
      companyName: 'AgentWeb',
      connectionAttempts: 2,
      toolCalls: 3,
      lastToolName: 'create_social_media_posts',
      authMethods: ['api_key'],
      apiKeyIds: ['key-harsha'],
      clientTypes: ['openclaw'],
    });
    expect(users.get('user-hermes')).toMatchObject({
      connectionAttempts: 1,
      toolCalls: 1,
      firstToolName: 'install_skills',
      clientNames: ['Hermes MCP'],
      clientTypes: ['hermes'],
    });
  });
});
