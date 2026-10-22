/**
 * ENG-669: process-wide tier model allowlist (one switch cache, one per-owner access cache) and the SYSTEM-model
 * exemption. Everything that enforces the allowlist goes through `modelAccess.assertModelAllowed` here.
 *
 * Service-graph modules are imported lazily, inside the functions that need them: modelPin.ts (and through it
 * emma/impl/workPlans.ts, which must not load settingsService at module scope) reaches this file, and the gate only
 * does any work while the switch is on.
 */
import {
  ALL_MODELS,
  countAllowedRunnable,
  createModelAccess,
  isSystemAuthoredPlan,
  resolveLegacyModelAlias,
  storedModelSource,
  type ModelAccessService,
  type ModelSource,
  type StoredModelRecord,
  type TierModelsConfig,
} from './modelAccess';

export { isSystemAuthoredPlan };

/** Every configured subscription tier (admin order) with its raw `allowedModels`. Throws when the setting is unreadable. */
export async function listSubscriptionTiers(): Promise<TierModelsConfig[]> {
  const { settingsService } = await import('../settingsService');
  const setting = await settingsService.getSetting('subscription_types');
  const parsed: unknown = setting?.settingValue ? JSON.parse(setting.settingValue) : [];
  return Array.isArray(parsed) ? (parsed as TierModelsConfig[]) : [];
}

export const modelAccess: ModelAccessService = createModelAccess({
  getSetting: async (name) => (await import('../settingsService')).settingsService.getSetting(name),
  getUser: async (userId) => (await import('../db')).userDb.getUserById(userId),
  resolveTier: async (userId) => (await import('../subscriptionService')).getUserSubscriptionResolution(userId),
  readTierModels: async (tierName) => (await import('../subscriptionService')).readTierAllowedModels(tierName),
  listTiers: () => listSubscriptionTiers(),
  // The same alias table agentModeService.normalizeModelId applies (a pure module, no service graph).
  normalizeModelId: resolveLegacyModelAlias,
  alertTierUnreadable: async ({ ownerUserId, tier, dedupeKey, dedupeWindowMs }) => {
    const { sendAgentModeOncallAlert } = await import('../../utils/agentModeAlerts');
    // The tier is also read by the AgentWeb Model router (ENG-669 PR-C) for its per-tier routes, with the allowlist on
    // or off: only name the allowlist when it is the one reading (a failed switch read counts as off).
    const allowlistOn = await modelAccess.isEnabled().catch(() => false);
    const consequence = allowlistOn
      ? 'The tier model allowlist (model_tier_allowlist_enabled) could not read the owner\'s subscription tier and ' +
        'had no last-known answer, so the requested model was ALLOWED (the gate never blocks on an infrastructure ' +
        'failure).'
      : 'The AgentWeb Model router could not read the owner\'s subscription tier and had no last-known answer, so ' +
        'the turn was routed without a confirmed tier (that tier\'s overrides in the routing table may not have applied).';
    return sendAgentModeOncallAlert({
      subject: allowlistOn
        ? 'AgentMode: tier model allowlist could not read a subscription tier'
        : 'AgentMode: AgentWeb Model router could not read a subscription tier',
      message:
        `${consequence} Check the subscription_types setting and the user/org reads.\n\nNOTE: deduped; further ` +
        'occurrences in the next hour are suppressed (grep "ModelAccess: tier unreadable" in the logs).',
      context: { Owner: ownerUserId, Tier: tier ?? 'unknown' },
      dedupeKey,
      dedupeWindowMs,
    });
  },
  now: () => Date.now(),
  log: (message, fields) => console.error(message, fields ?? {}),
});

/** The slice of a chat session that decides which models AgentWeb (not the user) chose for it. */
export interface SystemModelSession extends StoredModelRecord {
  sessionType?: string;
  portalType?: string;
  workPlan?: {
    templatePlanId?: unknown;
    /** ENG-669: who authored the plan this session runs, recorded at launch ('system' = admin-authored). */
    planAuthor?: unknown;
    planDefaultModel?: unknown;
    steps?: unknown;
  } | null;
}

/**
 * A model binding's provenance, as recorded when it was written. Undefined = none recorded (a legacy stamp written
 * before provenance existed): checked like a user's pick, except that it may be the session kind's configured default
 * (see isSystemChosen).
 */
export type BindingSource = ModelSource | undefined;

