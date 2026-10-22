/**
 * ENG-669 PR-C: the "AgentWeb Model" router.
 *
 * `agentweb-model` is a selectable model id like any other. A user who picks it chose the router, so routing is not a
 * swap: AgentWeb picks the concrete model for the task, records which one and why, and runs exactly that model. If the
 * routed model fails, the run errors visibly; nothing is retried on another model.
 *
 * The id is NOT a registry key (callLLM never accepts it). It is stored as the selection (session.llmModel, schedule
 * and plan pins) and turned into a concrete model per turn by `routeAgentWebModel`. The selection is what the tier
 * allowlist checks (modelAccess.ts reserves the id); the routed model is AgentWeb's choice (provenance 'system'),
 * constrained instead by the table rules below.
 *
 * v0 routing is a deterministic table, task type -> model, with optional per-tier overrides. Task type is the session
 * kind PR-A's system-default exemption already distinguishes (`taskTypeForSession`): no classifier.
 *
 * Switch: AW-Settings `agentweb_model_router_enabled`, ONLY the exact string 'true'; absent / any other value / a
 * cold-start read failure => off, and nothing here is read: the id is not offered and a selection of it is refused
 * exactly like any unknown id (byte-identical to before). Cached ~60s, last-known value on a failed refresh.
 *
 * Table: AW-Settings `agentweb_model_routing_table` (JSON, see `parseRoutingTable`), validated when it is loaded, with
 * the damage of a bad entry kept as narrow as possible (a mistake for one plan must not take the router away from
 * every customer):
 *  - a table that cannot be parsed at all (not JSON, wrong shape, unknown keys / task types, no version / default) makes
 *    the router UNAVAILABLE for everyone;
 *  - a target that is not a registered, publicly selectable (not admin-only, internal-only or live voice), priced,
 *    tool-capable model makes only the ROUTES that resolve to it unavailable;
 *  - a tier that may select the router but whose allowlist does not cover one of its resolved routes makes the router
 *    unavailable for THAT tier only (it can never route a tier to a model its plan excludes).
 * Unavailable always means a visible 422 `model_unavailable` on selection plus one deduped on-call alert naming what is
 * broken, never a silent pick of something else (a broken route does not fall through to the next rule). Cached ~60s,
 * the last good table kept on a failed read (same pattern as the switch).
 *
 * No dependency on the service graph (unit-testable); the process-wide instance lives in agentWebModelRouterInstance.ts.
 */
import { ALL_MODELS, normalizeAllowedModels, type AllowedModels, type TierModelsConfig } from './modelAccess';
import { ModelUnavailableError } from './modelUnavailable';
import { AGENTWEB_MODEL_DISPLAY_NAME, AGENTWEB_MODEL_ID } from './agentWebModelIds';

export { AGENTWEB_MODEL_DISPLAY_NAME, AGENTWEB_MODEL_ID };

export const AGENTWEB_MODEL_ROUTER_SETTING = 'agentweb_model_router_enabled';
export const AGENTWEB_MODEL_ROUTING_TABLE_SETTING = 'agentweb_model_routing_table';

/**
 * v0 task types: the session kinds AgentWeb already configures a model for (see modelAccessInstance.isSystemChosen):
 * scheduled runs, report generation, image / video generation, customer support (emma-sidebar), and plain chat.
 */
export const AGENTWEB_TASK_TYPES = ['chat', 'scheduled', 'report', 'image', 'video', 'support'] as const;
export type AgentWebTaskType = typeof AGENTWEB_TASK_TYPES[number];

