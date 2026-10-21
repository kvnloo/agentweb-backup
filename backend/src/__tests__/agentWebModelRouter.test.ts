/**
 * ENG-669 PR-C: the AgentWeb Model router (services/agentMode/agentWebModelRouter.ts), pure.
 *
 * Contract: switch `agentweb_model_router_enabled` exact 'true' = on, anything else / cold-start failure = off. The
 * routing table (`agentweb_model_routing_table`) is validated at load, with the damage kept narrow: an unparseable,
 * missing or unreadable table makes the router unavailable for EVERYONE; a target that is not a registered, publicly
 * selectable, priced, tool-capable model makes only the routes resolving to it unavailable; a tier whose allowlist does
 * not cover its routes makes the router unavailable for THAT tier only. Unavailable = model_unavailable plus one deduped
 * alert naming what broke, never a silent pick of another model; a failed refresh keeps the last good table. Routing is
 * deterministic: tier route > tier default > table route > table default.
 */
import {
  AGENTWEB_MODEL_ID,
  AGENTWEB_MODEL_ROUTER_SETTING,
  AGENTWEB_MODEL_ROUTING_TABLE_SETTING,
  ROUTE_OUTSIDE_PLAN_ALERT_DEDUPE_KEY,
  ROUTE_TARGET_ALERT_DEDUPE_PREFIX,
  ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY,
  TABLE_ISSUES_ALERT_DEDUPE_KEY,
  TIER_UNAVAILABLE_ALERT_DEDUPE_PREFIX,
  checkTiers,
  createAgentWebModelRouter,
  isAgentWebModelId,
  messageRoutingOf,
  parseRoutingTable,
  routeFor,
  routingFieldsOf,
  storedModelFor,
  taskTypeForSession,
  type AgentWebModelRouterDeps,
  type RouterModelCatalog,
} from '../services/agentMode/agentWebModelRouter';
import { registryRouterCatalog } from '../services/agentMode/agentWebModelRouterInstance';
import { ALL_MODELS, type TierModelsConfig } from '../services/agentMode/modelAccess';
import { ModelUnavailableError, buildModelUnavailableBody } from '../services/agentMode/modelUnavailable';

// The instance module wires the service graph lazily; nothing here reaches it beyond the static catalog.
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));

/** A fake registry: one model per way of being unsuitable, plus good ones and an alias. */
const MODELS: Record<string, string | undefined> = {
  'good-a': undefined,
  'good-b': undefined,
  'good-c': undefined,
  'admin-x': 'admin-only',
  'internal-x': 'internal-only',
  'live-x': 'live voice',
  'unpriced-x': 'unpriced',
  'notools-x': 'cannot call tools',
};
const catalog: RouterModelCatalog = {
  canonical: (id) => {
    const canonical = id === 'old-a' ? 'good-a' : id;
    return Object.prototype.hasOwnProperty.call(MODELS, canonical) ? canonical : undefined;
  },
  unsuitable: (id) => MODELS[id],
};

const TABLE = {
  version: 'v1',
  default: 'good-a',
  routes: { report: 'good-b' },
  tiers: { Pro: { routes: { chat: 'good-c' } }, Free: { default: 'good-b' } },
};

