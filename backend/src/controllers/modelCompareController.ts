/**
 * ENG-55: thin HTTP wiring for "Compare models". All behavior lives in
 * services/agentMode/modelComparison.ts; this file only supplies the real
 * dependencies and maps the service outcome onto the response.
 *
 * Kept out of the (very large) agentModeController on purpose. It imports the
 * model resolver and the session generation lock from that controller, so the
 * controller must never import this file (that would be a cycle).
 */
import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';
import { getJwtSecret } from '../config/jwt';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService } from '../services/agentModeService';
import { settingsService } from '../services/settingsService';
import { checkTokenUsage, resolveBillingUserId } from '../services/tokenUsageService';
import { buildUsageBlockCopy } from '../utils/usageBlockCopy';
import { getModelPrice } from '../utils/llmPricing';
import { resolveOpenRouterUpstreamModelId } from '../utils/openRouterGatewayContract';
import { LLM_MODEL_REGISTRY } from '../services/agentMode/llmModelRegistry';
import { modelCompareEntitlement } from '../services/agentMode/modelCompareEntitlement';
import { isCronEnabled } from '../utils/instanceState';
import { resolveRunFunding, withRunFunding, type RunFunding } from '../services/funding/runFunding';
import {
  releaseSessionGeneration,
  resolveEffectiveModelForUser,
  tryClaimSessionGeneration,
} from './agentModeController';
import { createCompareProviderPolicy } from '../services/agentMode/compareProviderPolicy';
import { openRouterCatalogIds } from '../services/agentMode/openRouterCatalogIds';
import { compareSaveAlternatives } from '../services/agentMode/compareSaveAlternativesInstance';
import {
  compareModels,
  CompareDeps,
  isDatedServedSlug,
  isSameServedModel,
  CompareSession,
  MODEL_COMPARE_ENABLED_SETTING,
  newCompareId,
  selectCompareResult,
  SelectDeps,
  ServiceOutcome,
} from '../services/agentMode/modelComparison';

/**
 * Kill switch (P9). AW-Settings, not an env var: prod Elastic Beanstalk is at the
 * CloudFormation env-var size limit (see services/funding/fundingFlags.ts), and a
 * settings row flips without a deploy. Default ENABLED: only an explicit "false"
 * disables, and an unreadable row stays enabled (a settings outage must not take
 * the feature down; the usage gate still bounds spend). Read per request so the
 * switch takes effect immediately.
 */
async function isModelCompareEnabled(): Promise<boolean> {
  try {
    const setting = await settingsService.getSetting(MODEL_COMPARE_ENABLED_SETTING);
    return String(setting?.settingValue ?? '').trim().toLowerCase() !== 'false';
  } catch (error) {
    console.error('ModelCompare: failed to read kill-switch setting; treating as enabled:', error);
    return true;
  }
}

/** ENG-55: one cache, one answer (60s, last-known on error, cold start => off). */
const compareProviderPolicy = createCompareProviderPolicy({
  getSetting: (name) => settingsService.getSetting(name),
  now: () => Date.now(),
  log: (message, fields) => console.error(message, fields),
});

const getSession = (sessionId: string, options?: { consistentRead?: boolean }): Promise<CompareSession | null> =>
  chatbotDb.getChatSession(sessionId, options?.consistentRead === true) as Promise<CompareSession | null>;

const log = (message: string, fields?: Record<string, unknown>): void => {
  // Callers pass identifiers and error classes only, never prompts or content.
  if (fields) console.error(message, fields);
  else console.error(message);
};

let registeredUpstreamIdsCache: string[] | null = null;
/** Upstream (OpenRouter) ids of every registered model; unmapped ids are skipped. */
function registeredUpstreamIds(): string[] {
  if (!registeredUpstreamIdsCache) {
    const ids: string[] = [];
    for (const key of Object.keys(LLM_MODEL_REGISTRY)) {
      try {
        ids.push(resolveOpenRouterUpstreamModelId(key));
      } catch {
        /* no gateway mapping */
      }
    }
    registeredUpstreamIdsCache = ids;
  }
  return registeredUpstreamIdsCache;
}