const CACHE_TTL_MS = 60_000;
/** After a failed refresh, retry sooner than a full window but not on every request. */
const ERROR_RETRY_MS = 5_000;
const ALERT_WINDOW_MS = 60 * 60 * 1000;
/** The whole table is unusable (unparseable, missing, unreadable). */
export const ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY = 'agentweb_model_router:unavailable';
/** Per model: a target that cannot be routed to (`${prefix}${model}`). */
export const ROUTE_TARGET_ALERT_DEDUPE_PREFIX = 'agentweb_model_router:target:';
/** Per tier: its allowlist does not cover its routes (`${prefix}${tier}`). */
export const TIER_UNAVAILABLE_ALERT_DEDUPE_PREFIX = 'agentweb_model_router:tier:';
/** Override keys that name no configured tier (nothing is unavailable; they just never apply). */
export const TABLE_ISSUES_ALERT_DEDUPE_KEY = 'agentweb_model_router:table_issues';
export const ROUTE_OUTSIDE_PLAN_ALERT_DEDUPE_KEY = 'agentweb_model_router:route_outside_plan';

/** Whether a model id (request body, stored selection, pin) is the router's. Exact, after trimming. */
export function isAgentWebModelId(value: unknown): value is typeof AGENTWEB_MODEL_ID {
  return typeof value === 'string' && value.trim() === AGENTWEB_MODEL_ID;
}

/** The task type of a turn in this session (no session = plain chat). */
export function taskTypeForSession(
  session?: { sessionType?: string | null; portalType?: string | null } | null,
): AgentWebTaskType {
  if (session?.portalType === 'emma-sidebar') return 'support';
  switch (session?.sessionType) {
    case 'scheduled': return 'scheduled';
    case 'report_generation': return 'report';
    case 'image-generation': return 'image';
    case 'video-generation': return 'video';
    default: return 'chat';
  }
}

type TaskRoutes = Partial<Record<AgentWebTaskType, string>>;

export interface RoutingTable {
  version: string;
  /** The model for any task type without its own route. */
  default: string;
  routes: TaskRoutes;
  /** Per-tier overrides, keyed by subscription tier name. */
  tiers: Record<string, { default?: string; routes: TaskRoutes }>;
}