describe('parseRoutingTable', () => {
  it('accepts a valid table and stores aliases canonically', () => {
    const parsed = parseRoutingTable({ ...TABLE, routes: { report: 'old-a' } }, catalog);
    expect(parsed).toEqual({
      ok: true,
      table: {
        version: 'v1', default: 'good-a', routes: { report: 'good-a' },
        tiers: { Pro: { routes: { chat: 'good-c' } }, Free: { default: 'good-b', routes: {} } },
      },
      invalidTargets: {},
      malformedTiers: {},
    });
  });

  it.each([
    ['admin-x', 'admin-only'],
    ['internal-x', 'internal-only'],
    ['live-x', 'live voice'],
    ['unpriced-x', 'unpriced'],
    ['notools-x', 'cannot call tools'],
    ['gpt-nope', 'not a registered model'],
  ])('a target that is %s (%s) is recorded as unusable, wherever it appears; the table still parses', (model, why) => {
    for (const table of [
      { ...TABLE, default: model },
      { ...TABLE, routes: { chat: model } },
      { ...TABLE, tiers: { Pro: { default: model } } },
      { ...TABLE, tiers: { Pro: { routes: { video: model } } } },
    ]) {
      const parsed = parseRoutingTable(table, catalog);
      expect(parsed.ok).toBe(true);
      expect((parsed as any).invalidTargets).toEqual({ [model]: why });
    }
  });

  it('cannot parse: not an object, a missing default or version, unknown keys or task types, a non-string target', () => {
    const cases: Array<[unknown, string]> = [
      [{ version: 'v1' }, 'default must be a model id'],
      [{ ...TABLE, version: ' ' }, 'version is required'],
      [{ ...TABLE, defualt: 'good-a' }, 'unknown key "defualt"'],
      [{ ...TABLE, routes: { reports: 'good-a' } }, 'unknown task type "reports"'],
      [{ ...TABLE, routes: { chat: 42 } }, 'routes.chat must be a model id'],
      [{ ...TABLE, tiers: ['Pro'] }, 'tiers must be an object'],
      [[TABLE], 'must be a JSON object'],
    ];
    for (const [raw, message] of cases) {
      const parsed = parseRoutingTable(raw, catalog);
      expect(parsed.ok).toBe(false);
      expect((parsed as any).errors.join(' | ')).toContain(message);
    }
  });
});

describe('parseRoutingTable: a malformed tier override is contained to that tier', () => {
  it.each([
    ['an unknown route key', { Pro: { routes: { chta: 'good-a' } } }, 'unknown task type "chta"'],
    ['an empty default', { Pro: { default: '' } }, 'tiers.Pro.default must be a model id'],
    ['a non-string target', { Pro: { routes: { chat: 7 } } }, 'tiers.Pro.routes.chat must be a model id'],
    ['an unknown key', { Pro: { route: {} } }, 'unknown key "route"'],
    ['not an object', { Pro: 'good-a' }, 'tiers.Pro must be an object'],
  ])('%s: the table parses, only Pro is malformed, and its override is not applied', (_label, tiers, why) => {
    const parsed = parseRoutingTable({ ...TABLE, tiers: { ...tiers, Free: { default: 'good-b' } } }, catalog);
    expect(parsed.ok).toBe(true);
    expect(Object.keys((parsed as any).malformedTiers)).toEqual(['Pro']);
    expect((parsed as any).malformedTiers.Pro.join(' | ')).toContain(why);
    expect((parsed as any).table.tiers).toEqual({ Free: { default: 'good-b', routes: {} } });
  });
});

describe('routeFor: tier route > tier default > table route > table default', () => {
  const table = (parseRoutingTable(TABLE, catalog) as any).table;
  it.each([
    ['Pro', 'chat', 'good-c', 'chat task: plan route'],
    ['Pro', 'report', 'good-b', 'report task: table route'],
    ['Free', 'report', 'good-b', 'report task: plan default'],
    ['Free', 'chat', 'good-b', 'chat task: plan default'],
    [null, 'report', 'good-b', 'report task: table route'],
    [null, 'scheduled', 'good-a', 'scheduled task: table default'],
    ['Unknown', 'chat', 'good-a', 'chat task: table default'],
  ])('tier %s, %s task -> %s', (tier, taskType, model, reason) => {
    expect(routeFor(table, tier as any, taskType as any)).toEqual({ model, reason });
  });
});

