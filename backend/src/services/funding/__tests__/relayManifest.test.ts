/** ENG-2113 tool relay: the manifest the backend sends in turn.run `tools`. */
import { TOOL_LIMITS } from '../../../loginHost/protocol';
import { buildRelayManifest, manifestCut, manifestProblem, relayName, INSTALL_TOOL } from '../relayManifest';

const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `${name} d`, inputSchema: { type: 'object', properties: {} }, ...extra });

describe('relayName', () => {
  // The host's widened pattern: letters of both cases, digits, _ and -, 1-64 chars, no leading '-'. Identity mapping, so these ARE the names the CLI calls.
  it.each(['search', 'get_crm_leads', 'a1_b2', 'Search', 'HubSpot-Contacts', 'call-meta', '_private', 'x'.repeat(64), 'aw-relay_x'])('accepts %s', (n) =>
    expect(relayName(n)).toBe(true));
  it.each(['', '-leading', 'x'.repeat(65), 'aw_relay_x', 'AW_Relay_x', 'aw_relay_', 'a b', 'tool.name', 'a/b', 'ünïcode', 'a\nb', 5, undefined])('rejects %p', (n) =>
    expect(relayName(n)).toBe(false));
});

describe('buildRelayManifest', () => {
  beforeEach(() => void jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('maps names by identity, so every offered name maps back to the very same bridge tool', () => {
    const m = buildRelayManifest([tool('search'), tool('save_note'), tool(INSTALL_TOOL)]);
    expect(m.tools.map((t) => t.name)).toEqual(['search', 'save_note', 'install_skills']);
    expect([...m.open]).toEqual(['search', 'save_note', 'install_skills']);
    expect(m.locked.size).toBe(0);
    expect(manifestProblem(m.tools)).toBeUndefined();
  });

  it('skips (never rewrites) names the relay cannot carry, and counts them by reason', () => {
    const m = buildRelayManifest([tool('ok_tool'), tool('Has-Upper'), tool('my.tool'), tool('-x'), tool('x'.repeat(65)), tool('aw_relay_evil'), tool('ok_tool')]);
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

  it('candidates become locked unless they are already open; a locked name is never duplicated', () => {
    const m = buildRelayManifest([tool('search'), tool(INSTALL_TOOL)], [tool('search'), tool('late_a'), tool('late_b')]);
    expect(m.tools.map((t) => [t.name, t.locked === true])).toEqual([['search', false], ['install_skills', false], ['late_a', true], ['late_b', true]]);
    expect([...m.locked]).toEqual(['late_a', 'late_b']);
    expect(m.skipped).toEqual({}); // a candidate the run already has open is not a drop
    expect(manifestCut(m)).toBe(false);
    expect(manifestProblem(m.tools)).toBeUndefined();
  });

  it('over the tool-count cap, locked candidates go first and install_skills is never dropped', () => {
    const open = [tool(INSTALL_TOOL), ...Array.from({ length: 450 }, (_, i) => tool(`open_${i}`))];
    const cands = Array.from({ length: 200 }, (_, i) => tool(`cand_${i}`));
    const m = buildRelayManifest(open, cands);
    expect(m.tools.length).toBe(TOOL_LIMITS.maxTools);
    expect(m.open.size).toBe(451);
    expect(m.locked.size).toBe(149);
    expect(m.skipped.manifest_full).toBe(51);
    expect(manifestProblem(m.tools)).toBeUndefined();
  });

  it('over the byte cap the open tail is trimmed after the locked tools, still keeping install_skills first', () => {
    const fat = (n: string) => ({ name: n, description: 'd'.repeat(40_000), inputSchema: { type: 'object', properties: { p: { description: 'x'.repeat(30_000) } } } });
    const open = [tool(INSTALL_TOOL), ...Array.from({ length: 60 }, (_, i) => fat(`open_${i}`))];
    const m = buildRelayManifest(open, [fat('late')]);
    expect(Buffer.byteLength(JSON.stringify(m.tools))).toBeLessThanOrEqual(TOOL_LIMITS.maxTotalBytes);
    expect(m.tools[0].name).toBe(INSTALL_TOOL);
    expect(m.locked.size).toBe(0);
    expect(m.skipped.manifest_too_large).toBeGreaterThan(0);
    expect(manifestProblem(m.tools)).toBeUndefined();
  });

  it('install_skills survives the caps even when it is the LAST open tool', () => {
    const fat = (n: string) => ({ name: n, description: 'd'.repeat(40_000), inputSchema: { type: 'object', properties: { p: { description: 'x'.repeat(30_000) } } } });
    const m = buildRelayManifest([...Array.from({ length: 60 }, (_, i) => fat(`open_${i}`)), tool(INSTALL_TOOL)]);
    expect(m.open.has(INSTALL_TOOL)).toBe(true);
    const many = buildRelayManifest([...Array.from({ length: 605 }, (_, i) => tool(`t_${i}`)), tool(INSTALL_TOOL)]);
    expect(many.open.has(INSTALL_TOOL)).toBe(true);
    expect(many.tools.length).toBe(TOOL_LIMITS.maxTools);
  });

  it('manifestProblem reports a manifest the host would refuse (all tools locked)', () => {
    expect(manifestProblem([{ ...tool('a'), locked: true }])).toBe('tool_all_locked');
  });
});
