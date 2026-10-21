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
 * Table: AW-Settings `agentweb_model_routing_table` (JSON, see `parseRoutingTable`). Every target is validated when the
 * table is loaded: a registry model (legacy aliases resolved), publicly selectable (not admin-only, internal-only or
 * live voice), priced, able to call tools, and inside the allowlist of every tier that may select the router (so the
 * router can never route a tier to a model its plan excludes). An invalid, missing or unreadable table makes the router
 * UNAVAILABLE (a visible 422 `model_unavailable` on selection, one deduped on-call alert), never a silent pick of
 * something else. Cached ~60s with the last good table kept on a failed read (same pattern as the switch).
 *
 * No dependency on the service graph (unit-testable); the process-wide instance lives in agentWebModelRouterInstance.ts.
 */
import { ALL_MODELS, AGENTWEB_MODEL_ID, normalizeAllowedModels, type AllowedModels, type TierModelsConfig } from './modelAccess';
import { ModelUnavailableError } from './modelUnavailable';

export { AGENTWEB_MODEL_ID };

export const AGENTWEB_MODEL_ROUTER_SETTING = 'agentweb_model_router_enabled';
export const AGENTWEB_MODEL_ROUTING_TABLE_SETTING = 'agentweb_model_routing_table';
/** Shown in the picker and in "AgentWeb Model · via X". */
export const AGENTWEB_MODEL_DISPLAY_NAME = 'AgentWeb Model';

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
export const ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY = 'agentweb_model_router:unavailable';
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
 * type, the table default. Unknown keys and unknown task types are refused (a typo must not silently fall through
 * to the default); every target must pass `catalog.unsuitable` and is stored canonically.
 */
export function parseRoutingTable(raw: unknown, catalog: RouterModelCatalog): { ok: true; table: RoutingTable } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['the table must be a JSON object'] };

  const target = (where: string, value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(`${where} must be a model id`);
      return undefined;
    }
    const canonical = catalog.canonical(value.trim());
    if (!canonical) {
      errors.push(`${where}: "${value.trim()}" is not a registered model`);
      return undefined;
    }
    const why = catalog.unsuitable(canonical);
    if (why) {
      errors.push(`${where}: "${canonical}" cannot be routed to (${why})`);
      return undefined;
    }
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

  unknownKeys('table', raw, ['version', 'default', 'routes', 'tiers']);
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? String(raw.version)
    : typeof raw.version === 'string' ? raw.version.trim() : '';
  if (!version) errors.push('version is required');
  const fallback = target('default', raw.default);
  const routes = routesOf('routes', raw.routes);
  const tiers: RoutingTable['tiers'] = {};
  if (raw.tiers !== undefined) {
    if (!isPlainObject(raw.tiers)) {
      errors.push('tiers must be an object of tier name -> overrides');
    } else {
      for (const [tierName, override] of Object.entries(raw.tiers)) {
        if (!isPlainObject(override)) {
          errors.push(`tiers.${tierName} must be an object`);
          continue;
        }
        unknownKeys(`tiers.${tierName}`, override, ['default', 'routes']);
        const tierDefault = override.default === undefined ? undefined : target(`tiers.${tierName}.default`, override.default);
        tiers[tierName] = { ...(tierDefault && { default: tierDefault }), routes: routesOf(`tiers.${tierName}.routes`, override.routes) };
      }
    }
  }
  if (errors.length > 0 || !fallback) return { ok: false, errors };
  return { ok: true, table: { version, default: fallback, routes, tiers } };
}

/** The table's model for one turn, and which rule chose it. Pure; the table has been validated. */
export function routeFor(table: RoutingTable, tier: string | null, taskType: AgentWebTaskType): { model: string; reason: string } {
  const override = tier ? table.tiers[tier] : undefined;
  if (override?.routes[taskType]) return { model: override.routes[taskType]!, reason: `${taskType} task: tier "${tier}" route` };
  if (override?.default) return { model: override.default, reason: `${taskType} task: tier "${tier}" default` };
  if (table.routes[taskType]) return { model: table.routes[taskType]!, reason: `${taskType} task: table route` };
  return { model: table.default, reason: `${taskType} task: table default` };
}

/**
 * The tier-allowlist rule: for every tier that may select the router, every route it can take must be in its own
 * allowlist. A tier that does not list the router never routes; a wildcard tier allows everything. Override keys that
 * name no configured tier are refused (a misspelt tier would silently get the table routes). Returns the violations.
 */
export function checkTableAgainstTiers(
  table: RoutingTable,
  tiers: readonly TierModelsConfig[],
  normalizeModelId: (id: string) => string,
): string[] {
  const errors: string[] = [];
  const names = new Set(tiers.filter((t) => t && typeof t.name === 'string').map((t) => t.name));
  for (const tierName of Object.keys(table.tiers)) {
    if (!names.has(tierName)) errors.push(`tiers.${tierName}: no subscription tier has this name`);
  }
  for (const tier of tiers) {
    if (!tier || typeof tier.name !== 'string') continue;
    const allowed = normalizeAllowedModels(tier.allowedModels, normalizeModelId);
    if (allowed === ALL_MODELS || !allowed.includes(AGENTWEB_MODEL_ID)) continue;
    for (const taskType of AGENTWEB_TASK_TYPES) {
      const { model } = routeFor(table, tier.name, taskType);
      if (!allowed.includes(model)) {
        errors.push(`tier "${tier.name}" may select ${AGENTWEB_MODEL_ID}, but its ${taskType} route "${model}" is not in its allowedModels`);
      }
    }
  }
  return errors;
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
  log(message: string, fields?: Record<string, unknown>): void;
}