function compareDeps(): CompareDeps {
  // Every LLM entry point resolves run funding once and runs inside withRunFunding (ENG-1816), so
  // metering and any future customer-funded route see the same scope /generate gives. Today it always
  // resolves to the AgentWeb route; resolved once per request (memoised per owner) so the parallel
  // model calls do not each re-read the funding flags.
  const fundingByOwner = new Map<string, Promise<RunFunding>>();
  const fundingFor = (ownerUserId: string): Promise<RunFunding> => {
    let pending = fundingByOwner.get(ownerUserId);
    if (!pending) {
      pending = resolveRunFunding({ userId: ownerUserId });
      fundingByOwner.set(ownerUserId, pending);
    }
    return pending;
  };
  return {
    isAcceptingWork: isCronEnabled,
    isFeatureEnabled: isModelCompareEnabled,
    isEntitled: (user) => modelCompareEntitlement.isEntitled(user),
    getSession,
    checkUsage: (userId) => checkTokenUsage(userId),
    buildUsageBlock: (month) => buildUsageBlockCopy({ month }),
    normalizeModelId: (model) => agentModeService.normalizeModelId(model),
    resolveModel: (input) => resolveEffectiveModelForUser(input),
    getModelInfo: (model) => agentModeService.getModelCompareInfo(model),
    isPriced: (model) => getModelPrice(model) !== null,
    servedModelMatches: async (requested, served) => {
      // Strict (exact or dated snapshot of the same id); fail closed if the id has no gateway
      // mapping (callLLM would already have refused it).
      try {
        const upstream = resolveOpenRouterUpstreamModelId(requested);
        if (!isSameServedModel(upstream, served, registeredUpstreamIds())) return false;
        // A dated slug is also what an MMDD sibling that is listed upstream but not registered yet looks
        // like (the daily monitor only adds it after a human merge). Re-check against the live catalog;
        // an exact undated id needs no lookup, and an unreachable catalog degrades to the check above.
        if (!isDatedServedSlug(served)) return true;
        const catalogIds = await openRouterCatalogIds.getIds();
        return isSameServedModel(upstream, served, [...registeredUpstreamIds(), ...catalogIds]);
      } catch {
        return false;
      }
    },
    resolveBillingUserId,
    callLLM: async (model, messages, options) => {
      const runFunding = await fundingFor(options.usageContext.userId);
      return withRunFunding(runFunding, () => agentModeService.callLLM(model, messages, options));
    },
    getProviderPolicy: () => compareProviderPolicy.getPolicy(),
    getSecret: getJwtSecret,
    now: () => Date.now(),
    newId: newCompareId,
    log,
  };
}

function selectDeps(): SelectDeps {
  return {
    isAcceptingWork: isCronEnabled,
    isFeatureEnabled: isModelCompareEnabled,
    isEntitled: (user) => modelCompareEntitlement.isEntitled(user),
    getSession,
    tryClaim: tryClaimSessionGeneration,
    release: releaseSessionGeneration,
    appendMessages: (sessionId, messages) => chatbotDb.addMessagesToSession(sessionId, messages),
    updateSessionModel: (sessionId, model) => chatbotDb.updateSessionLlmModel(sessionId, model),
    maxSessionMessages: MAX_MESSAGE_SIZE_PER_SESSION,
    getSecret: getJwtSecret,
    now: () => Date.now(),
    log,
    isSaveAlternativesEnabled: () => compareSaveAlternatives.isEnabled(),
    getModelInfo: (model) => agentModeService.getModelCompareInfo(model),
  };
}

function send(res: Response, outcome: ServiceOutcome): Response {
  // Comparison answers are per-user content; never cache them.
  res.set('Cache-Control', 'no-store');
  return res.status(outcome.status).json(outcome.body);
}

export async function compareModelsHandler(req: AuthenticatedRequest, res: Response): Promise<Response> {
  const user = { userId: req.user.userId, isAdmin: req.user.isAdmin === true };
  return send(res, await compareModels(compareDeps(), { user, body: req.body }));
}

export async function selectCompareResultHandler(req: AuthenticatedRequest, res: Response): Promise<Response> {
  const user = { userId: req.user.userId, isAdmin: req.user.isAdmin === true };
  return send(res, await selectCompareResult(selectDeps(), { user, body: req.body }));
}
