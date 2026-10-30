/**
 * ENG-2113 tool relay: the manifest built from the REAL tool registry (every tool a user with all skills could be offered) must fit the relay's
 * protocol limits WITHOUT truncating a description or dropping a tool. Registry growth must fail here, in CI (step "Plan route tool limits" of tests.yml), not silently in
 * production. The limits are explained for tool authors in docs/plan-route-tool-limits.md.
 */
import { agentModeService } from '../../agentModeService';
import { TOOL_LIMITS, TOOL_NAME_MAX_CHARS } from '../../../loginHost/protocol';
import { buildRelayManifest, manifestProblem, toToolDef } from '../relayManifest';
import { MAX_JSON_DEPTH, jsonDepth } from '../jsonDepthGuard';

jest.mock('openai');
jest.mock('../../settingsService');
jest.mock('../../db');
jest.mock('../../chatbotService');
jest.mock('../../../utils/secretsManager');
jest.mock('../../skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]), getSkillsByIds: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../../subscriptionService', () => ({
  getAllowedSkills: jest.fn().mockResolvedValue(['*']),
  resolveSkillsToToolNames: jest.fn().mockResolvedValue(['*']),
  filterFunctionCalls: jest.fn().mockImplementation((tools: any) => tools),
}));

type Tool = { name: string; description?: string; inputSchema?: unknown };

/** One line per tool that does not fit, naming the tool and the limit, so a developer who adds one knows what to change. Empty when everything fits. */
function toolLimitProblems(tools: Tool[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const t of tools) {
    const made = toToolDef(t);
    if ('skip' in made) {
      const why: Record<string, string> = {
        name: `the name must be 1-${TOOL_NAME_MAX_CHARS} characters of A-Z a-z 0-9 _ - with no leading - (it has ${String(t.name).length})`,
        reserved: 'the name starts with the reserved prefix aw_relay_',
        schema_not_object: 'the input schema must have type "object"',
        schema_too_large: `the input schema is ${Buffer.byteLength(JSON.stringify(t.inputSchema))} bytes, the limit is ${TOOL_LIMITS.maxSchemaBytes}`,
      };
      out.push(`${t.name}: ${why[made.skip] ?? made.skip}`);
      continue;
    }
    if (made.truncated) out.push(`${t.name}: the description is ${Buffer.byteLength(t.description ?? '')} bytes, the limit is ${TOOL_LIMITS.maxDescriptionBytes}`);
    const folded = t.name.toLowerCase();
    const first = seen.get(folded);
    if (first !== undefined) out.push(`${t.name}: differs from ${first} only in case, and names are compared case-insensitively`);
    else seen.set(folded, t.name);
  }
  if (tools.length > TOOL_LIMITS.maxTools) out.push(`all tools: ${tools.length} tools, the limit is ${TOOL_LIMITS.maxTools}`);
  const defs = tools.map((t) => toToolDef(t)).flatMap((m) => ('def' in m ? [m.def] : []));
  const total = Buffer.byteLength(JSON.stringify(defs));
  if (total > TOOL_LIMITS.maxTotalBytes) out.push(`all tools: ${total} bytes of JSON, the limit is ${TOOL_LIMITS.maxTotalBytes}`);
  return out;
}

function expectAllFit(label: string, tools: Tool[]): void {
  const problems = toolLimitProblems(tools);
  if (problems.length > 0) throw new Error(`${label}: these do not fit the Claude plan route. See docs/plan-route-tool-limits.md.\n${problems.map((p) => `  - ${p}`).join('\n')}`);
}

describe('toolLimitProblems names the offending tool and the limit', () => {
  const ok = { name: 'fine', description: 'd', inputSchema: { type: 'object' } };
  it.each([
    ['a name over the limit', { ...ok, name: 'x'.repeat(TOOL_NAME_MAX_CHARS + 1) }, `1-${TOOL_NAME_MAX_CHARS} characters`],
    ['a bad character', { ...ok, name: 'my.tool' }, 'A-Z a-z 0-9 _ -'],
    ['the reserved prefix', { ...ok, name: 'aw_relay_x' }, 'reserved prefix'],
    ['a non-object schema', { ...ok, name: 'arr', inputSchema: { type: 'array' } }, 'type "object"'],
    ['an oversized schema', { ...ok, name: 'big_schema', inputSchema: { type: 'object', d: 'x'.repeat(TOOL_LIMITS.maxSchemaBytes) } }, `the limit is ${TOOL_LIMITS.maxSchemaBytes}`],
    ['an oversized description', { ...ok, name: 'long_desc', description: 'x'.repeat(TOOL_LIMITS.maxDescriptionBytes + 1) }, `the limit is ${TOOL_LIMITS.maxDescriptionBytes}`],
    ['a case-only duplicate', { ...ok, name: 'FINE' }, 'only in case'],
  ])('%s', (_label, tool, limit) => {
    const lines = toolLimitProblems([ok, tool]);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`${tool.name}:`)).toBe(true);
    expect(lines[0]).toContain(limit);
    expect(() => expectAllFit('test', [ok, tool])).toThrow('docs/plan-route-tool-limits.md');
  });
  it('the totals of a turn', () => {
    expect(toolLimitProblems(Array.from({ length: TOOL_LIMITS.maxTools + 1 }, (_, i) => ({ ...ok, name: `t_${i}` })))).toEqual([`all tools: ${TOOL_LIMITS.maxTools + 1} tools, the limit is ${TOOL_LIMITS.maxTools}`]);
    const fat = Array.from({ length: 40 }, (_, i) => ({ name: `t_${i}`, description: 'd'.repeat(30_000), inputSchema: { type: 'object' } }));
    expect(toolLimitProblems(fat)[0]).toContain(`the limit is ${TOOL_LIMITS.maxTotalBytes}`);
  });
  it('a set that fits has no problems', () => {
    expect(toolLimitProblems([ok, { ...ok, name: 'other' }])).toEqual([]);
  });
});

