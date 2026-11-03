/** ENG-2113 tool relay: the manifest the backend sends in turn.run `tools`. */
import { TOOL_LIMITS, TOOL_NAME_MAX_CHARS } from '../../../loginHost/protocol';
import { MAX_NAMES_PER_REASON, buildRelayManifest, manifestCut, manifestLogFields, manifestProblem, relayName, toToolDef, toolNote } from '../relayManifest';

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `${name} d`, inputSchema: { type: 'object', properties: {} }, ...extra });

describe('relayName', () => {
  // The host's widened pattern: letters of both cases, digits, _ and -, 1-53 chars (TOOL_NAME_MAX_CHARS), no leading '-'. Identity mapping, so these ARE the names the CLI calls.
  it.each(['search', 'get_crm_leads', 'a1_b2', 'Search', 'HubSpot-Contacts', 'call-meta', '_private', 'x'.repeat(TOOL_NAME_MAX_CHARS), 'aw-relay_x'])('accepts %s', (n) =>
    expect(relayName(n)).toBe(true));
  it.each(['', '-leading', 'x'.repeat(TOOL_NAME_MAX_CHARS + 1), 'aw_relay_x', 'AW_Relay_x', 'aw_relay_', 'a b', 'tool.name', 'a/b', 'ünïcode', 'a\nb', 5, undefined])('rejects %p', (n) =>
    expect(relayName(n)).toBe(false));
});

describe('tool name length (the host constant, 64 minus the qualifying prefix)', () => {
  beforeEach(() => void jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());
  it('a name of exactly TOOL_NAME_MAX_CHARS is offered; one more character is refused like any unmappable name', () => {
    expect(TOOL_NAME_MAX_CHARS).toBe(53);
    const ok = 'a'.repeat(TOOL_NAME_MAX_CHARS);
    const tooLong = 'a'.repeat(TOOL_NAME_MAX_CHARS + 1);
    expect(relayName(ok)).toBe(true);
    expect(relayName(tooLong)).toBe(false);
    const m = buildRelayManifest([tool(ok), tool(tooLong)]);
    expect(m.tools.map((t) => t.name)).toEqual([ok]);
    expect(m.skipped).toEqual({ name: 1 });
    expect(manifestCut(m)).toBe(true);
    expect(toToolDef(tool(tooLong))).toEqual({ skip: 'name' });
  });
});

