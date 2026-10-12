/**
 * ENG-112: thin HTTP wiring for "Branch from here". All behavior lives in
 * services/agentMode/chatBranching.ts; this file only supplies the real dependencies and maps the
 * service outcome onto the response. Like modelCompareController it lives outside the (very large)
 * agentModeController, which it imports from, so the controller must never import this file.
 */
import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../config';
import { chatbotDb } from '../services/chatbotService';
import { agentModeService, ADMIN_SKILL_TOOL_NAMES } from '../services/agentModeService';
import { settingsService } from '../services/settingsService';
import { isCronEnabled } from '../utils/instanceState';
import {
  claimIdempotency,
  createSessionIdempotencyKey,
  IDEM_TTL_INTERACTIVE_S,
  isRunStoreEnabled,
  recordIdempotencySessionId,
  releaseIdempotency,
} from '../services/agentMode/runStore';
import { isModelUnavailableError } from '../services/agentMode/modelUnavailable';
import {
  releaseSessionGeneration,
  resolveEffectiveModelForUser,
  modelUnavailableBody,
  toStoredModelPolicyDecision,
  tryClaimSessionGeneration,
} from './agentModeController';
import {
  BranchDeps,
  branchChatSession,
  listBranchFamily,
  CHAT_BRANCHING_ENABLED_SETTING,
  CHAT_BRANCHING_MAX_PER_HOUR_SETTING,
  DEFAULT_MAX_BRANCHES_PER_HOUR,
  BRANCH_FAMILY_MAX_PER_MINUTE_SETTING,
  DEFAULT_BRANCH_FAMILY_MAX_PER_MINUTE,
  parseBranchFamilyRateLimit,
  isChatBranchingSettingEnabled,
  parseBranchRateLimit,
} from '../services/agentMode/chatBranching';
import { v4 as uuidv4 } from 'uuid';

/**
 * Feature flag, AW-Settings (prod Elastic Beanstalk is at the env-var size limit, and a settings
 * row flips without a deploy). DEFAULT OFF: only the exact value "true" enables it, and an
 * unreadable row stays OFF (this feature writes data, so it fails closed). Read per request.
 */
export async function isChatBranchingEnabled(): Promise<boolean> {
  try {
    const setting = await settingsService.getSetting(CHAT_BRANCHING_ENABLED_SETTING);
    return isChatBranchingSettingEnabled(setting?.settingValue);
  } catch (error) {
    console.error('ChatBranching: failed to read the feature flag; treating as disabled:', error);
    return false;
  }
}

const RATE_SETTING_CACHE_MS = 60 * 1000;
let rateSettingCache: { value: number; at: number } | undefined;

export function __resetBranchRateLimitCacheForTests(): void {
  rateSettingCache = undefined;
}

/**
 * Per-user branches per rolling hour, from AW-Settings `chat_branching_max_per_hour`. Cached ~60s;
 * an unreadable row serves the last known value (default 30 if there never was one). Absent or
 * invalid => 30; "0" => unlimited.
 */
export async function getChatBranchingMaxPerHour(now: number = Date.now()): Promise<number> {
  if (rateSettingCache && now - rateSettingCache.at < RATE_SETTING_CACHE_MS) return rateSettingCache.value;
  try {
    const setting = await settingsService.getSetting(CHAT_BRANCHING_MAX_PER_HOUR_SETTING);
    rateSettingCache = { value: parseBranchRateLimit(setting?.settingValue), at: now };
  } catch (error) {
    console.error('ChatBranching: failed to read the rate-limit setting; using the last known value:', error);
    rateSettingCache = { value: rateSettingCache?.value ?? DEFAULT_MAX_BRANCHES_PER_HOUR, at: now };
  }
  return rateSettingCache.value;
}

let lookupSettingCache: { value: number; at: number } | undefined;

export function __resetBranchLookupCacheForTests(): void {
  lookupSettingCache = undefined;
}

/** Per-user family lookups per minute, AW-Settings `branch_family_max_per_minute`. Cached ~60s, last-known fallback; 0 = unlimited. */
export async function getBranchFamilyMaxPerMinute(now: number = Date.now()): Promise<number> {
  if (lookupSettingCache && now - lookupSettingCache.at < RATE_SETTING_CACHE_MS) return lookupSettingCache.value;
  try {
    const setting = await settingsService.getSetting(BRANCH_FAMILY_MAX_PER_MINUTE_SETTING);
    lookupSettingCache = { value: parseBranchFamilyRateLimit(setting?.settingValue), at: now };
  } catch (error) {
    console.error('ChatBranching: failed to read the lookup-limit setting; using the last known value:', error);
    lookupSettingCache = { value: lookupSettingCache?.value ?? DEFAULT_BRANCH_FAMILY_MAX_PER_MINUTE, at: now };
  }
  return lookupSettingCache.value;
}

