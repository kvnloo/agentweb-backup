/**
 * ENG-669 PR-C: the process-wide AgentWeb Model router (one switch cache, one table cache) and the two things every
 * caller needs from it: route a selection of `agentweb-model` for a turn, and check that a selection can be stored.
 *
 * Service-graph modules are imported lazily, as in modelAccessInstance.ts: modelPin.ts (and through it
 * emma/impl/workPlans.ts) reaches this file, and nothing here does any work while the switch is off.
 */
import { LLM_MODEL_REGISTRY } from './llmModelRegistry';
import { getModelPrice } from '../../utils/llmPricing';
import { ALL_MODELS, resolveLegacyModelAlias } from './modelAccess';
import {
  AGENTWEB_MODEL_ID,
  createAgentWebModelRouter,
  taskTypeForSession,
  type AgentWebModelRoute,
  type AgentWebModelRouter,
  type AgentWebTaskType,
  type RouterModelCatalog,
} from './agentWebModelRouter';
import {
  listSubscriptionTiers,
  modelAccess,
  storedBindingSource,
  systemModelCheck,
  type BindingSource,
  type SystemModelSession,
} from './modelAccessInstance';

/** The registry and price table as the routing table sees them (pure modules, no service graph). */
export const registryRouterCatalog: RouterModelCatalog = {
  canonical: (id) => {
    const canonical = resolveLegacyModelAlias(id);
    return Object.prototype.hasOwnProperty.call(LLM_MODEL_REGISTRY, canonical) ? canonical : undefined;
  },
  unsuitable: (id) => {
    const config = LLM_MODEL_REGISTRY[id];
    if (!config) return 'not a registered model';
    if (config.adminOnly) return 'admin-only';
    if (config.internalOnly) return 'internal-only';
    if (config.isLive) return 'live voice';
    if (config.supportsTools === false) return 'cannot call tools';
    if (!getModelPrice(id)) return 'unpriced';
    return undefined;
  },
};

export const agentWebModelRouter: AgentWebModelRouter = createAgentWebModelRouter({
  getSetting: async (name) => (await import('../settingsService')).settingsService.getSetting(name),
  catalog: registryRouterCatalog,
  // With the tier allowlist off no plan narrows any model, so there is nothing to intersect the table with.
  readTierAllowlists: async () => ((await modelAccess.isEnabled()) ? listSubscriptionTiers() : null),
  normalizeModelId: resolveLegacyModelAlias,
  alert: async ({ subject, detail, dedupeKey, dedupeWindowMs }) => {
    const { sendAgentModeOncallAlert } = await import('../../utils/agentModeAlerts');
    return sendAgentModeOncallAlert({
      subject,
      message: `${detail}\n\nNOTE: deduped; further occurrences in the next hour are suppressed (grep "AgentWebModel:" in the logs).`,
      context: { Setting: 'agentweb_model_routing_table' },
      dedupeKey,
      dedupeWindowMs,
    });
  },
  now: () => Date.now(),
  log: (message, fields) => console.error(message, fields ?? {}),
  info: (message, fields) => console.log(message, fields ?? {}),
});

export interface RoutedSelection extends AgentWebModelRoute {
  taskType: AgentWebTaskType;
}

/**
 * Route a selection of the AgentWeb Model for one turn. The caller has checked the switch is on.
 *
 * 1. The SELECTION is the user's pick: it is checked against the owner's tier allowlist like any model (PR-A gate:
 *    `agentweb-model` must be listed, or the tier is a wildcard), unless it is AgentWeb's own choice (`modelSource`
 *    'system', the provenance of the stored stamp when omitted) or `skipTierCheck` (a paused account: nothing runs).
 * 2. The routed model is AgentWeb's choice: not tier-checked as a pick, but the router refuses a route outside the
 *    owner's live allowlist (and the table load already refused any tier/route mismatch).
 * Throws ModelUnavailableError: `not_in_plan` for the selection, `not_served` when the router is unavailable.
 */
export async function routeAgentWebModelSelection(input: {
  ownerUserId: string;
  session?: SystemModelSession | null;
  /** Default: the session's task type (no session = chat). */
  taskType?: AgentWebTaskType;
  modelSource?: BindingSource | (() => Promise<BindingSource>);
  skipTierCheck?: boolean;
  /** A check of a selection that is being stored, not a turn: nothing runs, so nothing is logged as routed. */
  dryRun?: boolean;
}): Promise<RoutedSelection> {
  if (!input.skipTierCheck && input.modelSource !== 'system') {
    await modelAccess.assertModelAllowed({
      ownerUserId: input.ownerUserId,
      requestedModel: AGENTWEB_MODEL_ID,
      canonicalModel: AGENTWEB_MODEL_ID,
      isSystemModel: systemModelCheck(
        input.session,
        input.modelSource ?? (() => storedBindingSource(input.session, AGENTWEB_MODEL_ID, resolveLegacyModelAlias)),
      ),
    });
  }
  const [allowlistOn, access] = await Promise.all([modelAccess.isEnabled(), modelAccess.getModelAccess(input.ownerUserId)]);
  const taskType = input.taskType ?? taskTypeForSession(input.session);
  const route = await agentWebModelRouter.route({
    tier: access.tier,
    taskType,
    allowedModels: allowlistOn && !access.isAdmin ? access.allowedModels : ALL_MODELS,
  });
  if (!input.dryRun) {
    console.log('AgentWebModel: routed', {
      owner: input.ownerUserId, tier: access.tier, taskType, model: route.model, reason: route.reason, tableVersion: route.tableVersion,
    });
  }
  return { ...route, taskType };
}