/** Registry facts the table validation needs (the instance wires the real registry and price table). */
export interface RouterModelCatalog {
  /** The canonical registry id (legacy aliases resolved), or undefined when the id is not a registry model. */
  canonical(id: string): string | undefined;
  /** Why a canonical registry id cannot be a route target (e.g. 'admin-only'), or undefined when it can. */
  unsuitable(id: string): string | undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The table as stored:
 * ```json
 * { "version": "2026-10-20.1",
 *   "default": "gemini-3.8-flash",
 *   "routes": { "report": "gpt-5.5", "image": "gemini-3.8-flash" },
 *   "tiers": { "Free": { "default": "gemini-3.1-flash-lite" }, "Pro": { "routes": { "chat": "gpt-5.5" } } } }
 * ```
 * A turn takes the first of: its tier's route for the task type, its tier's default, the table route for the task
 * type, the table default.
 *
 * Three kinds of problem, each contained as narrowly as it can be:
 *  - `errors` (the table cannot be used at all): not an object, unknown top-level keys, a `routes` that is not an
 *    object of known task types, a `tiers` that is not an object, no version, no default, a non-string target in the
 *    table's own routes or default;
 *  - `malformedTiers` (tier -> what is wrong): one tier override that is not an object, has unknown keys or task types,
 *    or a non-string / empty target. Only that tier is unavailable; a typo for one plan never breaks the others;
 *  - `invalidTargets` (model -> why): a model id that cannot be routed to (unregistered, `catalog.unsuitable`): only the
 *    routes resolving to it are unavailable.
 * Valid targets are stored canonically (legacy aliases resolved).
 */
export function parseRoutingTable(
  raw: unknown,
  catalog: RouterModelCatalog,
):
  | { ok: true; table: RoutingTable; invalidTargets: Record<string, string>; malformedTiers: Record<string, string[]> }
  | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) return { ok: false, errors: ['the table must be a JSON object'] };

  /** Reads one scope (the table, or one tier override) into its own error and unusable-target sinks. */
  const reader = (errors: string[], invalidTargets: Record<string, string>) => {
    const target = (where: string, value: unknown): string | undefined => {
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`${where} must be a model id`);
        return undefined;
      }
      const id = value.trim();
      const canonical = catalog.canonical(id);
      if (!canonical) {
        invalidTargets[id] = 'not a registered model';
        return id;
      }
      const why = catalog.unsuitable(canonical);
      if (why) invalidTargets[canonical] = why;
      return canonical;
    };
    const routesOf = (where: string, value: unknown): TaskRoutes => {
      const routes: TaskRoutes = {};
      if (value === undefined) return routes;
      if (!isPlainObject(value)) {
        errors.push(`${where} must be an object of task type -> model`);
        return routes;
      }
      for (const [taskType, model] of Object.entries(value)) {
        if (!(AGENTWEB_TASK_TYPES as readonly string[]).includes(taskType)) {
          errors.push(`${where}: unknown task type "${taskType}" (expected one of ${AGENTWEB_TASK_TYPES.join(', ')})`);
          continue;
        }
        const id = target(`${where}.${taskType}`, model);
        if (id) routes[taskType as AgentWebTaskType] = id;
      }
      return routes;
    };
    const unknownKeys = (where: string, value: Record<string, unknown>, allowed: string[]) => {
      for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${where}: unknown key "${key}"`);
    };
    return { target, routesOf, unknownKeys };
  };

  const errors: string[] = [];
  const invalidTargets: Record<string, string> = {};
  const top = reader(errors, invalidTargets);
  top.unknownKeys('table', raw, ['version', 'default', 'routes', 'tiers']);
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? String(raw.version)
    : typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!version) errors.push('version is required');
  const fallback = top.target('default', raw.default);
  const routes = top.routesOf('routes', raw.routes);
  const tiers: RoutingTable['tiers'] = {};
  const malformedTiers: Record<string, string[]> = {};
  if (raw.tiers !== undefined) {
    if (!isPlainObject(raw.tiers)) {
      errors.push('tiers must be an object of tier name -> overrides');
    } else {
      for (const [tierName, override] of Object.entries(raw.tiers)) {
        const tierErrors: string[] = [];
        const tierInvalid: Record<string, string> = {};
        const inTier = reader(tierErrors, tierInvalid);
        if (!isPlainObject(override)) {
          malformedTiers[tierName] = [`tiers.${tierName} must be an object`];
          continue;
        }
        inTier.unknownKeys(`tiers.${tierName}`, override, ['default', 'routes']);
        const tierDefault = override.default === undefined ? undefined : inTier.target(`tiers.${tierName}.default`, override.default);
        const tierRoutes = inTier.routesOf(`tiers.${tierName}.routes`, override.routes);
        if (tierErrors.length > 0) {
          malformedTiers[tierName] = tierErrors;
          continue;
        }
        Object.assign(invalidTargets, tierInvalid);
        tiers[tierName] = { ...(tierDefault && { default: tierDefault }), routes: tierRoutes };
      }
    }
  }
  if (errors.length > 0 || !fallback) return { ok: false, errors };
  return { ok: true, table: { version, default: fallback, routes, tiers }, invalidTargets, malformedTiers };
}

/**
 * The table's model for one turn, and which rule chose it. Pure; never falls past the first matching rule. The reason
 * names the task type and the KIND of rule only ("plan" = the owner's tier override), never a tier name: it is stored
 * on replies that share viewers can read, and a viewer must not learn the owner's plan (logs carry the tier).
 */
export function routeFor(table: RoutingTable, tier: string | null, taskType: AgentWebTaskType): { model: string; reason: string } {
  const override = tier ? table.tiers[tier] : undefined;
  if (override?.routes[taskType]) return { model: override.routes[taskType]!, reason: `${taskType} task: plan route` };
  if (override?.default) return { model: override.default, reason: `${taskType} task: plan default` };
  if (table.routes[taskType]) return { model: table.routes[taskType]!, reason: `${taskType} task: table route` };
  return { model: table.default, reason: `${taskType} task: table default` };
}

/**
 * The tier-allowlist rule, checked per tier. Only tiers whose allowlist names `agentweb-model` can select the router, so
 * only they are checked (a wildcard or absent allowlist allows every model, so nothing can fall outside it). For each
 * such tier, every task type's resolved route must be in its allowlist; a route to an unusable target is skipped here
 * (that route is refused on its own, see `invalidTargets`), so it never takes the whole tier down. Returns the tiers that
 * break the rule (tier -> the task -> model pairs outside the plan) and table issues that take nothing down (an override
 * key that names no configured tier, so it never applies).
 */
export function checkTiers(
  table: RoutingTable,
  tiers: readonly TierModelsConfig[],
  normalizeModelId: (id: string) => string,
  invalidTargets: Readonly<Record<string, string>> = {},
): { unavailableTiers: Record<string, string>; issues: string[] } {
  const unavailableTiers: Record<string, string> = {};
  const issues: string[] = [];
  const names = new Set(tiers.filter((t) => t && typeof t.name === 'string').map((t) => t.name));
  for (const tierName of Object.keys(table.tiers)) {
    if (!names.has(tierName)) issues.push(`tiers.${tierName}: no subscription tier has this name, so this override never applies`);
  }
  for (const tier of tiers) {
    if (!tier || typeof tier.name !== 'string') continue;
    const allowed = normalizeAllowedModels(tier.allowedModels, normalizeModelId);
    if (allowed === ALL_MODELS || !allowed.includes(AGENTWEB_MODEL_ID)) continue;
    const outside: string[] = [];
    for (const taskType of AGENTWEB_TASK_TYPES) {
      const { model } = routeFor(table, tier.name, taskType);
      if (!invalidTargets[model] && !allowed.includes(model)) outside.push(`${taskType} -> "${model}"`);
    }
    if (outside.length > 0) {
      unavailableTiers[tier.name] = `its allowedModels list ${AGENTWEB_MODEL_ID} but not the model(s) its routes use: ${outside.join(', ')}`;
    }
  }
  return { unavailableTiers, issues };
}

export interface AgentWebModelRoute {
  /** The concrete registry model that runs. */
  model: string;
  /** Which table rule chose it (logged, stored on the decision, shown on the message). */
  reason: string;
  tableVersion: string;
}

export interface AgentWebModelRouterDeps {
  getSetting(name: string): Promise<{ settingValue?: unknown } | null>;
  catalog: RouterModelCatalog;
  /**
   * Every configured tier with its raw allowedModels, or null when the tier allowlist is off (no plan narrows any
   * model, so there is nothing to intersect with). THROWS when the tiers cannot be read.
   */
  readTierAllowlists(): Promise<TierModelsConfig[] | null>;
  normalizeModelId(id: string): string;
  /** Deduped by the caller-supplied key; must not throw. */
  alert(input: { subject: string; detail: string; dedupeKey: string; dedupeWindowMs: number }): Promise<unknown>;
  now(): number;
  /** Faults and refusals. */
  log(message: string, fields?: Record<string, unknown>): void;
  /** Routine information (a table loaded). */
  info(message: string, fields?: Record<string, unknown>): void;
}

type TableState =
  | {
      status: 'ready';
      table: RoutingTable;
      /** Targets no route may use (model -> why): the routes resolving to one are unavailable. */
      invalidTargets: Record<string, string>;
      /** Tiers the router is unavailable for (tier -> why). */
      unavailableTiers: Record<string, string>;
    }
  | { status: 'unavailable'; why: 'missing' | 'invalid' | 'unreadable'; errors?: string[] };

const REFUSAL_FOOTER =
  `While ${AGENTWEB_MODEL_ROUTER_SETTING} is on, the affected selections of the AgentWeb Model are refused with ` +
  `model_unavailable (nothing is sent to a different model). Fix the table (or the tier's allowedModels), or turn the switch off.`;

export function createAgentWebModelRouter(deps: AgentWebModelRouterDeps) {
  // ---- switch (same shape as modelAccess.ts / workPlanStepModels.ts) ----
  let enabled = false; // last successfully read value; cold start => off
  let switchValidUntil = 0;
  let switchInFlight: Promise<void> | null = null;

  async function refreshSwitch(now: number): Promise<void> {
    try {
      const row = await deps.getSetting(AGENTWEB_MODEL_ROUTER_SETTING);
      enabled = row?.settingValue === 'true';
      switchValidUntil = now + CACHE_TTL_MS;
    } catch (error) {
      deps.log('AgentWebModel: failed to read the router switch; keeping last-known value (off if none)', {
        errorClass: (error as Error)?.name ?? 'Error',
        enabled,
      });
      switchValidUntil = now + ERROR_RETRY_MS;
    }
  }

  async function isEnabled(): Promise<boolean> {
    const now = deps.now();
    if (now >= switchValidUntil) {
      switchInFlight ??= refreshSwitch(now).finally(() => { switchInFlight = null; });
      await switchInFlight;
    }
    return enabled;
  }

  // ---- table: validated on load, last good state kept on a failed read ----
  let state: TableState | null = null;
  let tableValidUntil = 0;
  let tableInFlight: Promise<void> | null = null;

  function alert(subject: string, detail: string, dedupeKey: string): void {
    void deps.alert({ subject, detail, dedupeKey, dedupeWindowMs: ALERT_WINDOW_MS })
      .catch(() => { /* the alert sink must never fail a turn */ });
  }

  function unavailable(why: 'missing' | 'invalid' | 'unreadable', errors?: string[]): TableState {
    const detail = why === 'missing'
      ? `The ${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} setting is absent or empty.`
      : why === 'unreadable'
        ? `The ${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} setting (or the subscription tiers) could not be read and no table was loaded before.`
        : `The ${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} setting cannot be used:\n- ${(errors ?? []).join('\n- ')}`;
    lastReport = '';
    deps.log('AgentWebModel: routing table unavailable; every selection of the AgentWeb Model is refused', { why, errors });
    alert('AgentMode: AgentWeb Model router unavailable', `${detail}\n\nThis affects EVERY tier. ${REFUSAL_FOOTER}`, ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY);
    return { status: 'unavailable', why, ...(errors && { errors }) };
  }

  /** What the last load reported, so a problem that persists across reloads is logged once (alerts dedupe in the sink). */
  let lastReport = '';

  /**
   * One alert per broken target (naming the routes that use it) and per unavailable tier (naming its models). Alerts go
   * out on every load (the sink dedupes them per hour, so a lasting fault re-pages hourly); logs only when what is
   * broken changes.
   */
  function reportPartial(table: RoutingTable, invalidTargets: Record<string, string>, unavailableTiers: Record<string, string>, issues: string[]): void {
    const report = JSON.stringify([table.version, invalidTargets, unavailableTiers, issues]);
    const changed = report !== lastReport;
    lastReport = report;
    const log = (message: string, fields: Record<string, unknown>) => { if (changed) deps.log(message, fields); };
    for (const [model, why] of Object.entries(invalidTargets)) {
      log('AgentWebModel: routes to an unusable model are unavailable', { model, why, version: table.version });
      alert(
        `AgentMode: AgentWeb Model route target "${model}" unusable`,
        `Routing table ${table.version} routes to "${model}", which cannot be routed to (${why}). Every route that resolves to it ` +
        `is unavailable; other routes keep working.\n\n${REFUSAL_FOOTER}`,
        `${ROUTE_TARGET_ALERT_DEDUPE_PREFIX}${model}`,
      );
    }
    for (const [tier, why] of Object.entries(unavailableTiers)) {
      log('AgentWebModel: router unavailable for a tier', { tier, why, version: table.version });
      alert(
        `AgentMode: AgentWeb Model unavailable for tier "${tier}"`,
        `Tier "${tier}" ${why}. The router is unavailable for this tier's owners (routing table ${table.version}); other tiers keep ` +
        `working.\n\n${REFUSAL_FOOTER}`,
        `${TIER_UNAVAILABLE_ALERT_DEDUPE_PREFIX}${tier}`,
      );
    }
    if (issues.length > 0) {
      log('AgentWebModel: routing table issues (nothing unavailable)', { issues, version: table.version });
      alert(
        'AgentMode: AgentWeb Model routing table issues',
        `Routing table ${table.version}:\n- ${issues.join('\n- ')}\n\nNothing is unavailable because of these, but the overrides never apply.`,
        TABLE_ISSUES_ALERT_DEDUPE_KEY,
      );
    }
  }

  async function refreshTable(now: number): Promise<void> {
    let row: { settingValue?: unknown } | null;
    let tiers: TierModelsConfig[] | null;
    try {
      [row, tiers] = await Promise.all([deps.getSetting(AGENTWEB_MODEL_ROUTING_TABLE_SETTING), deps.readTierAllowlists()]);
    } catch (error) {
      deps.log('AgentWebModel: failed to read the routing table; keeping the last-known table', {
        errorClass: (error as Error)?.name ?? 'Error',
        known: state?.status ?? 'none',
      });
      if (!state) state = unavailable('unreadable');
      tableValidUntil = now + ERROR_RETRY_MS;
      return;
    }
    tableValidUntil = now + CACHE_TTL_MS;
    const value = row?.settingValue;
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
      state = unavailable('missing');
      return;
    }
    let raw: unknown = value;
    if (typeof value === 'string') {
      try {
        raw = JSON.parse(value);
      } catch {
        state = unavailable('invalid', ['the setting is not valid JSON']);
        return;
      }
    }
    const parsed = parseRoutingTable(raw, deps.catalog);
    if (!parsed.ok) {
      state = unavailable('invalid', parsed.errors);
      return;
    }
    const checked = tiers
      ? checkTiers(parsed.table, tiers, deps.normalizeModelId, parsed.invalidTargets)
      : { unavailableTiers: {}, issues: [] };
    // A malformed override takes down only its own tier (and is reported as such, whatever the allowlist says).
    const unavailableTiers: Record<string, string> = { ...checked.unavailableTiers };
    for (const [tier, tierErrors] of Object.entries(parsed.malformedTiers)) {
      unavailableTiers[tier] = `has a malformed override in the routing table: ${tierErrors.join('; ')}`;
    }
    reportPartial(parsed.table, parsed.invalidTargets, unavailableTiers, checked.issues);
    if (state?.status !== 'ready' || state.table.version !== parsed.table.version) {
      deps.info('AgentWebModel: routing table loaded', { version: parsed.table.version });
    }
    state = { status: 'ready', table: parsed.table, invalidTargets: parsed.invalidTargets, unavailableTiers };
  }

  async function getTableState(): Promise<TableState> {
    const now = deps.now();
    if (now >= tableValidUntil) {
      tableInFlight ??= refreshTable(now).finally(() => { tableInFlight = null; });
      await tableInFlight;
    }
    return state ?? { status: 'unavailable', why: 'unreadable' };
  }

  /**
   * The concrete model for one turn. Callers check `isEnabled()` first. Throws ModelUnavailableError(`not_served`)
   * for the AgentWeb Model when the table is unusable, the router is unavailable for this tier, the route resolves to
   * an unusable target (never falling through to another rule), or the route is outside the owner's live allowlist
   * (`allowedModels`: '*' when the tier allowlist is off). The tier check at load makes the last one a config race
   * (an allowlist edited after the table loaded); it is refused and alerted, never run.
   */
  async function route(input: { tier: string | null; taskType: AgentWebTaskType; allowedModels: AllowedModels }): Promise<AgentWebModelRoute> {
    const current = await getTableState();
    if (current.status !== 'ready') throw new ModelUnavailableError(AGENTWEB_MODEL_ID, 'not_served');
    if (input.tier && current.unavailableTiers[input.tier]) throw new ModelUnavailableError(AGENTWEB_MODEL_ID, 'not_served');
    const { model, reason } = routeFor(current.table, input.tier, input.taskType);
    if (current.invalidTargets[model]) throw new ModelUnavailableError(AGENTWEB_MODEL_ID, 'not_served');
    if (input.allowedModels !== ALL_MODELS && !input.allowedModels.includes(model)) {
      deps.log('AgentWebModel: route is outside the owner\'s plan; refused', { tier: input.tier, taskType: input.taskType, model });
      alert(
        'AgentMode: AgentWeb Model routed outside a plan',
        `Routing table ${current.table.version} sends tier "${input.tier ?? 'unknown'}" ${input.taskType} tasks to "${model}", which ` +
        `that tier's allowedModels does not include. The turn was refused (nothing ran on another model). Align the table ` +
        `with the tier's allowedModels.`,
        ROUTE_OUTSIDE_PLAN_ALERT_DEDUPE_KEY,
      );
      throw new ModelUnavailableError(AGENTWEB_MODEL_ID, 'not_served');
    }
    return { model, reason, tableVersion: current.table.version };
  }

  /**
   * Whether the router is currently valid for this tier (null = no tier override applies): the table is usable, the
   * tier is not unavailable, and every route the tier can take resolves to a usable target. The pickers offer the
   * AgentWeb Model only then.
   * `allowedModels` (default: every model) also requires every route to be inside that allowlist, as `route` does for
   * a turn: the load-time tier check covers only tiers that list the AgentWeb Model, so for a tier that does not (where
   * only AgentWeb's own pin of it can run) this is what says whether such a pin runs.
   */
  async function isAvailableFor(tier: string | null, allowedModels: AllowedModels = ALL_MODELS): Promise<boolean> {
    const current = await getTableState();
    if (current.status !== 'ready') return false;
    if (tier && current.unavailableTiers[tier]) return false;
    return AGENTWEB_TASK_TYPES.every((taskType) => {
      const { model } = routeFor(current.table, tier, taskType);
      return !current.invalidTargets[model] && (allowedModels === ALL_MODELS || allowedModels.includes(model));
    });
  }

  /** Forget the switch and the table (tests). */
  function reset(): void {
    enabled = false;
    switchValidUntil = 0;
    switchInFlight = null;
    state = null;
    tableValidUntil = 0;
    tableInFlight = null;
  }

  return { isEnabled, isAvailableFor, route, getTableState, reset };
}

export type AgentWebModelRouter = ReturnType<typeof createAgentWebModelRouter>;

/** The router's provenance on a model-policy decision (absent = the selection was a concrete model). */
export interface ModelRouting {
  routedVia: typeof AGENTWEB_MODEL_ID;
  routingReason: string;
  tableVersion: string;
}

/**
 * The model to STORE for a turn that runs `ranModel` under `decision` (session.llmModel, the engine's step stamps): the
 * selection. A routed decision stores `agentweb-model`, never the concrete model it routed to (that is the user's pick,
 * and storing the routed model would turn the next turn into a pick of that model); otherwise the model that ran.
 */
export function storedModelFor(decision: { routedVia?: string | null } | null | undefined, ranModel: string): string {
  return decision?.routedVia === AGENTWEB_MODEL_ID ? AGENTWEB_MODEL_ID : ranModel;
}

/** The routing fields of a decision, for spreading into a stored decision or a response body ({} when not routed). */
export function routingFieldsOf(decision: Partial<ModelRouting> | null | undefined): Partial<ModelRouting> {
  if (decision?.routedVia !== AGENTWEB_MODEL_ID) return {};
  return { routedVia: AGENTWEB_MODEL_ID, routingReason: decision.routingReason ?? '', tableVersion: decision.tableVersion ?? '' };
}

/** What an assistant message carries when its model was routed: the selection and why (next to the concrete `llm`). */
export interface MessageModelRouting {
  llmSelected: typeof AGENTWEB_MODEL_ID;
  llmRoutingReason: string;
  llmRoutingTableVersion: string;
}

/** The message stamp for a turn that ran `modelThatRan` under `decision`, or undefined when it was not routed there. */
export function messageRoutingOf(
  decision: Partial<ModelRouting> & { effectiveModel?: string | null } | null | undefined,
  modelThatRan: string | null | undefined,
): MessageModelRouting | undefined {
  if (decision?.routedVia !== AGENTWEB_MODEL_ID || !modelThatRan || decision.effectiveModel !== modelThatRan) return undefined;
  return { llmSelected: AGENTWEB_MODEL_ID, llmRoutingReason: decision.routingReason ?? '', llmRoutingTableVersion: decision.tableVersion ?? '' };
}