type TableState =
  | { status: 'ready'; table: RoutingTable }
  | { status: 'unavailable'; why: 'missing' | 'invalid' | 'unreadable'; errors?: string[] };

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

  function unavailable(why: 'missing' | 'invalid' | 'unreadable', errors?: string[]): TableState {
    const detail = why === 'missing'
      ? `The ${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} setting is absent or empty.`
      : why === 'unreadable'
        ? `The ${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} setting (or the subscription tiers) could not be read and no table was loaded before.`
        : `The ${AGENTWEB_MODEL_ROUTING_TABLE_SETTING} setting is invalid:\n- ${(errors ?? []).join('\n- ')}`;
    deps.log('AgentWebModel: routing table unavailable; selections of the AgentWeb Model are refused', { why, errors });
    void deps.alert({
      subject: 'AgentMode: AgentWeb Model router unavailable',
      detail:
        `${detail}\n\nWhile ${AGENTWEB_MODEL_ROUTER_SETTING} is on, every turn that selects the AgentWeb Model is refused with ` +
        `model_unavailable (nothing is sent to a different model). Fix the table, or turn the switch off.`,
      dedupeKey: ROUTER_UNAVAILABLE_ALERT_DEDUPE_KEY,
      dedupeWindowMs: ALERT_WINDOW_MS,
    }).catch(() => { /* the alert sink must never fail a turn */ });
    return { status: 'unavailable', why, ...(errors && { errors }) };
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
    const tierErrors = tiers ? checkTableAgainstTiers(parsed.table, tiers, deps.normalizeModelId) : [];
    if (tierErrors.length > 0) {
      state = unavailable('invalid', tierErrors);
      return;
    }
    if (state?.status !== 'ready' || state.table.version !== parsed.table.version) {
      deps.log('AgentWebModel: routing table loaded', { version: parsed.table.version });
    }
    state = { status: 'ready', table: parsed.table };
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
   * for the AgentWeb Model when the table is unavailable, or when the route is outside the owner's live allowlist
   * (`allowedModels`: '*' when the tier allowlist is off). The table check at load makes the latter a config race
   * (an allowlist edited after the table loaded); it is refused and alerted, never run.
   */
  async function route(input: { tier: string | null; taskType: AgentWebTaskType; allowedModels: AllowedModels }): Promise<AgentWebModelRoute> {
    const current = await getTableState();
    if (current.status !== 'ready') throw new ModelUnavailableError(AGENTWEB_MODEL_ID, 'not_served');
    const { model, reason } = routeFor(current.table, input.tier, input.taskType);
    if (input.allowedModels !== ALL_MODELS && !input.allowedModels.includes(model)) {
      deps.log('AgentWebModel: route is outside the owner\'s plan; refused', { tier: input.tier, taskType: input.taskType, model });
      void deps.alert({
        subject: 'AgentMode: AgentWeb Model routed outside a plan',
        detail:
          `Routing table ${current.table.version} sends tier "${input.tier ?? 'unknown'}" ${input.taskType} tasks to "${model}", which ` +
          `that tier's allowedModels does not include. The turn was refused (nothing ran on another model). Align the table ` +
          `with the tier's allowedModels.`,
        dedupeKey: ROUTE_OUTSIDE_PLAN_ALERT_DEDUPE_KEY,
        dedupeWindowMs: ALERT_WINDOW_MS,
      }).catch(() => { /* never fail a turn */ });
      throw new ModelUnavailableError(AGENTWEB_MODEL_ID, 'not_served');
    }
    return { model, reason, tableVersion: current.table.version };
  }

  /** Whether a selection of the router can be served right now (table loaded and valid). */
  async function isAvailable(): Promise<boolean> {
    return (await getTableState()).status === 'ready';
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

  return { isEnabled, isAvailable, route, getTableState, reset };
}

export type AgentWebModelRouter = ReturnType<typeof createAgentWebModelRouter>;

/** The router's provenance on a model-policy decision (absent = the selection was a concrete model). */
export interface ModelRouting {
  routedVia: typeof AGENTWEB_MODEL_ID;
  routingReason: string;
  tableVersion: string;
}

/**
 * The model to STORE for a decision (session.llmModel, the engine's step stamps): the selection. A routed decision
 * stores `agentweb-model`, never the concrete model it routed to (that is the user's pick, and storing the routed
 * model would turn the next turn into a pick of that model).
 */
export function selectionOf<M extends string | null | undefined>(decision: { effectiveModel: M; routedVia?: string | null }): M | typeof AGENTWEB_MODEL_ID {
  return decision.routedVia === AGENTWEB_MODEL_ID ? AGENTWEB_MODEL_ID : decision.effectiveModel;
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