describe('checkTiers: the router never routes a tier to a model its plan excludes (per tier)', () => {
  const table = (parseRoutingTable(TABLE, catalog) as any).table;
  const id = (x: string) => x;

  it('passes when every route of every router tier is in its allowlist (wildcards and absent fields allow all)', () => {
    const tiers: TierModelsConfig[] = [
      { name: 'Free', allowedModels: [AGENTWEB_MODEL_ID, 'good-b'] },
      { name: 'Pro', allowedModels: ['*'] },
      { name: 'Team' },
    ];
    expect(checkTiers(table, tiers, id)).toEqual({ unavailableTiers: {}, issues: [] });
  });

  it('marks only the tier whose allowlist misses its routes, naming each task and model', () => {
    const tiers: TierModelsConfig[] = [
      { name: 'Free', allowedModels: [AGENTWEB_MODEL_ID, 'good-a'] }, // Free routes everything to good-b
      { name: 'Pro', allowedModels: [AGENTWEB_MODEL_ID, 'good-a', 'good-b', 'good-c'] },
    ];
    const { unavailableTiers } = checkTiers(table, tiers, id);
    expect(Object.keys(unavailableTiers)).toEqual(['Free']);
    expect(unavailableTiers.Free).toContain('chat -> "good-b"');
    expect(unavailableTiers.Free).toContain('video -> "good-b"');
  });

  it('ignores a tier that cannot select the router, and a route whose target is already unusable', () => {
    const tiers: TierModelsConfig[] = [{ name: 'Free', allowedModels: ['good-a'] }, { name: 'Pro', allowedModels: [AGENTWEB_MODEL_ID, 'good-a', 'good-b'] }];
    // Pro's chat route is good-c: unusable is that route's problem, not a reason to take the whole tier down.
    expect(checkTiers(table, tiers, id, { 'good-c': 'unpriced' }).unavailableTiers).toEqual({});
    expect(Object.keys(checkTiers(table, tiers, id).unavailableTiers)).toEqual(['Pro']);
  });

  it('reports an override for a tier that does not exist as an issue (it never applies), without taking anything down', () => {
    expect(checkTiers(table, [{ name: 'Pro', allowedModels: ['*'] }], id)).toEqual({
      unavailableTiers: {},
      issues: ['tiers.Free: no subscription tier has this name, so this override never applies'],
    });
  });
});

