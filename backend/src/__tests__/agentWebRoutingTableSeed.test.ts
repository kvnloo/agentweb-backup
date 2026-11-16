/**
 * ENG-669 PR-C switch-on: backend/scripts/seed-agentweb-routing-table.ts (its body, seedRoutingTable). Dry run by
 * default; --apply writes only a table valid for every tier, compare-and-set on the value read; never the router switch;
 * and never a table chosen by a forgotten NODE_ENV (anything but 'development' is the production AW-Settings).
 */
import { seedRoutingTable, type RoutingTableSeedDeps } from '../services/agentMode/agentWebRoutingTableSeed';

const FREE_ALLOWED = [
  'agentweb-model', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.8-flash',
  'gpt-5.4-nano', 'openrouter/openai/gpt-4o-mini', 'openrouter/openai/gpt-5.6-luna', 'openrouter/openai/gpt-6-luna',
  'openrouter/deepseek/deepseek-v4-flash', 'openrouter/z-ai/glm-4.7-flash', 'openrouter/mistralai/mistral-small-2603', 'openrouter/z-ai/glm-5.2',
];
const TIERS = [{ name: 'Free', allowedModels: FREE_ALLOWED }, { name: 'Pro', allowedModels: ['*'] }];
const TABLE = {
  version: '2026-10-21.1',
  default: 'gemini-3.8-flash',
  routes: {
    chat: 'gemini-3.8-flash', scheduled: 'gemini-3.8-flash', report: 'anthropic.claude-sonnet-5',
    support: 'gemini-3.8-flash', image: 'gemini-3.8-flash', video: 'gemini-3.8-flash',
  },
  tiers: { Free: { routes: { report: 'gemini-3.8-flash' } } },
};
const NEXT = JSON.stringify(TABLE);
const KNOWN = new Set(['gemini-3.8-flash', 'anthropic.claude-sonnet-5', ...FREE_ALLOWED.filter((m) => m !== 'agentweb-model')]);

function harness(files: Record<string, string>, row: { settingValue?: unknown; description?: string } | null = null) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: RoutingTableSeedDeps & { [K in 'getSetting' | 'setSettingIfAbsent' | 'setSettingIfValueMatches' | 'listTiers']: jest.Mock } = {
    nodeEnv: 'production',
    tableName: 'AW-Settings',
    region: 'us-west-2',
    readFile: (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path];
    },
    listTiers: jest.fn(async () => TIERS),
    catalog: { canonical: (id) => (KNOWN.has(id) ? id : undefined), unsuitable: () => undefined },
    normalizeModelId: (id) => id,
    getSetting: jest.fn(async () => row),
    setSettingIfAbsent: jest.fn(async () => true),
    setSettingIfValueMatches: jest.fn(async () => undefined),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const writes = () => [...deps.setSettingIfAbsent.mock.calls, ...deps.setSettingIfValueMatches.mock.calls];
  return { deps, out, err, writes };
}