/**
 * ENG-669: the ONE answer to "did AgentWeb choose this model?", the only exemption from the tier allowlist besides an
 * admin owner. True when the binding's provenance, recorded when it was written, says 'system', or the model is a
 * configured default that AgentWeb (not the user) put there:
 *  - the interactive default, everywhere and whatever the source: a turn with no model runs it anyway;
 *  - the scheduled / report / image / video / customer-support default in a session of that kind, unless it is a NEW
 *    pick of it (source 'user' for a model the session does not already hold: a picker PATCH or /generate pick of it,
 *    #3607 follow-up 1). The session's STORED model is exempt as that default whatever its record says: the portal
 *    echoes the picker value on every turn, and that echo has recorded 'user' on legacy stamps (written before
 *    provenance existed) since 2026-10-19, so a recorded 'user' cannot tell AgentWeb's stamp from a pick.
 * Nothing else is inferred at check time. An unreadable default contributes nothing.
 */
export async function isSystemChosen(
  canonicalModel: string,
  source: BindingSource,
  session?: SystemModelSession | null,
): Promise<boolean> {
  if (source === 'system') return true;
  const { agentModeService } = await import('../agentModeService');
  // Each read is isolated: one that throws (even synchronously) contributes nothing and blocks nothing.
  const read = (get: () => Promise<string | undefined | null>) => Promise.resolve().then(get);
  const reads = [read(() => agentModeService.getDefaultModel())];
  // A NEW pick of a session kind's default is checked like any other pick (#3607 follow-up 1); the stored model is not.
  const stored = typeof session?.llmModel === 'string' ? session.llmModel.trim() : '';
  let isStoredModel = false;
  try {
    const resolution = stored ? agentModeService.resolveGenerationModel(stored) : undefined;
    isStoredModel = !!resolution && !resolution.fellBack && resolution.model === canonicalModel;
  } catch {
    // An unresolvable stored id is not this model.
  }
  const kindDefaultApplies = source !== 'user' || isStoredModel;
  const sessionType = kindDefaultApplies ? session?.sessionType : undefined;
  if (sessionType === 'scheduled') reads.push(read(() => agentModeService.getScheduledChatsDefaultModel()));
  if (sessionType === 'report_generation') {
    reads.push(read(() => agentModeService.getReportsModel()), read(() => agentModeService.getReportGenerationDefaultModel()));
  }
  if (sessionType === 'image-generation') reads.push(read(() => agentModeService.getImageGenerationDefaultModel()));
  if (sessionType === 'video-generation') reads.push(read(() => agentModeService.getVideoGenerationDefaultModel()));
  if (kindDefaultApplies && session?.portalType === 'emma-sidebar') reads.push(read(() => agentModeService.getCustomerSupportDefaultModel()));
  for (const settled of await Promise.allSettled(reads)) {
    if (settled.status !== 'fulfilled' || typeof settled.value !== 'string' || !settled.value.trim()) continue;
    const resolution = agentModeService.resolveGenerationModel(settled.value.trim());
    if (!resolution.fellBack && resolution.model === canonicalModel) return true;
  }
  return false;
}

/**
 * `isSystemModel` callback for assertModelAllowed / filterAllowedModels: see isSystemChosen. A lazy `source` is only
 * evaluated when the allowlist would otherwise refuse.
 */
export function systemModelCheck(
  session?: SystemModelSession | null,
  source?: BindingSource | (() => Promise<BindingSource>),
): (canonicalModel: string) => Promise<boolean> {
  return async (canonicalModel) => isSystemChosen(canonicalModel, typeof source === 'function' ? await source() : source, session);
}

/**
 * The provenance of the session's STORED model when `model` is that model (re-sending or re-selecting it is not a new
 * pick), else 'user' (a new pick). `canonical` maps an id to its registry id (legacy aliases resolved).
 * A stored model with no recorded source (legacy) follows storedModelSource's legacy rule, and the engine's stamp of a
 * legacy plan's OWN pin the plan-pin legacy rule; when neither says 'system' it is undefined (none recorded, see
 * BindingSource), never 'user', so a legacy stamp of the session kind's default stays AgentWeb's.
 */