describe('createAgentWebModelRouter', () => {
  function makeDeps(overrides: { switchValue?: unknown; table?: unknown; tiers?: TierModelsConfig[] | null } = {}) {
    let now = 1_000_000;
    const settings: Record<string, unknown> = {
      [AGENTWEB_MODEL_ROUTER_SETTING]: 'switchValue' in overrides ? overrides.switchValue : 'true',
      [AGENTWEB_MODEL_ROUTING_TABLE_SETTING]: 'table' in overrides ? overrides.table : JSON.stringify(TABLE),
    };
    let tiers: TierModelsConfig[] | null = 'tiers' in overrides ? overrides.tiers! : null;
    const deps = {
      getSetting: jest.fn(async (name: string) => (settings[name] === undefined ? null : { settingValue: settings[name] })),
      catalog,
      readTierAllowlists: jest.fn(async () => tiers),
      normalizeModelId: (x: string) => x,
      alert: jest.fn(async (_input: { subject: string; detail: string; dedupeKey: string; dedupeWindowMs: number }) => undefined),
      now: () => now,
      log: jest.fn(),
      info: jest.fn(),
    } satisfies AgentWebModelRouterDeps;
    return {
      deps,
      router: createAgentWebModelRouter(deps),
      advance: (ms: number) => { now += ms; },
      set: (name: string, value: unknown) => { settings[name] = value; },
      setTiers: (value: TierModelsConfig[] | null) => { tiers = value; },
    };
  }
  const chat = { tier: null, taskType: 'chat' as const, allowedModels: ALL_MODELS };
  const alertKeys = (deps: { alert: jest.Mock }) => deps.alert.mock.calls.map(([a]) => a.dedupeKey);

  it('switch: only the exact string "true" turns it on; a cold-start read failure is off', async () => {
    for (const value of ['TRUE', ' true', '1', true, undefined]) {
      expect(await makeDeps({ switchValue: value }).router.isEnabled()).toBe(false);
    }
    expect(await makeDeps().router.isEnabled()).toBe(true);
    const failing = makeDeps();
    failing.deps.getSetting.mockRejectedValue(new Error('down'));
    expect(await failing.router.isEnabled()).toBe(false);
  });

  it('switch: cached ~60s, and a failed refresh keeps the last-known value', async () => {
    const t = makeDeps();
    expect(await t.router.isEnabled()).toBe(true);
    t.set(AGENTWEB_MODEL_ROUTER_SETTING, 'false');
    t.advance(30_000);
    expect(await t.router.isEnabled()).toBe(true);
    t.deps.getSetting.mockRejectedValueOnce(new Error('down'));
    t.advance(31_000);
    expect(await t.router.isEnabled()).toBe(true); // last known
    t.advance(6_000);
    expect(await t.router.isEnabled()).toBe(false);
  });

  it('routes with the table version and reason; the table is read once per window', async () => {
    const t = makeDeps();
    expect(await t.router.route({ ...chat, tier: 'Pro' })).toEqual({ model: 'good-c', reason: 'chat task: plan route', tableVersion: 'v1' });
    await t.router.route(chat);
    const tableReads = t.deps.getSetting.mock.calls.filter(([n]) => n === AGENTWEB_MODEL_ROUTING_TABLE_SETTING);
    expect(tableReads).toHaveLength(1);
    expect(t.deps.alert).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined, 'absent or empty'],
    ['not JSON', '{nope', 'not valid JSON'],
    ['unparseable', JSON.stringify({ ...TABLE, routes: { reports: 'good-a' } }), 'unknown task type "reports"'],
  ])('a %s table makes the router unavailable for EVERY tier and route, with ONE alert', async (_label, table, detail) => {
    const t = makeDeps({ table });
    for (const tier of [null, 'Free', 'Pro']) {
      for (const taskType of ['chat', 'report'] as const) {
        const error = await t.router.route({ tier, taskType, allowedModels: ALL_MODELS }).catch((e) => e);
        expect(error).toBeInstanceOf(ModelUnavailableError);
        expect(error).toMatchObject({ requestedModel: AGENTWEB_MODEL_ID, reason: 'not_served' });
      }
      expect(await t.router.isAvailableFor(tier)).toBe(false);
    }
    expect(t.deps.alert).toHaveBeenCalledTimes(1);
    expect(t.deps.alert).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY,
      detail: expect.stringContaining(detail),
    }));
  });

  it('an unusable target takes down ONLY the routes resolving to it, never falling through to another rule', async () => {
    // Pro's chat route is admin-only; everything else still routes, and Pro chat is refused (not sent to the default).
    const t = makeDeps({ table: JSON.stringify({ ...TABLE, tiers: { Pro: { routes: { chat: 'admin-x' } } } }) });
    await expect(t.router.route({ ...chat, tier: 'Pro' })).rejects.toMatchObject({ requestedModel: AGENTWEB_MODEL_ID, reason: 'not_served' });
    await expect(t.router.route({ ...chat, tier: 'Pro', taskType: 'report' })).resolves.toMatchObject({ model: 'good-b' });
    await expect(t.router.route({ ...chat, tier: 'Free' })).resolves.toMatchObject({ model: 'good-a' });
    await expect(t.router.route(chat)).resolves.toMatchObject({ model: 'good-a' });
    expect(await t.router.isAvailableFor('Pro')).toBe(false);
    expect(await t.router.isAvailableFor('Free')).toBe(true);
    expect(await t.router.isAvailableFor(null)).toBe(true);
    expect(alertKeys(t.deps)).toEqual([`${ROUTE_TARGET_ALERT_DEDUPE_PREFIX}admin-x`]);
    expect(t.deps.alert.mock.calls[0][0].detail).toContain('admin-only');
  });

  it('a tier whose allowlist misses its routes is unavailable for THAT tier only, with one alert naming tier and model', async () => {
    const t = makeDeps({
      table: JSON.stringify({ ...TABLE, tiers: { Pro: { routes: { chat: 'good-c' } } } }),
      tiers: [
        { name: 'Free', allowedModels: [AGENTWEB_MODEL_ID, 'good-a'] }, // Free's report route is good-b
        { name: 'Pro', allowedModels: ['*'] },
        { name: 'Team', allowedModels: [AGENTWEB_MODEL_ID, 'good-a', 'good-b'] },
      ],
    });
    for (const taskType of ['chat', 'report'] as const) {
      await expect(t.router.route({ tier: 'Free', taskType, allowedModels: ALL_MODELS })).rejects.toMatchObject({ reason: 'not_served' });
    }
    await expect(t.router.route({ ...chat, tier: 'Pro' })).resolves.toMatchObject({ model: 'good-c' });
    await expect(t.router.route({ ...chat, tier: 'Team', taskType: 'report' })).resolves.toMatchObject({ model: 'good-b' });
    expect(await t.router.isAvailableFor('Free')).toBe(false);
    expect(await t.router.isAvailableFor('Team')).toBe(true);
    expect(alertKeys(t.deps)).toEqual([`${TIER_UNAVAILABLE_ALERT_DEDUPE_PREFIX}Free`]);
    expect(t.deps.alert.mock.calls[0][0]).toMatchObject({
      subject: 'AgentMode: AgentWeb Model unavailable for tier "Free"',
      detail: expect.stringContaining('report -> "good-b"'),
    });

    // Fixing the tier (allowing what the table routes it to) restores it on the next load.
    t.setTiers([{ name: 'Free', allowedModels: [AGENTWEB_MODEL_ID, 'good-a', 'good-b'] }, { name: 'Pro', allowedModels: ['*'] }, { name: 'Team' }]);
    t.advance(61_000);
    await expect(t.router.route({ ...chat, tier: 'Free', taskType: 'report' })).resolves.toMatchObject({ model: 'good-b' });
  });

  it('a typo in ONE tier override (Pro) takes down only Pro, with one alert naming it; other tiers keep routing', async () => {
    const t = makeDeps({ table: JSON.stringify({ ...TABLE, tiers: { Pro: { routes: { chta: 'good-c' } }, Free: { default: 'good-b' } } }) });
    await expect(t.router.route({ ...chat, tier: 'Pro' })).rejects.toMatchObject({ requestedModel: AGENTWEB_MODEL_ID, reason: 'not_served' });
    // Never falls through to the table routes for Pro either.
    await expect(t.router.route({ ...chat, tier: 'Pro', taskType: 'report' })).rejects.toMatchObject({ reason: 'not_served' });
    await expect(t.router.route({ ...chat, tier: 'Free' })).resolves.toMatchObject({ model: 'good-b' });
    await expect(t.router.route(chat)).resolves.toMatchObject({ model: 'good-a' });
    expect(await t.router.isAvailableFor('Pro')).toBe(false);
    expect(await t.router.isAvailableFor('Free')).toBe(true);
    expect(alertKeys(t.deps)).toEqual([`${TIER_UNAVAILABLE_ALERT_DEDUPE_PREFIX}Pro`]);
    expect(t.deps.alert.mock.calls[0][0].detail).toContain('unknown task type "chta"');
  });

  it('isAvailableFor with an allowlist: every route must be inside it, as route() requires for a turn', async () => {
    // Free does not list the AgentWeb Model, so the load-time tier check skips it; only AgentWeb's own pin can run there.
    const t = makeDeps({ tiers: [{ name: 'Free', allowedModels: ['good-a'] }] });
    expect(await t.router.isAvailableFor('Free')).toBe(true);
    expect(await t.router.isAvailableFor('Free', ['good-a'])).toBe(false); // Free's default is good-b
    await expect(t.router.route({ tier: 'Free', taskType: 'chat', allowedModels: ['good-a'] })).rejects.toMatchObject({ reason: 'not_served' });
    expect(await t.router.isAvailableFor('Free', ['good-a', 'good-b'])).toBe(true);
    expect(await t.router.isAvailableFor('Free', ALL_MODELS)).toBe(true);
  });

  it('route reasons never name a tier (replies are readable by share viewers)', async () => {
    const t = makeDeps();
    for (const tier of ['Pro', 'Free', null]) {
      for (const taskType of ['chat', 'report', 'video'] as const) {
        const { reason } = await t.router.route({ tier, taskType, allowedModels: ALL_MODELS });
        expect(reason).not.toMatch(/Pro|Free/);
        expect(reason).toMatch(/^(chat|report|video) task: (plan|table) (route|default)$/);
      }
    }
  });

  it('a lasting partial fault re-alerts on each load (the sink dedupes) but logs only when it changes', async () => {
    const t = makeDeps({ table: JSON.stringify({ ...TABLE, routes: { report: 'admin-x' } }) });
    await t.router.route(chat);
    t.advance(61_000);
    await t.router.route(chat);
    expect(t.deps.alert).toHaveBeenCalledTimes(2);
    const faultLogs = t.deps.log.mock.calls.filter(([m]) => String(m).includes('unusable model'));
    expect(faultLogs).toHaveLength(1);
    expect(t.deps.info).toHaveBeenCalledWith('AgentWebModel: routing table loaded', { version: 'v1' });
  });

  it('an override naming no configured tier is reported, and nothing is taken down', async () => {
    const t = makeDeps({ tiers: [{ name: 'Pro', allowedModels: ['*'] }] });
    await expect(t.router.route({ ...chat, tier: 'Pro' })).resolves.toMatchObject({ model: 'good-c' });
    expect(alertKeys(t.deps)).toEqual([TABLE_ISSUES_ALERT_DEDUPE_KEY]);
  });

  it('a failed table read keeps the last good table; a cold-start failure is unavailable', async () => {
    const t = makeDeps();
    await t.router.route(chat);
    t.deps.getSetting.mockRejectedValue(new Error('dynamo down'));
    t.advance(61_000);
    await expect(t.router.route(chat)).resolves.toMatchObject({ model: 'good-a', tableVersion: 'v1' });
    expect(t.deps.alert).not.toHaveBeenCalled();

    const cold = makeDeps();
    cold.deps.readTierAllowlists.mockRejectedValue(new Error('tiers unreadable'));
    await expect(cold.router.route(chat)).rejects.toMatchObject({ reason: 'not_served' });
    expect(alertKeys(cold.deps)).toEqual([ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY]);
  });

  it('refuses (and alerts) a route outside the owner\'s live allowlist instead of running it', async () => {
    const t = makeDeps();
    await expect(t.router.route({ tier: 'Pro', taskType: 'chat', allowedModels: [AGENTWEB_MODEL_ID, 'good-a'] }))
      .rejects.toMatchObject({ requestedModel: AGENTWEB_MODEL_ID, reason: 'not_served' });
    expect(t.deps.alert).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: ROUTE_OUTSIDE_PLAN_ALERT_DEDUPE_KEY }));
    await expect(t.router.route({ tier: 'Pro', taskType: 'chat', allowedModels: [AGENTWEB_MODEL_ID, 'good-c'] }))
      .resolves.toMatchObject({ model: 'good-c' });
  });
});

