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
  type ModelAccessService,
  type TierModelsConfig,
} from './modelAccess';

export { isSystemAuthoredPlan };
import { LEGACY_MODEL_ALIASES } from './llmModelRegistry';

export const modelAccess: ModelAccessService = createModelAccess({
  getSetting: async (name) => (await import('../settingsService')).settingsService.getSetting(name),
  getUser: async (userId) => (await import('../db')).userDb.getUserById(userId),
  resolveTier: async (userId) => (await import('../subscriptionService')).getUserSubscriptionResolution(userId),
  getTierConfig: async (tierName) => (await import('../subscriptionService')).getSubscriptionTypeConfig(tierName),
  listTiers: async () => {
    const { settingsService } = await import('../settingsService');
    const setting = await settingsService.getSetting('subscription_types');
    const parsed: unknown = setting?.settingValue ? JSON.parse(setting.settingValue) : [];
    return Array.isArray(parsed) ? (parsed as TierModelsConfig[]) : [];
  },
  // The same alias table agentModeService.normalizeModelId applies (a pure module, no service graph).
  normalizeModelId: (id) => (Object.prototype.hasOwnProperty.call(LEGACY_MODEL_ALIASES, id) ? LEGACY_MODEL_ALIASES[id] : id),
  alertTierUnreadable: async ({ ownerUserId, tier, dedupeKey, dedupeWindowMs }) => {
    const { sendAgentModeOncallAlert } = await import('../../utils/agentModeAlerts');
    return sendAgentModeOncallAlert({
      subject: 'AgentMode: tier model allowlist could not read a subscription tier',
      message:
        'The tier model allowlist (model_tier_allowlist_enabled) could not read the owner\'s subscription tier and ' +
        'had no last-known answer, so the requested model was ALLOWED (the gate never blocks on an infrastructure ' +
        'failure). Check the subscription_types setting and the user/org reads.\n\nNOTE: deduped; further ' +
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
export interface SystemModelSession {
  sessionType?: string;
  portalType?: string;
  workPlan?: { templatePlanId?: unknown } | null;
}

/** The system models of a context: canonical ids, or `all` when the context could not be read (never block on it). */
type SystemModels = { all: true } | { all: false; ids: Set<string> };

/**
 * The canonical ids AgentWeb itself runs in this context, which the allowlist never refuses:
 *  - the configured interactive default, everywhere (a turn with no model runs it, so refusing it when named would
 *    only break the picker round-trip);
 *  - the default configured for the session's kind: scheduled, report generation, image / video generation,
 *    customer support (emma-sidebar);
 *  - the pins (plan default and step models) of the admin-authored template a work-plan session was launched from.
 * A failed read never blocks: an unreadable default contributes nothing, an unreadable template counts as
 * admin-authored (logged).
 */
async function systemModelsFor(session: SystemModelSession | null | undefined): Promise<SystemModels> {
  const { agentModeService } = await import('../agentModeService');
  const ids = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const resolution = agentModeService.resolveGenerationModel(raw.trim());
    if (!resolution.fellBack) ids.add(resolution.model);
  };

  // Each read is isolated: one that throws (even synchronously) contributes nothing and blocks nothing.
  const read = (get: () => Promise<string | undefined | null>) => Promise.resolve().then(get);
  const reads = [read(() => agentModeService.getDefaultModel())];
  const sessionType = session?.sessionType;
  if (sessionType === 'scheduled') reads.push(read(() => agentModeService.getScheduledChatsDefaultModel()));
  if (sessionType === 'report_generation') {
    reads.push(read(() => agentModeService.getReportsModel()), read(() => agentModeService.getReportGenerationDefaultModel()));
  }
  if (sessionType === 'image-generation') reads.push(read(() => agentModeService.getImageGenerationDefaultModel()));
  if (sessionType === 'video-generation') reads.push(read(() => agentModeService.getVideoGenerationDefaultModel()));
  if (session?.portalType === 'emma-sidebar') reads.push(read(() => agentModeService.getCustomerSupportDefaultModel()));
  for (const settled of await Promise.allSettled(reads)) {
    if (settled.status === 'fulfilled') add(settled.value);
  }

  const templatePlanId = session?.workPlan?.templatePlanId;
  if (typeof templatePlanId === 'string' && templatePlanId) {
    try {
      const { workPlanService } = await import('../workPlanService');
      const template = await workPlanService.getWorkPlan(templatePlanId);
      if (isSystemAuthoredPlan(template)) {
        add(template?.defaultModel);
        for (const step of template?.steps ?? []) add((step as { model?: unknown })?.model);
      }
    } catch (error) {
      console.error(`ModelAccess: could not read work plan template ${templatePlanId}; treating its pins as system models:`, error);
      return { all: true };
    }
  }
  return { all: false, ids };
}

/** Whether AgentWeb itself runs this canonical id in this session (see systemModelsFor). */
export async function isSystemModelFor(session: SystemModelSession | null | undefined, canonicalModel: string): Promise<boolean> {
  const system = await systemModelsFor(session);
  return system.all || system.ids.has(canonicalModel);
}

/**
 * `isSystemModel` callback for assertModelAllowed / filterAllowedModels, scoped to a session (or to none: the
 * interactive default only). The system set is read lazily, at most once per callback, and only if something
 * would otherwise be refused.
 */
export function systemModelCheck(session?: SystemModelSession | null): (canonicalModel: string) => Promise<boolean> {
  let system: Promise<SystemModels> | undefined;
  return async (canonicalModel) => {
    system ??= systemModelsFor(session);
    const resolved = await system;
    return resolved.all || resolved.ids.has(canonicalModel);
  };
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
