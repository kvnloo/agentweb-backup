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

describe('ENG-3001 recursive output boundary', () => {
  const sanitize = (value: unknown, tool = 'list_leads') => sanitizePublicToolResult(value, tool);

  it('sanitizes structuredContent, envelope siblings and nested JSON text without mutating input', () => {
    const input = {
      traceId: 'top-secret',
      structuredContent: { rows: [leaky] },
      content: [{ type: 'text', traceId: 'block-secret', text: JSON.stringify(leaky) }],
      extra: { text: JSON.stringify({ debug: 'nested-secret', name: 'safe' }) },
    };
    const out = sanitize(input);
    expect(JSON.stringify(out)).not.toMatch(/top-secret|block-secret|nested-secret|trace-xyz|cus_123/);
    expect(JSON.parse(out.extra.text)).toEqual({ name: 'safe' });
    expect(input.traceId).toBe('top-secret');
  });

  it('never passes through an unsanitized subtree beyond depth 32, including JSON text', () => {
    let input: unknown = { traceId: 'deep-secret' };
    for (let i = 0; i < 40; i++) input = { child: input };
    expect(JSON.stringify(sanitize(input))).not.toContain('deep-secret');
    expect(sanitize(JSON.stringify(input))).not.toContain('deep-secret');
    const cycle: Record<string, unknown> = { traceId: 'cycle-secret' };
    cycle.child = cycle;
    expect(JSON.stringify(sanitize(cycle))).not.toContain('cycle-secret');
  });

  it('returns legitimately deep stored data complete inside a real MCP envelope', () => {
    let deep: unknown = { leaf: 'DEEP_LEAF_MARKER', traceId: 'deep-secret' };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const payload = { success: true, brand_guidelines: { brandData: { valueProposition: deep } } };
    const out = sanitize({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload });
    let node = JSON.parse(out.content[0].text).brand_guidelines.brandData.valueProposition;
    let structured = out.structuredContent.brand_guidelines.brandData.valueProposition;
    for (let i = 0; i < 40; i++) { node = node.child; structured = structured.child; }
    expect(node).toEqual({ leaf: 'DEEP_LEAF_MARKER' });
    expect(structured).toEqual({ leaf: 'DEEP_LEAF_MARKER' });
  });

  it('fails closed past the nesting budget instead of returning unvisited data', () => {
    let input: unknown = { traceId: 'deep-secret', name: 'over-budget' };
    for (let i = 0; i < 300; i++) input = { child: input };
    for (const out of [JSON.stringify(sanitize(input)), sanitize(JSON.stringify(input)) as string]) {
      expect(out).not.toContain('deep-secret');
      expect(out).not.toContain('over-budget');
      expect(out).toContain('null');
    }
  });

  it('bounds branching shared graphs and cuts active cycles immediately', () => {
    let reads = 0;
    let graph: any = { name: 'safe', traceId: 'secret' };
    for (let i = 0; i < 28; i++) {
      const child = graph;
      graph = { get a() { reads++; return child; }, get b() { reads++; return child; } };
    }
    expect(JSON.stringify(sanitize(graph))).not.toContain('secret');
    expect(reads).toBeLessThan(20000);
    const cycle: any = { name: 'safe' };
    cycle.a = cycle;
    cycle.b = cycle;
    expect(sanitize(cycle)).toEqual({ name: 'safe', a: null, b: null });
  });

  it('sanitizes multiply encoded JSON while preserving clean encoded prose', () => {
    const encoded = JSON.stringify(JSON.stringify({ sessionId: 'secret', runId: 'secret', name: 'safe' }));
    expect(JSON.parse(JSON.parse(sanitize(encoded)))).toEqual({ name: 'safe' });
    const prose = JSON.stringify('ordinary prose');
    expect(sanitize(prose)).toBe(prose);
  });

  it('preserves clean JSON formatting, non-JSON prose and ordinary resource handles', () => {
    const text = ' { "name" : "kept" } ';
    expect(sanitize({ text, id: 'resource', campaignId: 'campaign', deckId: 'deck', itemId: 'item' }))
      .toEqual({ text, id: 'resource', campaignId: 'campaign', deckId: 'deck', itemId: 'item' });
    expect(sanitize('{not json')).toBe('{not json');
  });

  it.each([
    'emma_create_session', 'emma_list_sessions', 'get_chat_history',
    'list_scheduled_chats', 'manage_scheduled_chat', 'get_scheduled_chat_test_history',
  ])('keeps session handles for %s follow-up', (tool) => {
    expect(sanitize({ sessionId: 's', session_id: 's', requestId: 'private' }, tool))
      .toEqual({ sessionId: 's', session_id: 's' });
  });

  it('withholds conversation, poll and approval IDs from unrelated tools', () => {
    const handles = { sessionId: 's', session_id: 's', runId: 'r', run_id: 'r', requestId: 'q', request_id: 'q' };
    expect(sanitize(handles)).toEqual({});
    expect(sanitize(handles, 'emma_create_session')).toEqual({ sessionId: 's', session_id: 's' });
    expect(sanitize(handles, 'test_scheduled_chat')).toEqual({ runId: 'r', run_id: 'r' });
    expect(sanitize(handles, 'get_smartlead_push_status')).toEqual({ runId: 'r', run_id: 'r' });
    expect(sanitize(handles, 'emma_get_session')).toEqual(handles);
  });
});