describe('helpers', () => {
  it('isAgentWebModelId is exact (after trimming)', () => {
    expect(isAgentWebModelId('agentweb-model')).toBe(true);
    expect(isAgentWebModelId(' agentweb-model ')).toBe(true);
    for (const value of ['AgentWeb-Model', 'agentweb', ['agentweb-model'], null, undefined]) expect(isAgentWebModelId(value)).toBe(false);
  });

  it('taskTypeForSession: the session kinds AgentWeb already configures a model for', () => {
    expect(taskTypeForSession(null)).toBe('chat');
    expect(taskTypeForSession({ sessionType: 'regular' })).toBe('chat');
    expect(taskTypeForSession({ sessionType: 'predefined-work-plan' })).toBe('chat');
    expect(taskTypeForSession({ sessionType: 'scheduled' })).toBe('scheduled');
    expect(taskTypeForSession({ sessionType: 'report_generation' })).toBe('report');
    expect(taskTypeForSession({ sessionType: 'image-generation' })).toBe('image');
    expect(taskTypeForSession({ sessionType: 'video-generation' })).toBe('video');
    expect(taskTypeForSession({ sessionType: 'regular', portalType: 'emma-sidebar' })).toBe('support');
  });

  it('storedModelFor stores the selection, never the routed model', () => {
    expect(storedModelFor({ routedVia: AGENTWEB_MODEL_ID }, 'good-a')).toBe(AGENTWEB_MODEL_ID);
    expect(storedModelFor({}, 'good-a')).toBe('good-a');
    expect(storedModelFor(undefined, 'good-a')).toBe('good-a');
  });

  it('routingFieldsOf / messageRoutingOf only describe a routed decision for the model that ran', () => {
    const routed = { effectiveModel: 'good-a', routedVia: AGENTWEB_MODEL_ID as typeof AGENTWEB_MODEL_ID, routingReason: 'chat task: table default', tableVersion: 'v1' };
    expect(routingFieldsOf(routed)).toEqual({ routedVia: AGENTWEB_MODEL_ID, routingReason: 'chat task: table default', tableVersion: 'v1' });
    expect(routingFieldsOf({ effectiveModel: 'good-a' } as any)).toEqual({});
    expect(messageRoutingOf(routed, 'good-a')).toEqual({ llmSelected: AGENTWEB_MODEL_ID, llmRoutingReason: 'chat task: table default', llmRoutingTableVersion: 'v1' });
    expect(messageRoutingOf(routed, 'good-b')).toBeUndefined(); // a stale slot describing another turn
    expect(messageRoutingOf({ effectiveModel: 'good-a' }, 'good-a')).toBeUndefined();
  });
});