describe('buildRelayManifest', () => {
  beforeEach(() => void jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('maps names by identity, so every offered name maps back to the very same bridge tool', () => {
    const m = buildRelayManifest([tool('search'), tool('save_note'), tool('install_skills')]);
    expect(m.tools.map((t) => t.name)).toEqual(['search', 'save_note', 'install_skills']);
    expect([...m.open]).toEqual(['search', 'save_note', 'install_skills']);
    expect(manifestProblem(m.tools)).toBeUndefined();
  });

  it('skips (never rewrites) names the relay cannot carry, and counts them by reason', () => {
    const m = buildRelayManifest([tool('ok_tool'), tool('Has-Upper'), tool('my.tool'), tool('-x'), tool('x'.repeat(TOOL_NAME_MAX_CHARS + 1)), tool('aw_relay_evil'), tool('ok_tool')]);
    expect(m.tools.map((t) => t.name)).toEqual(['ok_tool', 'Has-Upper']);
    expect(m.skipped).toEqual({ name: 3, reserved: 1, duplicate: 1 });
    expect(manifestCut(m)).toBe(true);
  });

  it('the mapping is an identity: hyphen vs underscore stay distinct tools; names differing only in case are a duplicate (the host folds case), counted as a cut', () => {
    const m = buildRelayManifest([tool('get-x'), tool('get_x'), tool('Foo'), tool('foo')]);
    expect(m.tools.map((t) => t.name)).toEqual(['get-x', 'get_x', 'Foo']);
    expect(m.skipped).toEqual({ duplicate: 1 });
    expect(manifestCut(m)).toBe(true);
    expect(manifestProblem(m.tools)).toBeUndefined(); // what is offered is always acceptable to the host
  });

  it('the reserved prefix is matched case-insensitively, like the host', () => {
    const m = buildRelayManifest([tool('ok'), tool('AW_RELAY_x'), tool('Aw_Relay_y')]);
    expect(m.tools.map((t) => t.name)).toEqual(['ok']);
    expect(m.skipped).toEqual({ reserved: 2 });
  });

  it('a missing schema becomes the empty object schema; a non-object schema is skipped; an oversized one is skipped', () => {
    const m = buildRelayManifest([
      { name: 'no_schema' },
      { name: 'array_schema', inputSchema: { type: 'array' } },
      { name: 'bad_schema', inputSchema: 'x' },
      { name: 'huge', inputSchema: { type: 'object', properties: { p: { description: 'x'.repeat(TOOL_LIMITS.maxSchemaBytes) } } } },
    ]);
    expect(m.tools.map((t) => t.name)).toEqual(['no_schema', 'bad_schema']);
    expect(m.tools[0].inputSchema).toEqual({ type: 'object', properties: {} });
    expect(m.skipped).toEqual({ schema_not_object: 1, schema_too_large: 1 });
  });

  it('cuts a long description to the byte limit without breaking a character', () => {
    const m = buildRelayManifest([{ name: 'a', description: 'é'.repeat(30_000), inputSchema: { type: 'object' } }]);
    expect(m.truncated).toBe(1);
    expect(manifestCut(m)).toBe(true);
    expect(Buffer.byteLength(m.tools[0].description)).toBeLessThanOrEqual(TOOL_LIMITS.maxDescriptionBytes);
    expect(m.tools[0].description).not.toContain('�');
    expect(manifestProblem(m.tools)).toBeUndefined();
  });

  it('over the tool-count cap the overflow is counted (the caller refuses the turn: never a degraded manifest)', () => {
    const m = buildRelayManifest(Array.from({ length: TOOL_LIMITS.maxTools + 7 }, (_, i) => tool(`open_${i}`)));
    expect(m.tools.length).toBe(TOOL_LIMITS.maxTools);
    expect(m.skipped.manifest_full).toBe(7);
    expect(manifestCut(m)).toBe(true);
    expect(manifestProblem(m.tools)).toBeUndefined();
  });

  it('over the byte cap the tail is counted as cut', () => {
    const fat = (n: string) => ({ name: n, description: 'd'.repeat(40_000), inputSchema: { type: 'object', properties: { p: { description: 'x'.repeat(30_000) } } } });
    const m = buildRelayManifest(Array.from({ length: 30 }, (_, i) => fat(`open_${i}`)));
    expect(Buffer.byteLength(JSON.stringify(m.tools))).toBeLessThanOrEqual(TOOL_LIMITS.maxTotalBytes);
    expect(m.skipped.manifest_too_large).toBeGreaterThan(0);
    expect(manifestCut(m)).toBe(true);
    expect(manifestProblem(m.tools)).toBeUndefined();
  });

  it('there are no locked tools and no candidates: the manifest is the open list, in order, nothing else', () => {
    const m = buildRelayManifest([tool('search'), tool('install_skills')]);
    expect(m.tools).toEqual([expect.objectContaining({ name: 'search' }), expect.objectContaining({ name: 'install_skills' })]);
    expect(m.tools.every((t) => !('locked' in t))).toBe(true);
    expect([...m.open]).toEqual(['search', 'install_skills']);
  });

  it('manifestProblem reports a manifest the host would refuse (empty)', () => {
    expect(manifestProblem([])).toBeDefined();
  });
});

describe('toToolDef (the definition of one tool that became available mid-turn)', () => {
  it('builds the same definition the manifest would', () => {
    expect(toToolDef(tool('late_tool'))).toEqual({ def: { name: 'late_tool', description: 'late_tool d', inputSchema: { type: 'object', properties: {} } }, truncated: false });
  });
  it.each([
    ['a name the relay cannot carry', tool('my.tool'), 'name'],
    ['the reserved prefix', tool('aw_relay_x'), 'reserved'],
    ['a non-object schema', { name: 'x', inputSchema: { type: 'array' } }, 'schema_not_object'],
    ['an oversized schema', { name: 'x', inputSchema: { type: 'object', properties: { p: { description: 'x'.repeat(TOOL_LIMITS.maxSchemaBytes) } } } }, 'schema_too_large'],
  ])('refuses %s', (_l, t, skip) => expect(toToolDef(t as never)).toEqual({ skip }));
  it('reports a cut description', () => {
    const made = toToolDef({ name: 'x', description: 'é'.repeat(30_000), inputSchema: { type: 'object' } }) as { truncated: boolean };
    expect(made.truncated).toBe(true);
  });
});

describe('what a refused manifest tells the operator (names and sizes, never contents), and why it cannot be abused', () => {
  /** Every string anywhere in the log fields: none may carry a line break, an ANSI escape or any control character, and none may be long. */
  const strings = (v: unknown, out: string[] = []): string[] => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => (out.push(k), strings(x, out)));
    return out;
  };
  const hostile = ['evil\n[relay-dispatch] ALARM root compromised', 'ansi\u001b[31mred\u001b[0m', 'nul\u0000byte', 'x'.repeat(10_000), 'ünï\u202ecode\u2028line', 'tab\tand\rcr'];

  it('a tool that did not fit is named with the sizes that mattered; a description and a schema are never in the fields', () => {
    const m = buildRelayManifest([
      tool('ok_tool'),
      { name: 'my.tool', description: 'SECRET-DESC', inputSchema: { type: 'object', properties: { secret_prop: {} } } } as never,
      tool('big_schema', { inputSchema: { type: 'object', properties: { a: { description: 'y'.repeat(TOOL_LIMITS.maxSchemaBytes) } } } }),
      tool('long_desc', { description: 'SECRET-LONG' + 'd'.repeat(TOOL_LIMITS.maxDescriptionBytes) }),
    ]);
    const f = manifestLogFields(m) as any;
    expect(f).toMatchObject({ name: 1, schema_too_large: 1, truncatedDescriptions: 1, offered: 2, listed: 4, open: 2 });
    expect(f.skippedTools.name).toEqual([{ name: 'my.tool', nameChars: 7, schemaBytes: expect.any(Number), descriptionBytes: 11 }]);
    expect(f.skippedTools.schema_too_large[0]).toMatchObject({ name: 'big_schema', schemaBytes: expect.any(Number) });
    expect(f.skippedTools.schema_too_large[0].schemaBytes).toBeGreaterThan(TOOL_LIMITS.maxSchemaBytes);
    expect(f.truncatedTools[0]).toMatchObject({ name: 'long_desc' });
    expect(f.truncatedTools[0].descriptionBytes).toBeGreaterThan(TOOL_LIMITS.maxDescriptionBytes);
    expect(f.bytes).toBe(Buffer.byteLength(JSON.stringify(m.tools)));
    expect(JSON.stringify(f)).not.toMatch(/SECRET|secret_prop|yyyy/);
  });

  it.each(hostile.map((n) => [n.slice(0, 20).replace(/[^\x20-\x7e]/g, '?'), n]))('a hostile tool name (%s) cannot forge or bloat a log line: control characters stripped, at most 64 characters (+ an ellipsis)', (_l, name) => {
    const m = buildRelayManifest([tool('ok_tool'), { name, description: 'd' } as never]);
    const all = strings(manifestLogFields(m));
    for (const s of all) {
      expect(s).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      expect(s.length).toBeLessThanOrEqual(64 + 3);
    }
    const note = (manifestLogFields(m) as any).skippedTools.name[0];
    expect(note.nameChars).toBe(name.length); // the real length is kept, as a number
  });

  it('a non-string name (a number, null, an object) is noted by its type, not stringified', () => {
    expect(toolNote({ name: 12345 }).name).toBe('<number>');
    expect(toolNote({ name: null }).name).toBe('<object>');
    expect(toolNote(null).name).toBe('<undefined>');
    expect(toolNote({ name: 'a', inputSchema: (() => { const c: any = {}; c.self = c; return c; })() }).schemaBytes).toBe(-1); // a cyclic schema does not throw
  });

  it('10,000 hostile tools: at most MAX_NAMES_PER_REASON names per reason and for cut descriptions, so the fields stay small however long the list is', () => {
    const bad = Array.from({ length: 10_000 }, (_, i) => ({ name: `bad.${i}.${'x'.repeat(200)}`, description: 'd'.repeat(100) })) as never[];
    const dup = Array.from({ length: 10_000 }, () => tool('Same_Name')); // all duplicates of the first
    const cut = Array.from({ length: 700 }, (_, i) => tool(`cut_${i}`, { description: 'd'.repeat(TOOL_LIMITS.maxDescriptionBytes + 10) }));
    const m = buildRelayManifest([...bad, ...dup, ...cut]);
    const f = manifestLogFields(m) as any;
    expect(f.name).toBe(10_000); // the COUNT is exact
    expect(f.duplicate).toBe(9_999);
    expect(f.skippedTools.name).toHaveLength(MAX_NAMES_PER_REASON);
    expect(f.skippedTools.duplicate).toHaveLength(MAX_NAMES_PER_REASON);
    expect(f.truncatedTools).toHaveLength(MAX_NAMES_PER_REASON);
    expect(f.skippedTools.manifest_full === undefined || f.skippedTools.manifest_full.length <= MAX_NAMES_PER_REASON).toBe(true);
    expect(JSON.stringify(f).length).toBeLessThan(60_000);
  });

  it('an honest manifest (nothing cut) carries sizes only: the fields for the INFO line at turn start', () => {
    const m = buildRelayManifest([tool('a_tool'), tool('b_tool')]);
    const f = manifestLogFields(m) as any;
    expect(f).toMatchObject({ offered: 2, listed: 2, open: 2, truncatedDescriptions: 0 });
    expect(f.bytes).toBeGreaterThan(0);
    expect(f.skippedTools).toBeUndefined();
    expect(f.truncatedTools).toBeUndefined();
  });
});