describe('relay manifest from the real tool registry', () => {
  beforeEach(() => {
    require('../../settingsService').settingsService = { getSetting: jest.fn().mockResolvedValue(null) };
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  async function registryTools() {
    await (agentModeService as any).registerTools(); // the real registration path (Emma tools + built-ins), without MCP or DynamoDB
    const defs: any[] = (agentModeService as any).toolRegistry.getAllTools().map((t: any) => t.definition);
    return defs.map((d) => ({ name: d.function.name as string, description: d.function.description as string, inputSchema: d.function.parameters }));
  }

  it('the OPEN set of a fresh chat (foundation tools + install_skills, as Emma starts one) fits with headroom: nothing cut or dropped', async () => {
    const all = await registryTools();
    const { allowedToolNames } = agentModeService.buildSkillContext([], ['*'], [], [], false);
    const open = all.filter((t) => allowedToolNames.has(t.name) || t.name === 'install_skills');
    expectAllFit('the open set of a fresh chat', open);
    const m = buildRelayManifest(open);
    const stats = { open: open.length, offered: m.tools.length, totalBytes: Buffer.byteLength(JSON.stringify(m.tools)), maxTools: TOOL_LIMITS.maxTools, maxTotalBytes: TOOL_LIMITS.maxTotalBytes, skipped: m.skipped, truncated: m.truncated };
    process.stdout.write(`relay manifest OPEN set stats ${JSON.stringify(stats)}\n`);
    expect(open.length).toBeGreaterThanOrEqual(70); // the foundation set really loaded (78 today): a drop in foundation tools is caught
    expect(open.some((t) => t.name === 'install_skills')).toBe(true);
    expect(m.skipped).toEqual({});
    expect(m.truncated).toBe(0);
    expect(m.tools.length).toBe(open.length);
    expect(manifestProblem(m.tools)).toBeUndefined();
    expect(m.tools.length).toBeLessThan(TOOL_LIMITS.maxTools / 2); // headroom
    expect(stats.totalBytes).toBeLessThan(TOOL_LIMITS.maxTotalBytes / 2);
  });

  it('the WHOLE registry (worst case: every skill installed in one turn) still fits the cumulative caps: nothing cut or dropped', async () => {
    const tools = await registryTools();
    expectAllFit('the whole registry', tools);
    const m = buildRelayManifest(tools);
    const stats = {
      registry: tools.length,
      offered: m.tools.length,
      skipped: m.skipped,
      truncatedDescriptions: m.truncated,
      maxTools: TOOL_LIMITS.maxTools,
      totalBytes: Buffer.byteLength(JSON.stringify(m.tools)),
      maxTotalBytes: TOOL_LIMITS.maxTotalBytes,
      longestDescription: Math.max(...tools.map((t) => Buffer.byteLength(t.description ?? ''))),
      largestSchema: Math.max(...tools.map((t) => Buffer.byteLength(JSON.stringify(t.inputSchema ?? {})))),
      longestName: Math.max(...tools.map((t) => t.name.length)),
      deepestSchema: Math.max(...tools.map((t) => jsonDepth(JSON.stringify(t.inputSchema ?? {})))),
    };
    process.stdout.write(`relay manifest registry stats ${JSON.stringify(stats)}\n`);
    expect(tools.length).toBeGreaterThan(50); // the registry really loaded
    expect(m.skipped).toEqual({});
    expect(m.truncated).toBe(0);
    expect(m.tools.length).toBe(tools.length);
    expect(manifestProblem(m.tools)).toBeUndefined();
    // A tool call's arguments follow its schema, so the schemas' depth bounds what the worker legitimately sends back: well under the pre-parse guard.
    expect(stats.deepestSchema).toBeLessThan(MAX_JSON_DEPTH / 2);
  });
});
