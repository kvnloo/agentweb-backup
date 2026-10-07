/**
 * ENG-2335 (ENG-336.3): public MCP tool responses never carry internal IDs;
 * admin / in-process surfaces are unchanged.
 */

let callToolHandler: ((request: any) => Promise<any>) | null = null;

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    server: {
      setRequestHandler: jest.fn().mockImplementation((schema: any, handler: any) => {
        if (schema === 'CallToolRequestSchema') callToolHandler = handler;
      }),
      connect: jest.fn(),
      close: jest.fn(),
      onerror: null,
    },
  })),
}));
jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({ Server: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'CallToolRequestSchema',
  ListToolsRequestSchema: 'ListToolsRequestSchema',
}));
jest.mock('../../../services/mcpUsageEventsService', () => ({
  recordMcpToolUse: jest.fn().mockResolvedValue(undefined),
  recordMcpFirstToolUse: jest.fn().mockResolvedValue(undefined),
}));

import { INTERNAL_ID_KEYS, sanitizePublicToolResult } from '../publicResponseSanitizer';

const leaky = {
  success: true,
  sessionId: 'sess-1',
  runId: 'run-1',
  traceId: 'trace-xyz',
  stripeCustomerId: 'cus_123',
  nested: [{ name: 'campaign', spanId: 's1', apiKeyId: 'k1', telemetry: { ms: 4 } }],
};

function collectKeys(v: any, acc: Set<string> = new Set()): Set<string> {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (!Array.isArray(v)) acc.add(k);
      collectKeys(x, acc);
    }
  }
  return acc;
}

describe('sanitizePublicToolResult', () => {
  it('removes internal-ID keys at any depth and keeps purpose-required IDs', () => {
    const out = sanitizePublicToolResult(leaky);
    const keys = collectKeys(out);
    for (const k of INTERNAL_ID_KEYS) expect(keys.has(k)).toBe(false);
    expect(out.sessionId).toBe('sess-1');
    expect(out.runId).toBe('run-1');
    expect(out.nested[0].name).toBe('campaign');
  });

  it('sanitizes JSON inside MCP text envelopes and leaves prose alone', () => {
    const env = sanitizePublicToolResult({ content: [{ type: 'text', text: JSON.stringify(leaky) }] });
    expect(env.content[0].text).not.toMatch(/cus_123|trace-xyz/);
    expect(sanitizePublicToolResult('plain traceId text')).toBe('plain traceId text');
  });
});

describe('createMcpServer CallTool public vs admin separation', () => {
  const { mcpToolRegistry } = require('../registry');
  const { createMcpServer } = require('../mcpServerCore');

  beforeAll(() => {
    mcpToolRegistry.register({
      name: 'eng2335_probe',
      definition: { name: 'eng2335_probe', description: 'probe', inputSchema: { type: 'object', properties: {} } },
      execute: async () => leaky,
    });
    mcpToolRegistry.register({
      name: 'get_user_by_id',
      definition: { name: 'get_user_by_id', description: 'admin', inputSchema: { type: 'object', properties: {} } },
      execute: async () => leaky,
    });
  });

  const call = async (name: string, ctx: any, args: any = {}) => {
    createMcpServer('t', ctx);
    const res = await callToolHandler!({ params: { name, arguments: args } });
    return res.content[0].text as string;
  };
  const external = { isInternal: false, agentUserId: 'u1', authMethod: 'api_key' };

  it('external public call: no internal IDs', async () => {
    const text = await call('eng2335_probe', external);
    expect(text).not.toMatch(/cus_123|trace-xyz|"apiKeyId"|"telemetry"/);
    expect(text).toMatch(/sess-1/);
  });

  it('admin tool, admin client-scoped call, and internal caller are unchanged', async () => {
    expect(await call('get_user_by_id', external)).toMatch(/cus_123/);
    expect(await call('eng2335_probe', external, { client_id: 'a@b.c' })).toMatch(/cus_123/);
    expect(await call('eng2335_probe', { isInternal: true, agentUserId: 'u1' })).toMatch(/cus_123/);
  });
});
