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
import { isCronEnabled } from '../utils/instanceState';
import {
  releaseSessionGeneration,
  resolveEffectiveModelForUser,
  tryClaimSessionGeneration,
} from './agentModeController';
import {
  compareModels,
  CompareDeps,
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

const getSession = (sessionId: string, options?: { consistentRead?: boolean }): Promise<CompareSession | null> =>
  chatbotDb.getChatSession(sessionId, options?.consistentRead === true) as Promise<CompareSession | null>;

const log = (message: string, fields?: Record<string, unknown>): void => {
  // Callers pass identifiers and error classes only, never prompts or content.
  if (fields) console.error(message, fields);
  else console.error(message);
};

function compareDeps(): CompareDeps {
  return {
    isAcceptingWork: isCronEnabled,
    isFeatureEnabled: isModelCompareEnabled,
    getSession,
    checkUsage: (userId) => checkTokenUsage(userId),
    buildUsageBlock: (month) => buildUsageBlockCopy({ month }),
    normalizeModelId: (model) => agentModeService.normalizeModelId(model),
    resolveModel: (input) => resolveEffectiveModelForUser(input),
    isModelSelectableBy: (model, isAdmin) => agentModeService.isModelSelectableBy(model, isAdmin),
    getModelInfo: (model) => agentModeService.getModelCompareInfo(model),
    isPriced: (model) => getModelPrice(model) !== null,
    resolveBillingUserId,
    callLLM: (model, messages, options) => agentModeService.callLLM(model, messages, options),
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
    getSession,
    tryClaim: tryClaimSessionGeneration,
    release: releaseSessionGeneration,
    appendMessages: (sessionId, messages) => chatbotDb.addMessagesToSession(sessionId, messages),
    updateSessionModel: (sessionId, model) => chatbotDb.updateSessionLlmModel(sessionId, model),
    maxSessionMessages: MAX_MESSAGE_SIZE_PER_SESSION,
    getSecret: getJwtSecret,
    now: () => Date.now(),
    log,
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
