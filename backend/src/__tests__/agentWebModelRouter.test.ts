/**
 * ENG-669 PR-C: the AgentWeb Model router (services/agentMode/agentWebModelRouter.ts), pure.
 *
 * Contract: switch `agentweb_model_router_enabled` exact 'true' = on, anything else / cold-start failure = off. The
 * routing table (`agentweb_model_routing_table`) is validated at load: every target a registered, publicly selectable,
 * priced, tool-capable model, and inside the allowlist of every tier that may select the router. An invalid, missing or
 * unreadable table makes the router unavailable (model_unavailable, one deduped alert), never a silent pick of another
 * model; a failed refresh keeps the last good table. Routing is deterministic: tier route > tier default > table route >
 * table default.
 */
import {
  AGENTWEB_MODEL_ID,
  AGENTWEB_MODEL_ROUTER_SETTING,
  AGENTWEB_MODEL_ROUTING_TABLE_SETTING,
  ROUTE_OUTSIDE_PLAN_ALERT_DEDUPE_KEY,
  ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY,
  checkTableAgainstTiers,
  createAgentWebModelRouter,
  isAgentWebModelId,
  messageRoutingOf,
  parseRoutingTable,
  routeFor,
  routingFieldsOf,
  selectionOf,
  taskTypeForSession,
  type AgentWebModelRouterDeps,
  type RouterModelCatalog,
} from '../services/agentMode/agentWebModelRouter';
import { registryRouterCatalog } from '../services/agentMode/agentWebModelRouterInstance';
import { ALL_MODELS, type TierModelsConfig } from '../services/agentMode/modelAccess';
import { ModelUnavailableError } from '../services/agentMode/modelUnavailable';

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
    });
  });

  it.each([
    ['admin-x', 'admin-only'],
    ['internal-x', 'internal-only'],
    ['live-x', 'live voice'],
    ['unpriced-x', 'unpriced'],
    ['notools-x', 'cannot call tools'],
  ])('refuses a target that is %s (%s), wherever it appears', (model, why) => {
    for (const table of [
      { ...TABLE, default: model },
      { ...TABLE, routes: { chat: model } },
      { ...TABLE, tiers: { Pro: { default: model } } },
      { ...TABLE, tiers: { Pro: { routes: { video: model } } } },
    ]) {
      const parsed = parseRoutingTable(table, catalog);
      expect(parsed.ok).toBe(false);
      expect((parsed as any).errors.join(' ')).toContain(why);
    }
  });

  it('refuses an unregistered target, a missing default, a missing version, unknown keys and unknown task types', () => {
    const cases: Array<[unknown, string]> = [
      [{ ...TABLE, default: 'gpt-nope' }, 'not a registered model'],
      [{ version: 'v1' }, 'default must be a model id'],
      [{ ...TABLE, version: ' ' }, 'version is required'],
      [{ ...TABLE, defualt: 'good-a' }, 'unknown key "defualt"'],
      [{ ...TABLE, routes: { reports: 'good-a' } }, 'unknown task type "reports"'],
      [{ ...TABLE, tiers: { Pro: { route: {} } } }, 'unknown key "route"'],
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

describe('routeFor: tier route > tier default > table route > table default', () => {
  const table = (parseRoutingTable(TABLE, catalog) as any).table;
  it.each([
    ['Pro', 'chat', 'good-c', 'chat task: tier "Pro" route'],
    ['Pro', 'report', 'good-b', 'report task: table route'],
    ['Free', 'report', 'good-b', 'report task: tier "Free" default'],
    ['Free', 'chat', 'good-b', 'chat task: tier "Free" default'],
    [null, 'report', 'good-b', 'report task: table route'],
    [null, 'scheduled', 'good-a', 'scheduled task: table default'],
    ['Unknown', 'chat', 'good-a', 'chat task: table default'],
  ])('tier %s, %s task -> %s', (tier, taskType, model, reason) => {
    expect(routeFor(table, tier as any, taskType as any)).toEqual({ model, reason });
  });
});

describe('checkTableAgainstTiers: the router never routes a tier to a model its plan excludes', () => {
  const table = (parseRoutingTable(TABLE, catalog) as any).table;
  const id = (x: string) => x;

  it('passes when every route of every router tier is in its allowlist (wildcards and absent fields allow all)', () => {
    const tiers: TierModelsConfig[] = [
      { name: 'Free', allowedModels: [AGENTWEB_MODEL_ID, 'good-b'] },
      { name: 'Pro', allowedModels: ['*'] },
      { name: 'Team' },
    ];
    expect(checkTableAgainstTiers(table, tiers, id)).toEqual([]);
  });

  it('flags each route outside a router tier\'s allowlist', () => {
    const tiers: TierModelsConfig[] = [
      { name: 'Free', allowedModels: [AGENTWEB_MODEL_ID, 'good-a'] }, // Free routes everything to good-b
      { name: 'Pro', allowedModels: [AGENTWEB_MODEL_ID, 'good-c', 'good-a'] }, // Pro reports go to good-b
    ];
    const errors = checkTableAgainstTiers(table, tiers, id);
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('tier "Free" may select agentweb-model, but its chat route "good-b"'),
      expect.stringContaining('tier "Pro" may select agentweb-model, but its report route "good-b"'),
    ]));
    expect(errors.filter((e) => e.includes('"Free"'))).toHaveLength(6);
  });

  it('ignores a tier that cannot select the router', () => {
    const tiers: TierModelsConfig[] = [{ name: 'Free', allowedModels: ['good-a'] }, { name: 'Pro', allowedModels: ['*'] }];
    expect(checkTableAgainstTiers(table, tiers, id)).toEqual([]);
  });

  it('refuses an override for a tier that does not exist (a typo would silently get the table routes)', () => {
    expect(checkTableAgainstTiers(table, [{ name: 'Pro', allowedModels: ['*'] }], id))
      .toEqual(['tiers.Free: no subscription tier has this name']);
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
      alert: jest.fn(async () => undefined),
      now: () => now,
      log: jest.fn(),
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
    expect(await t.router.route({ ...chat, tier: 'Pro' })).toEqual({ model: 'good-c', reason: 'chat task: tier "Pro" route', tableVersion: 'v1' });
    await t.router.route(chat);
    const tableReads = t.deps.getSetting.mock.calls.filter(([n]) => n === AGENTWEB_MODEL_ROUTING_TABLE_SETTING);
    expect(tableReads).toHaveLength(1);
  });

  it.each([
    ['missing', undefined, 'absent or empty'],
    ['not JSON', '{nope', 'not valid JSON'],
    ['invalid', JSON.stringify({ ...TABLE, default: 'admin-x' }), 'admin-only'],
  ])('a %s table makes the router unavailable (not_served) with ONE alert, never a fallback', async (_label, table, detail) => {
    const t = makeDeps({ table });
    for (let i = 0; i < 3; i++) {
      const error = await t.router.route(chat).catch((e) => e);
      expect(error).toBeInstanceOf(ModelUnavailableError);
      expect(error).toMatchObject({ requestedModel: AGENTWEB_MODEL_ID, reason: 'not_served' });
    }
    expect(await t.router.isAvailable()).toBe(false);
    expect(t.deps.alert).toHaveBeenCalledTimes(1);
    expect(t.deps.alert).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY,
      detail: expect.stringContaining(detail),
    }));
  });

  it('a table that routes a router tier outside its allowlist is invalid (tier allowlist on)', async () => {
    const t = makeDeps({ tiers: [{ name: 'Free', allowedModels: [AGENTWEB_MODEL_ID, 'good-a'] }, { name: 'Pro', allowedModels: ['*'] }] });
    await expect(t.router.route(chat)).rejects.toMatchObject({ reason: 'not_served' });
    expect(t.deps.alert).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining('tier "Free" may select agentweb-model') }));
    // Fixing the tier (allowing what the table routes it to) makes the router available on the next load.
    t.setTiers([{ name: 'Free', allowedModels: [AGENTWEB_MODEL_ID, 'good-b'] }, { name: 'Pro', allowedModels: ['*'] }]);
    t.advance(61_000);
    await expect(t.router.route({ ...chat, tier: 'Free' })).resolves.toMatchObject({ model: 'good-b' });
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
    expect(cold.deps.alert).toHaveBeenCalledTimes(1);
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

  it('selectionOf stores the selection, never the routed model', () => {
    expect(selectionOf({ effectiveModel: 'good-a', routedVia: AGENTWEB_MODEL_ID })).toBe(AGENTWEB_MODEL_ID);
    expect(selectionOf({ effectiveModel: 'good-a' })).toBe('good-a');
    expect(selectionOf({ effectiveModel: null })).toBeNull();
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