function branchDeps(): BranchDeps {
  const runStore = isRunStoreEnabled();
  return {
    isAcceptingWork: isCronEnabled,
    isFeatureEnabled: isChatBranchingEnabled,
    getSession: (sessionId, options) => chatbotDb.getChatSession(sessionId, options?.consistentRead === true),
    tryClaim: tryClaimSessionGeneration,
    release: releaseSessionGeneration,
    ...(runStore
      ? {
          claimIdempotency: async (userId: string, scope: string) => {
            const claim = await claimIdempotency(createSessionIdempotencyKey(userId, scope), uuidv4(), IDEM_TTL_INTERACTIVE_S);
            return claim.claimed ? { claimed: true as const } : { claimed: false as const, sessionId: claim.sessionId };
          },
          recordIdempotencySessionId: (userId: string, scope: string, sessionId: string) =>
            recordIdempotencySessionId(createSessionIdempotencyKey(userId, scope), sessionId),
          releaseIdempotency: (userId: string, scope: string) => releaseIdempotency(createSessionIdempotencyKey(userId, scope)),
        }
      : {}),
    resolveModel: async ({ userId, requestedModel, explicit }) => {
      try {
        const decision = await resolveEffectiveModelForUser({
          userId,
          requestedModel,
          // An explicit pick that cannot be served must fail loudly (422); only the inherited
          // source model may fall back, exactly like createSession.
          allowSilentSwap: !explicit,
        });
        const model = decision.effectiveModel ?? (await agentModeService.getDefaultModel());
        return { ok: true, model, policy: toStoredModelPolicyDecision(decision) };
      } catch (error) {
        if (!isModelUnavailableError(error)) throw error;
        return { ok: false, outcome: { status: 422, body: modelUnavailableBody(error) } };
      }
    },
    createSession: (a) =>
      chatbotDb.createChatSession(
        a.userId, undefined, a.portalType, a.pageIdentifier, a.selectedStartupId,
        undefined, undefined, undefined, 'regular', a.delegateInfo, a.initialState,
      ),
    setModel: (sessionId, model, policy) => chatbotDb.updateSessionLlmModel(sessionId, model, policy),
    setTitle: (sessionId, title) => chatbotDb.updateSessionTitle(sessionId, title),
    appendMessages: (sessionId, messages) => chatbotDb.addMessagesToSession(sessionId, messages),
    unarchiveSession: (sessionId) => chatbotDb.unarchiveSession(sessionId),
    getMaxBranchesPerHour: () => getChatBranchingMaxPerHour(),
    adminToolNames: ADMIN_SKILL_TOOL_NAMES,
    maxSessionMessages: MAX_MESSAGE_SIZE_PER_SESSION,
    now: () => Date.now(),
    log: (message, fields) => (fields ? console.error(message, fields) : console.error(message)),
  };
}

export async function branchSessionHandler(req: AuthenticatedRequest, res: Response): Promise<Response> {
  const delegated = req.delegateInfo?.isDelegated === true;
  const outcome = await branchChatSession(branchDeps(), {
    user: { userId: req.user.userId, isAdmin: req.user.isAdmin === true },
    // Same rule getSession uses for admin-tainted turns (ENG-2163): a real admin or delegated admin.
    viewerIsAdmin: req.user.isAdmin === true || delegated,
    sessionId: req.params.sessionId,
    body: req.body,
    ...(delegated && req.delegateInfo
      ? { delegateInfo: { adminUserId: req.delegateInfo.adminUserId, adminEmail: req.delegateInfo.adminEmail, isDelegated: true } }
      : {}),
  });
  res.set('Cache-Control', 'no-store');
  return res.status(outcome.status).json(outcome.body);
}

export async function listBranchesHandler(req: AuthenticatedRequest, res: Response): Promise<Response> {
  const outcome = await listBranchFamily(
    {
      isAcceptingWork: isCronEnabled,
      isFeatureEnabled: isChatBranchingEnabled,
      // Record only: authorisation must not read or migrate a (possibly foreign) session's messages.
      getSession: (sessionId) => chatbotDb.getChatSessionRecord(sessionId),
      listBranches: (userId, rootSessionId, opts) => chatbotDb.getBranchFamilySessions(userId, rootSessionId, opts),
      getMaxLookupsPerMinute: () => getBranchFamilyMaxPerMinute(),
    },
    { user: { userId: req.user.userId, isAdmin: req.user.isAdmin === true }, sessionId: req.params.sessionId },
  );
  res.set('Cache-Control', 'no-store');
  return res.status(outcome.status).json(outcome.body);
}