describe('the 422 copy for the AgentWeb Model never shows the raw id', () => {
  const body = (reason: 'not_served' | 'not_selectable' | 'not_in_plan', subject?: 'work_plan_pin', audience?: 'share_viewer') =>
    buildModelUnavailableBody(
      new ModelUnavailableError(AGENTWEB_MODEL_ID, reason, reason === 'not_in_plan' ? { model: AGENTWEB_MODEL_ID, tier: 'Free', allowedModels: ['gpt-5.5'], upgradeRequired: ['Pro'] } : undefined),
      undefined, subject, audience,
    );
  it('unavailable / not usable here: one plain sentence for owners and share viewers', () => {
    expect(body('not_served').error).toBe('AgentWeb Model isn\'t available right now. Choose another model to continue.');
    expect(body('not_served', undefined, 'share_viewer').error).toBe('AgentWeb Model isn\'t available right now. Choose another model to continue.');
    expect(body('not_selectable').error).toBe('AgentWeb Model can\'t be used here. Choose a specific model to continue.');
  });
  it('outside the plan and plan pins use the display name in the standard sentences; the id stays only in requestedModel', () => {
    for (const b of [body('not_in_plan'), body('not_served', 'work_plan_pin'), body('not_in_plan', undefined, 'share_viewer')]) {
      expect(b.error).toContain('(AgentWeb Model)');
      expect(b.error).not.toContain(AGENTWEB_MODEL_ID);
      expect(b.requestedModel).toBe(AGENTWEB_MODEL_ID);
    }
  });
});

describe('registryRouterCatalog (the real registry and price table)', () => {
  it('accepts a public, priced, tool-capable model and resolves legacy aliases', () => {
    expect(registryRouterCatalog.canonical('gpt-5.5')).toBe('gpt-5.5');
    expect(registryRouterCatalog.unsuitable('gpt-5.5')).toBeUndefined();
    expect(registryRouterCatalog.canonical('gpt-5.2-chat')).toBe('gpt-5.5');
    expect(registryRouterCatalog.canonical('agentweb-model')).toBeUndefined();
    expect(registryRouterCatalog.canonical('not-a-model')).toBeUndefined();
  });

  it('refuses admin-only, internal-only, live-voice and tool-less models', () => {
    expect(registryRouterCatalog.unsuitable('openrouter/anthropic/claude-sonnet-5.5')).toBe('admin-only');
    expect(registryRouterCatalog.unsuitable('openrouter/perplexity/sonar-pro-search')).toBe('internal-only');
    expect(registryRouterCatalog.unsuitable('gemini-3.1-flash-live-preview')).toBe('live voice');
  });
});