export async function storedBindingSource(
  session: SystemModelSession | null | undefined,
  model: string | null | undefined,
  canonical: (id: string) => string,
): Promise<BindingSource> {
  const stored = session?.llmModel;
  const same = (a: unknown) => typeof a === 'string' && !!a.trim() && !!model && canonical(a.trim()) === canonical(model.trim());
  if (!stored || !same(stored)) return 'user';
  if (session?.llmModelSource === 'user' || session?.llmModelSource === 'system') return session.llmModelSource;
  if (storedModelSource(session) === 'system') return 'system';
  // Legacy (no source recorded): the engine's stamp of a legacy plan's OWN pin follows the plan-pin legacy rule.
  const plan = session?.workPlan;
  if (plan && plan.planAuthor === undefined
    && (same(plan.planDefaultModel) || (Array.isArray(plan.steps) && plan.steps.some((step: any) => same(step?.model))))) {
    return legacyPlanPinSource(plan);
  }
  return undefined;
}

/**
 * ENG-669's one legacy rule for plan pins: a plan launched before this change records no `planAuthor` and no per-binding
 * `modelSource`. Its OWN pins (plan default and step pins, as copied at launch) are AgentWeb's when its template is still
 * admin-authored. A deleted template proves nothing (user); a failed read never blocks (system, logged).
 */
export async function legacyPlanPinSource(plan: { templatePlanId?: unknown } | null | undefined): Promise<ModelSource> {
  const templatePlanId = plan?.templatePlanId;
  if (typeof templatePlanId !== 'string' || !templatePlanId) return 'user';
  try {
    const { workPlanService } = await import('../workPlanService');
    return isSystemAuthoredPlan(await workPlanService.getWorkPlan(templatePlanId)) ? 'system' : 'user';
  } catch (error) {
    console.error(`ModelAccess: could not read work plan template ${templatePlanId}; treating its pins as system models:`, error);
    return 'system';
  }
}

/**
 * ENG-669: the tier allowlist for a model that reaches an LLM (or storage) WITHOUT the resolver (the final gate in
 * generateSessionResponse, the shared-turn pre-flight, the session-model PATCH routes, /api/emma routes that take a
 * model from the request). Same rule as the resolver: matched on the CANONICAL id against the OWNER's plan, system
 * models pass, an unserved id is left to the existing handling. Throws ModelUnavailableError(`not_in_plan`).
 * Switch off => returns before any read.
 */
export async function assertModelInOwnerPlan(input: {
  ownerUserId: string;
  model: string | null | undefined;
  session?: SystemModelSession | null;
}): Promise<void> {
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!model) return;
  if (!(await modelAccess.isEnabled())) return;
  const { agentModeService } = await import('../agentModeService');
  if (typeof agentModeService.resolveGenerationModel !== 'function') return;
  const resolution = agentModeService.resolveGenerationModel(model);
  if (resolution.fellBack) return;
  await modelAccess.assertModelAllowed({
    ownerUserId: input.ownerUserId,
    requestedModel: model,
    canonicalModel: resolution.model,
    // Exempt only as the session kind's configured default or as the session's OWN system stamp (the model stored with
    // llmModelSource 'system'); any other model reaching here is a user's pick.
    isSystemModel: systemModelCheck(input.session, () => storedBindingSource(input.session, model, (id) => {
      const r = agentModeService.resolveGenerationModel(id);
      return r.fellBack ? id : r.model;
    })),
  });
}

/** Compare needs two columns. */
const MIN_COMPARE_MODELS = 2;

/**
 * ENG-669 (D3): `{ tier, upgradeRequired }` when the switch is on and the owner's plan runs fewer than two chat models
 * (its allowed catalog models plus the configured default, which always runs), so Compare is refused before any
 * spend; null otherwise (switch off, admin owner, wildcard tier, or two or more runnable models).
 */
export async function getTierCompareBlock(ownerUserId: string): Promise<{ tier: string | null; upgradeRequired: string[] } | null> {
  if (!(await modelAccess.isEnabled())) return null;
  const access = await modelAccess.getModelAccess(ownerUserId);
  if (access.isAdmin || access.allowedModels === ALL_MODELS) return null;
  const { agentModeService } = await import('../agentModeService');
  const catalog = (await agentModeService.getSupportedModels(false)).filter((id) => !agentModeService.isLiveModel(id));
  const systemIds = [await agentModeService.getDefaultModel()];
  if (countAllowedRunnable(access, catalog, systemIds) >= MIN_COMPARE_MODELS) return null;
  const upgradeRequired = (await modelAccess.tiersRunningAtLeast(MIN_COMPARE_MODELS, catalog, systemIds))
    .filter((tier) => tier !== access.tier);
  return { tier: access.tier, upgradeRequired };
}
