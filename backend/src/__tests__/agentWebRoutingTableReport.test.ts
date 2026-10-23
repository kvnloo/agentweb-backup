/**
 * ENG-669 PR-C switch-on: the dry-run report behind backend/scripts/seed-agentweb-routing-table.ts judges a routing table
 * exactly as the router would (its own parseRoutingTable / checkTiers / routeFor), per tier and per route, before the
 * table is written.
 */
import { describeRoutingTable, formatRoutingTableReport } from '../services/agentMode/agentWebRoutingTableReport';
import type { RouterModelCatalog } from '../services/agentMode/agentWebModelRouter';

const REGISTRY: Record<string, string | undefined> = {
  'gemini-flash': undefined,
  'gpt-5.5': undefined,
  'flash-lite': undefined,
  'opus-admin': 'admin-only',
};
const catalog: RouterModelCatalog = {
  canonical: (id) => (id === 'old-flash' ? 'gemini-flash' : Object.prototype.hasOwnProperty.call(REGISTRY, id) ? id : undefined),
  unsuitable: (id) => REGISTRY[id],
};
const identity = (id: string) => id;
const TIERS = [
  { name: 'Free', allowedModels: ['agentweb-model', 'flash-lite'] },
  { name: 'Pro', allowedModels: ['agentweb-model', 'gemini-flash', 'gpt-5.5'] },
  { name: 'Max' },
];
const TABLE = {
  version: '2026-10-22.1',
  default: 'gemini-flash',
  routes: { report: 'gpt-5.5' },
  tiers: { Free: { default: 'flash-lite' } },
};

describe('describeRoutingTable', () => {
  it('a table valid for every tier: each tier lists the model and rule of every task type', () => {
    const report = describeRoutingTable(TABLE, TIERS, catalog, identity);
    expect(report).toMatchObject({ usable: true, version: '2026-10-22.1', ok: true, issues: [] });
    if (!report.usable) throw new Error('unreachable');
    expect(report.tiers.map((t) => t.tier)).toEqual([null, 'Free', 'Pro', 'Max']);
    const free = report.tiers.find((t) => t.tier === 'Free')!;
    expect(free.ok).toBe(true);
    expect(free.routes.find((r) => r.taskType === 'chat')).toEqual({ taskType: 'chat', model: 'flash-lite', rule: 'chat task: plan default' });
    const pro = report.tiers.find((t) => t.tier === 'Pro')!;
    expect(pro.routes.find((r) => r.taskType === 'report')).toEqual({ taskType: 'report', model: 'gpt-5.5', rule: 'report task: table route' });
    expect(pro.routes.find((r) => r.taskType === 'image')).toEqual({ taskType: 'image', model: 'gemini-flash', rule: 'image task: table default' });
  });

  it('an unusable table (the router would be unavailable for everyone) reports the errors only', () => {
    expect(describeRoutingTable({ default: 'gemini-flash', routes: { chit: 'x' } }, TIERS, catalog, identity)).toEqual({
      usable: false,
      errors: ['version is required', 'routes: unknown task type "chit" (expected one of chat, scheduled, report, image, video, support)'],
    });
    expect(describeRoutingTable('nope', TIERS, catalog, identity)).toEqual({ usable: false, errors: ['the table must be a JSON object'] });
  });

  it('a tier whose allowlist lists the router but not a routed model is UNAVAILABLE, naming the routes; the others stay OK', () => {
    const report = describeRoutingTable({ ...TABLE, tiers: {} }, TIERS, catalog, identity);
    if (!report.usable) throw new Error('unreachable');
    expect(report.ok).toBe(false);
    const free = report.tiers.find((t) => t.tier === 'Free')!;
    expect(free.ok).toBe(false);
    expect(free.why).toContain('chat -> "gemini-flash"');
    expect(free.why).toContain('report -> "gpt-5.5"');
    expect(report.tiers.find((t) => t.tier === 'Pro')!.ok).toBe(true);
    expect(report.tiers.find((t) => t.tier === 'Max')!.ok).toBe(true);
  });

  it('an unusable target refuses only the routes that use it; a malformed override only its tier; an unknown tier name is an issue', () => {
    const report = describeRoutingTable({
      ...TABLE,
      routes: { report: 'opus-admin', video: 'not-a-model' },
      tiers: { Free: { default: 'flash-lite' }, Pro: { routes: { chat: '' } }, Enterprise: { default: 'gemini-flash' } },
    }, TIERS, catalog, identity);
    if (!report.usable) throw new Error('unreachable');
    expect(report.ok).toBe(false);
    const none = report.tiers.find((t) => t.tier === null)!;
    expect(none.routes.find((r) => r.taskType === 'report')).toMatchObject({ model: 'opus-admin', refused: 'admin-only' });
    expect(none.routes.find((r) => r.taskType === 'video')).toMatchObject({ model: 'not-a-model', refused: 'not a registered model' });
    expect(none.routes.find((r) => r.taskType === 'chat')!.refused).toBeUndefined();
    expect(report.tiers.find((t) => t.tier === 'Pro')!.why).toContain('malformed override');
    expect(report.issues).toEqual(['tiers.Enterprise: no subscription tier has this name, so this override never applies']);
  });

  it('legacy aliases resolve to the canonical model, as the router stores them', () => {
    const report = describeRoutingTable({ version: 1, default: 'old-flash' }, [], catalog, identity);
    if (!report.usable) throw new Error('unreachable');
    expect(report.version).toBe('1');
    expect(report.tiers[0].routes[0]).toMatchObject({ model: 'gemini-flash' });
  });
});

describe('formatRoutingTableReport', () => {
  it('prints the verdict, each tier and each route, with what is refused', () => {
    const text = formatRoutingTableReport(describeRoutingTable({ ...TABLE, routes: { report: 'opus-admin' } }, TIERS, catalog, identity));
    expect(text).toContain('Routing table version 2026-10-22.1: NOT valid for every tier');
    expect(text).toContain('(no tier override): UNAVAILABLE');
    expect(text).toContain('report    -> opus-admin (report task: table route)  REFUSED: admin-only');
    expect(text).toContain('Tier "Free": OK');
    expect(formatRoutingTableReport(describeRoutingTable(TABLE, TIERS, catalog, identity))).toContain('VALID for every tier');
    expect(formatRoutingTableReport({ usable: false, errors: ['version is required'] }))
      .toBe('Routing table: UNUSABLE (the router would be unavailable for EVERY tier):\n  - version is required');
  });
});
