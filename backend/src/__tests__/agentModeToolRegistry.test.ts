import { z } from 'zod';
import {
  TypedToolRegistry,
  validateToolArgsAtBoundary,
  zodErrorToContractIssues,
  getDefaultToolRegistry,
  _resetDefaultToolRegistry,
} from '../services/agentMode/toolRegistry';
import { MIGRATED_TOOLS, createDefaultToolRegistry } from '../services/agentMode/registeredTools';
import { validateAndRepairToolArgs } from '../services/agentToolGatewayService';

// The JSON input schemas as declared in mcp/server/apiTools.ts for the migrated
// tools. The parity battery feeds these to the LEGACY validator so we can assert
// the typed-registry boundary produces the identical result (behavior-preserving).
const YOU_SEARCH_WEB_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    max_results: { type: 'number', default: 5 },
  },
  required: ['query'],
};

const YOU_SEARCH_NEWS_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    max_results: { type: 'number', default: 5 },
    freshness: { type: 'string', enum: ['day', 'week', 'month', 'year'] },
  },
  required: ['query'],
};

const GOOGLE_SEARCH_WEB_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    max_results: { type: 'number', default: 5 },
  },
  required: ['query'],
};

const SCHEMA_BY_TOOL: Record<string, any> = {
  you_search_web: YOU_SEARCH_WEB_SCHEMA,
  you_search_news: YOU_SEARCH_NEWS_SCHEMA,
  google_search_web: GOOGLE_SEARCH_WEB_SCHEMA,
};

afterEach(() => {
  _resetDefaultToolRegistry();
});

describe('TypedToolRegistry', () => {
  it('registers, looks up, and lists tools', () => {
    const registry = new TypedToolRegistry();
    registry.register({ name: 'demo_tool', schema: z.object({ a: z.string() }) });

    expect(registry.has('demo_tool')).toBe(true);
    expect(registry.has('missing_tool')).toBe(false);
    expect(registry.get('demo_tool')?.name).toBe('demo_tool');
    expect(registry.get('missing_tool')).toBeUndefined();
    expect(registry.size).toBe(1);
    expect(registry.list().map((t) => t.name)).toEqual(['demo_tool']);
  });

  it('throws on empty name and on duplicate registration', () => {
    const registry = new TypedToolRegistry();
    expect(() => registry.register({ name: '', schema: z.object({}) })).toThrow(/name is required/);

    registry.register({ name: 'dup', schema: z.object({}) });
    expect(() => registry.register({ name: 'dup', schema: z.object({}) })).toThrow(/already registered/);
  });

  it('validate() returns valid for a clean input with no normalization', () => {
    const registry = new TypedToolRegistry();
    registry.register({ name: 'demo_tool', schema: z.object({ a: z.string() }).strict() });

    const result = registry.validate('demo_tool', { a: 'hello' });
    expect(result.status).toBe('valid');
    expect(result.args).toEqual({ a: 'hello' });
    expect(result.issues).toEqual([]);
    expect(result.repairs).toEqual([]);
  });

  it('validate() returns repaired when the schema normalizes the input', () => {
    const registry = new TypedToolRegistry();
    // A transforming schema (coercion) — the future direction where the typed
    // schema takes over a repair the legacy path used to do.
    registry.register({ name: 'coerce_tool', schema: z.object({ n: z.coerce.number() }).strict() });

    const result = registry.validate('coerce_tool', { n: '5' });
    expect(result.status).toBe('repaired');
    expect(result.args).toEqual({ n: 5 });
    expect(result.repairs).toEqual(['schema:normalized']);
  });

  it('validate() maps a Zod failure onto the gateway issue vocabulary', () => {
    const registry = new TypedToolRegistry();
    registry.register({
      name: 'strict_tool',
      schema: z.object({ query: z.string().min(1), count: z.number() }).strict(),
    });

    const result = registry.validate('strict_tool', { count: 'not-a-number', extra: true });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('expected invalid');

    const codes = result.issues.map((i) => i.code).sort();
    expect(codes).toContain('missing_required'); // query missing
    expect(codes).toContain('type_mismatch'); // count wrong type
    expect(codes).toContain('unknown_property'); // extra not allowed by .strict()
    expect(result.modelMessage).toContain('strict_tool');
  });

  it('validate() is a no-op pass for an unregistered tool name', () => {
    const registry = new TypedToolRegistry();
    const result = registry.validate('never_registered', { anything: 1 });
    expect(result.status).toBe('valid');
    expect(result.args).toEqual({ anything: 1 });
  });
});

describe('zodErrorToContractIssues', () => {
  it('always yields at least one issue and maps unrecognized keys per key', () => {
    const schema = z.object({ a: z.string() }).strict();
    const parsed = schema.safeParse({ b: 1, c: 2 });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected failure');

    const issues = zodErrorToContractIssues(parsed.error);
    expect(issues.length).toBeGreaterThan(0);
    // `a` missing -> missing_required; `b` and `c` unknown -> unknown_property each.
    const unknown = issues.filter((i) => i.code === 'unknown_property').map((i) => i.path).sort();
    expect(unknown).toEqual(['$.b', '$.c']);
    expect(issues.some((i) => i.code === 'missing_required')).toBe(true);
  });
});