describe('seedRoutingTable', () => {
  it('dry run (the default): the per-tier report, nothing written, and the target table printed first', async () => {
    const h = harness({ 't.json': NEXT });
    expect(await seedRoutingTable(['t.json'], h.deps)).toBe(0);
    expect(h.out[0]).toBe('Target: AW-Settings (NODE_ENV=production, region us-west-2), dry run\n');
    const report = h.out.join('\n');
    expect(report).toContain('VALID for every tier');
    expect(report).toMatch(/Tier "Free": OK[\s\S]*report {4}-> gemini-3\.8-flash \(report task: plan route\)/);
    expect(report).toMatch(/Tier "Pro": OK[\s\S]*report {4}-> anthropic\.claude-sonnet-5 \(report task: table route\)/);
    expect(h.deps.getSetting).not.toHaveBeenCalled();
    expect(h.writes()).toHaveLength(0);
  });

  it.each([[undefined], ['staging'], ['test']])('NODE_ENV %p is refused before any AWS read (it would be the production table)', async (nodeEnv) => {
    const h = harness({ 't.json': NEXT });
    h.deps.nodeEnv = nodeEnv;
    expect(await seedRoutingTable(['t.json', '--apply'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('set NODE_ENV=production (AW-Settings) or NODE_ENV=development (Dev-AW-Settings) explicitly');
    expect(h.deps.listTiers).not.toHaveBeenCalled();
    expect(h.writes()).toHaveLength(0);
  });

  it('usage errors (no file, two files, a mistyped flag) read nothing', async () => {
    for (const argv of [[], ['a.json', 'b.json'], ['t.json', '--aply']]) {
      const h = harness({ 't.json': NEXT });
      expect(await seedRoutingTable(argv, h.deps)).toBe(1);
      expect(h.deps.listTiers).not.toHaveBeenCalled();
    }
  });

  it('no subscription tiers read (absent or empty subscription_types): dry run warns, --apply refuses', async () => {
    const h = harness({ 't.json': NEXT });
    h.deps.listTiers.mockResolvedValue([]);
    expect(await seedRoutingTable(['t.json'], h.deps)).toBe(0);
    expect(h.err.join('\n')).toContain('No subscription tiers were read');
    expect(await seedRoutingTable(['t.json', '--apply'], h.deps)).toBe(1);
    expect(h.writes()).toHaveLength(0);
  });

  it('a table not valid for every tier is never written, even with --apply', async () => {
    const { tiers: _omit, ...withoutFreeOverride } = TABLE;
    const h = harness({ 't.json': JSON.stringify(withoutFreeOverride) });
    expect(await seedRoutingTable(['t.json', '--apply'], h.deps)).toBe(1);
    expect(h.out.join('\n')).toContain('report -> "anthropic.claude-sonnet-5"');
    expect(h.writes()).toHaveLength(0);
  });

  it('--apply with no row: create-if-absent; a row created meanwhile is exit 2', async () => {
    const h = harness({ 't.json': NEXT });
    expect(await seedRoutingTable(['t.json', '--apply'], h.deps)).toBe(0);
    expect(h.deps.setSettingIfAbsent).toHaveBeenCalledWith('agentweb_model_routing_table', NEXT, expect.any(String), 'seed-agentweb-routing-table');
    expect(h.deps.setSettingIfValueMatches).not.toHaveBeenCalled();
    h.deps.setSettingIfAbsent.mockResolvedValue(false);
    expect(await seedRoutingTable(['t.json', '--apply'], h.deps)).toBe(2);
  });

  it('--apply over another table: compare-and-set on the value read (keeping its description); a concurrent edit is exit 2', async () => {
    const h = harness({ 't.json': NEXT }, { settingValue: '{"version":"old"}', description: 'kept' });
    expect(await seedRoutingTable(['t.json', '--apply'], h.deps)).toBe(0);
    expect(h.deps.setSettingIfValueMatches).toHaveBeenCalledWith('agentweb_model_routing_table', NEXT, '{"version":"old"}', 'kept', 'seed-agentweb-routing-table');
    h.deps.setSettingIfValueMatches.mockRejectedValue(Object.assign(new Error('conditional'), { code: 'ConditionalCheckFailedException' }));
    expect(await seedRoutingTable(['t.json', '--apply'], h.deps)).toBe(2);
    h.deps.setSettingIfValueMatches.mockRejectedValue(new Error('network'));
    await expect(seedRoutingTable(['t.json', '--apply'], h.deps)).rejects.toThrow('network');
  });

  it('--apply when the row already holds this table, or holds a non-string value: no write', async () => {
    const same = harness({ 't.json': NEXT }, { settingValue: NEXT });
    expect(await seedRoutingTable(['t.json', '--apply'], same.deps)).toBe(0);
    expect(same.writes()).toHaveLength(0);
    const odd = harness({ 't.json': NEXT }, { settingValue: 42 });
    expect(await seedRoutingTable(['t.json', '--apply'], odd.deps)).toBe(1);
    expect(odd.writes()).toHaveLength(0);
  });

  it('only ever writes the routing table row (never agentweb_model_router_enabled)', async () => {
    const h = harness({ 't.json': NEXT }, { settingValue: '{"version":"old"}' });
    await seedRoutingTable(['t.json', '--apply'], h.deps);
    expect(h.writes().map((call) => call[0])).toEqual(['agentweb_model_routing_table']);
    expect(h.deps.getSetting.mock.calls.map((call) => call[0])).toEqual(['agentweb_model_routing_table']);
  });
});