/**
 * Whether `agentweb-model` may be STORED as a selection (session PATCH, schedule / plan / step pins). The caller has
 * checked the switch is on. Throws ModelUnavailableError exactly as the turn would.
 *  - `ownerUserId`: whose pick it is; the selection must be in their plan, and the router must work for their tier.
 *  - `routeForUserId` without an owner: an admin-authored pin (AgentWeb's choice, so the selection is not checked as a
 *    pick) that this user is LAUNCHING: the router must work for their tier (a visible refusal now, not at a step).
 *  - neither: an admin-authored pin being saved: only that the table can route at all.
 */
export async function assertAgentWebModelSelectable(input: {
  ownerUserId?: string;
  routeForUserId?: string;
  session?: SystemModelSession | null;
  taskType?: AgentWebTaskType;
}): Promise<void> {
  if (input.ownerUserId) {
    await routeAgentWebModelSelection({
      ownerUserId: input.ownerUserId,
      session: input.session,
      taskType: input.taskType,
      // A new pick: the user's choice (re-picking the stored selection keeps its stamp's source).
      modelSource: () => storedBindingSource(input.session, AGENTWEB_MODEL_ID, resolveLegacyModelAlias),
      dryRun: true,
    });
    return;
  }
  if (input.routeForUserId) {
    await routeAgentWebModelSelection({
      ownerUserId: input.routeForUserId, session: input.session, taskType: input.taskType, modelSource: 'system', dryRun: true,
    });
    return;
  }
  await agentWebModelRouter.route({ tier: null, taskType: input.taskType ?? taskTypeForSession(input.session), allowedModels: ALL_MODELS });
}

/** Why the pickers do not offer the AgentWeb Model to an owner while the switch is on. */
export type AgentWebModelNotOfferedReason = 'not_in_plan' | 'unavailable_for_tier';

/** The AgentWeb Model as an owner's pickers see it while the switch is on (see describeAgentWebModelAvailability). */
export interface AgentWebModelAvailability {
  /** Exactly offersAgentWebModel(owner): the pickers list it. */
  offered: boolean;
  /**
   * Present when not offered:
   *  - 'unavailable_for_tier': the router cannot route this owner's tier right now (unusable table, tier unavailable, or
   *    a route with an unusable target). Nothing on it runs, AgentWeb's own choice (a system pin) included.
   *  - 'not_in_plan': it routes this tier (every route inside the owner's allowlist), but the allowlist does not list
   *    it: a pick of it is refused (not_in_plan), while AgentWeb's own choice (an admin-authored plan's pin, source
   *    'system') still runs.
   * When both apply, 'unavailable_for_tier' (neither kind of selection runs).
   */
  reason?: AgentWebModelNotOfferedReason;
}

/**
 * The AgentWeb Model's availability for one owner, for GET /model-options: null while the switch is off (nothing is
 * read beyond the cached switch, and the response is unchanged). Never names a tier.
 */
export async function describeAgentWebModelAvailability(ownerUserId: string): Promise<AgentWebModelAvailability | null> {
  if (!(await agentWebModelRouter.isEnabled())) return null;
  if (await offersAgentWebModel(ownerUserId)) return { offered: true };
  // Not offered: AgentWeb's own pin of it still runs only if the router serves the tier with every route inside the
  // owner's live allowlist (routeAgentWebModelSelection's check; the load-time tier check skips a tier that does not
  // list the AgentWeb Model). That can hold only when the plan does not list it (were it listed, it would be offered).
  const access = await modelAccess.getModelAccess(ownerUserId);
  const allowedModels = (await modelAccess.isEnabled()) && !access.isAdmin ? access.allowedModels : ALL_MODELS;
  return (await agentWebModelRouter.isAvailableFor(access.tier, allowedModels))
    ? { offered: false, reason: 'not_in_plan' }
    : { offered: false, reason: 'unavailable_for_tier' };
}

/**
 * Whether the pickers offer the AgentWeb Model to this owner: the switch is on (off: nothing is read beyond the cached
 * switch), the owner's tier includes it, and the router is currently valid for that tier (usable table, tier not
 * unavailable, every route it can take usable). No owner (an anonymous catalog read) = not offered.
 */
export async function offersAgentWebModel(ownerUserId: string | null | undefined): Promise<boolean> {
  if (!(await agentWebModelRouter.isEnabled())) return false;
  if (!ownerUserId) return false;
  const allowed = await modelAccess.filterAllowedModels(ownerUserId, [AGENTWEB_MODEL_ID]);
  if (!allowed.includes(AGENTWEB_MODEL_ID)) return false;
  // Valid for THIS owner's tier (another tier's broken override must not hide it here, and vice versa).
  const access = await modelAccess.getModelAccess(ownerUserId);
  return agentWebModelRouter.isAvailableFor(access.tier);
}