describe('validateToolArgsAtBoundary', () => {
  it('defers to the legacy validator for an UNREGISTERED tool (identical result)', () => {
    const emptyRegistry = new TypedToolRegistry();
    const input = {
      toolName: 'send_email',
      args: { to: 'a@b.com', subject_line: 'hi' }, // subject_line aliases subject
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' } },
        required: ['to'],
      },
      effect: 'external_send' as const,
    };

    expect(validateToolArgsAtBoundary(input, emptyRegistry)).toEqual(validateAndRepairToolArgs(input));
  });

  it('lets Zod be authoritative when it accepts a registered tool', () => {
    const registry = new TypedToolRegistry();
    // Coercing schema: Zod turns "5" -> 5. Legacy (no inputSchema) would leave it.
    registry.register({ name: 'coerce_tool', schema: z.object({ n: z.coerce.number() }).strict() });

    const boundary = validateToolArgsAtBoundary(
      { toolName: 'coerce_tool', args: { n: '5' }, inputSchema: undefined },
      registry,
    );
    expect(boundary.status).toBe('repaired');
    expect(boundary.args).toEqual({ n: 5 });

    // Prove the legacy path (no schema) would NOT have coerced — so the Zod path
    // was genuinely taken, not a fallback.
    const legacy = validateAndRepairToolArgs({ toolName: 'coerce_tool', args: { n: '5' }, inputSchema: undefined });
    expect(legacy.args).toEqual({ n: '5' });
  });

  it('falls back to the legacy validator when Zod rejects a registered tool', () => {
    const registry = createDefaultToolRegistry();
    // Alias-only input: Zod rejects (missing query), legacy repairs search_query->query.
    const input = {
      toolName: 'you_search_web',
      args: { search_query: 'agent reliability' },
      inputSchema: SCHEMA_BY_TOOL.you_search_web,
      effect: 'read' as const,
    };
    const boundary = validateToolArgsAtBoundary(input, registry);
    expect(boundary).toEqual(validateAndRepairToolArgs(input));
    expect(boundary.status).toBe('repaired');
    expect(boundary.args).toEqual({ query: 'agent reliability' });
  });

  it('ships a non-empty default registry with the migrated read tools', () => {
    const registry = getDefaultToolRegistry();
    expect(registry.size).toBe(MIGRATED_TOOLS.length);
    for (const tool of MIGRATED_TOOLS) {
      expect(registry.has(tool.name)).toBe(true);
      expect(tool.effect).toBe('read');
      expect(tool.readOnlyHint).toBe(true);
    }
  });
});

// The behavior-preserving proof: for every migrated tool, across a representative
// battery of inputs (clean, missing, empty, wrong-type, alias, coercion, unknown
// key, key-variant, null, enum-miss, non-object), the typed-registry boundary
// returns EXACTLY what the legacy validator returns today.
describe('behavior-preserving parity: migrated tools == legacy validator', () => {
  const registry = () => createDefaultToolRegistry();

  const commonCases: Array<{ label: string; args: unknown }> = [
    { label: 'clean query only', args: { query: 'ai reliability architecture' } },
    { label: 'query + numeric max_results', args: { query: 'x', max_results: 3 } },
    { label: 'missing query (invalid)', args: {} },
    { label: 'empty query (invalid)', args: { query: '' } },
    { label: 'wrong-type query (invalid)', args: { query: 123 } },
    { label: 'max_results as string (legacy coerces)', args: { query: 'x', max_results: '5' } },
    { label: 'max_results non-numeric string (invalid)', args: { query: 'x', max_results: 'lots' } },
    { label: 'benign unknown key (legacy keeps)', args: { query: 'x', foo: 'y' } },
    { label: 'key-variant alias (legacy normalizes)', args: { query: 'x', 'max-results': 5 } },
    { label: 'null optional (legacy keeps, skips type)', args: { query: 'x', max_results: null } },
    { label: 'alias with query already set', args: { query: 'x', search_query: 'z' } },
    { label: 'alias-only, query missing (legacy repairs)', args: { search_query: 'z' } },
    { label: 'non-object args (invalid)', args: 'just a string' },
  ];

  const newsOnlyCases: Array<{ label: string; args: unknown }> = [
    { label: 'valid freshness enum', args: { query: 'x', freshness: 'week' } },
    { label: 'invalid freshness enum (legacy has no enum check)', args: { query: 'x', freshness: 'decade' } },
    { label: 'query + max_results + freshness', args: { query: 'x', max_results: 4, freshness: 'day' } },
  ];

  for (const toolName of Object.keys(SCHEMA_BY_TOOL)) {
    const inputSchema = SCHEMA_BY_TOOL[toolName];
    const cases = toolName === 'you_search_news' ? [...commonCases, ...newsOnlyCases] : commonCases;

    for (const { label, args } of cases) {
      it(`${toolName}: ${label}`, () => {
        const input = { toolName, args, inputSchema, effect: 'read' as const };
        const boundary = validateToolArgsAtBoundary(input, registry());
        const legacy = validateAndRepairToolArgs(input);
        expect(boundary).toEqual(legacy);
      });
    }
  }
});