describe('sanitizePublicToolResult', () => {
  it('removes internal-ID keys at any depth and keeps purpose-required IDs', () => {
    const out = sanitizePublicToolResult(leaky, 'emma_send_message');
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
    expect(text).not.toMatch(/sess-1|run-1/);
  });

  it.each(['api_key', 'oauth'])('filters every output surface at the %s CallTool boundary', async (authMethod) => {
    let deep: unknown = { traceId: 'deep-boundary-secret' };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const envelope = {
      content: [{ type: 'text', text: JSON.stringify(leaky), traceId: 'block-secret' }],
      structuredContent: { ...leaky, deep },
      extra: { stripeCustomerId: 'sibling-secret' },
    };
    const execute = jest.spyOn(mcpToolRegistry, 'execute').mockResolvedValue(envelope);
    try {
      const ctx = { ...external, authMethod };
      createMcpServer('t', ctx);
      const out = await callToolHandler!({ params: { name: 'eng2335_probe', arguments: {} } });
      expect(JSON.stringify(out)).not.toMatch(/trace-xyz|cus_123|deep-boundary-secret|block-secret|sibling-secret|sess-1|run-1/);
      createMcpServer('t', { isInternal: true, agentUserId: 'u1' });
      expect(await callToolHandler!({ params: { name: 'eng2335_probe', arguments: {} } })).toEqual(envelope);
      createMcpServer('t', ctx);
      expect(await callToolHandler!({ params: { name: 'get_user_by_id', arguments: {} } })).toEqual(envelope);
      expect(await callToolHandler!({ params: { name: 'eng2335_probe', arguments: { clientId: 'client' } } })).toEqual(envelope);
    } finally { execute.mockRestore(); }
  });

  it('passes tool purpose through CallTool for continuation, polling and work-plan input', async () => {
    const execute = jest.spyOn(mcpToolRegistry, 'execute').mockResolvedValue({ ...leaky, requestId: 'input-1' });
    try {
      const session = JSON.parse(await call('emma_get_session', external));
      expect(session).toMatchObject({ sessionId: 'sess-1', runId: 'run-1', requestId: 'input-1' });
      expect(session.traceId).toBeUndefined();
      const schedule = JSON.parse(await call('test_scheduled_chat', external));
      expect(schedule.runId).toBe('run-1');
      expect(schedule.sessionId).toBeUndefined();
      expect(schedule.requestId).toBeUndefined();
    } finally { execute.mockRestore(); }
  });

  it('admin tool, admin client-scoped call, and internal caller are unchanged', async () => {
    expect(await call('get_user_by_id', external)).toMatch(/cus_123/);
    expect(await call('eng2335_probe', external, { client_id: 'a@b.c' })).toMatch(/cus_123/);
    expect(await call('eng2335_probe', { isInternal: true, agentUserId: 'u1' })).toMatch(/cus_123/);
  });
});
