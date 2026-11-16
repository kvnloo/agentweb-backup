import { userDb, orgDb, User } from "./db";
import { getSubscriptionTypeConfig, getUserSubscriptionType } from "./subscriptionService";
import { inheritsOrgBilling } from "./orgAuthz";
import { type LlmUsageMode, type LlmUsagePolicy,
  resolveAlertThresholds,
  type ResolvedAlertThresholds,
} from "./llmUsagePolicyService";
import { resolveLlmUsagePoolDecision } from './llmUsagePoolDecision';
import type { PaygBlock } from './paygOverage';
import { withOwnerOpenInvoice } from './paygSettlement';
import { randomUUID } from 'crypto';
import { recordLlmChargeEvent, LLM_CHARGE_EVENTS_TABLE } from './llmChargeAuditDb';
import { buildUsageBlockCopy, type UsageBlockCopy } from '../utils/usageBlockCopy';

export interface TokenUsageStatus {
  allowed: boolean;
  warning: boolean;
  used: number;
  allowance: number | null; // null = unlimited
  bonus: number;
  effectiveAllowance: number | null; // allowance + bonus, null = unlimited
  percentUsed: number; // 0-100+, 0 if unlimited (token dimension)
  month: string; // "YYYY-MM"
  // Cost-based limit (per-user monthly LLM spend cap in USD). Independent of the
  // token-count limit so that higher-cost models can be enabled without risking
  // runaway per-user spend (ENG-200).
  costUsed: number; // USD spent this month
  costAllowance: number | null; // null = unlimited
  costPercentUsed: number; // 0-100+, 0 if unlimited (cost dimension)
  // Whether the cost cap is the dimension actually gating THIS user right now.
  // Requires both ENFORCE_COST_CAP and a configured costAllowance — the flag alone
  // is not enough, because an unpriced tier falls back to its token cap (ENG-1116).
  // While false the dollar figures are observe-only. UIs use this to know which
  // dimension to render as the quota: true means a real cost denominator exists.
  costEnforced: boolean;
  usageMode?: LlmUsageMode;
  usagePolicyVersion?: string | null;
  /**
   * Alert thresholds with defaults ALREADY applied (ENG-1214 AC5, ENG-1210 AC9).
   *
   * Resolved here rather than left nullable so the client never carries its own
   * fallback. A portal holding a private default would keep warning at the old
   * number for any tier whose policy set a different one, and the disagreement
   * would be invisible — both sides look right in isolation while the customer
   * is warned at the wrong moment.
   */
  alertThresholds: ResolvedAlertThresholds;
  /**
   * ENG-668: pay-as-you-go state, present only while an account with PAYG live is past its plan pool.
   * `active` = admitted on PAYG with spend at or past the month's pool; `percentOfCap` = overage as a percentage of the cap the
   * customer chose. Percentages only — the cap and the overage in dollars never leave the server.
   * `costPercentUsed` keeps meaning the plan pool, so it reads above 100 while this is active.
   */
  overage?: { active: boolean; percentOfCap: number };
  /**
   * ENG-668: why the block is PAYG's own (cap reached, suspended, not covered), when it is; drives the
   * `usageBlock` copy. Internal: customers see it as `usageBlock.reason` / `usageBlock.paygInactiveReason`.
   */
  paygBlock?: PaygBlock;
}

/**
 * The customer-facing projection of `TokenUsageStatus` (ENG-1212 AC4).
 *
 * `costUsed` and `costAllowance` are dropped. `hasCostAllowance` replaces the
 * only thing the client ever did with the latter — a null check.
 */
export type CustomerTokenUsageStatus = Omit<TokenUsageStatus, 'costUsed' | 'costAllowance' | 'used' | 'paygBlock'> & {
  /**
   * Token volume used this month. ABSENT when no token limit applies (ENG-1250 AC7: token volume is no
   * longer measured), so the portal's `typeof used === "number"` check hides its token meter instead of
   * rendering a false "0 tokens used this month".
   */
  used?: number;
  /**
   * Whether a dollar ceiling exists at all, without saying what it is.
   *
   * The portal never rendered `costAllowance`; it tested `costAllowance != null`
   * to decide which dimension is the quota (UsageMeter, SubscriptionCard
   * `showCostQuota`). This carries that one bit and nothing more.
   */
  hasCostAllowance: boolean;
  /**
   * ENG-1344 AC6: the block explanation, composed server-side so the portal
   * modal and the ENG-1035 MCP 429 cannot describe the same block differently.
   * Always present — the client decides WHEN to show it (only while blocked),
   * the server decides WHAT it says.
   */
  usageBlock: UsageBlockCopy;
};

/**
 * Strip internal dollar amounts at the API boundary (ENG-1212 AC4: "No internal
 * USD amounts are returned by customer APIs; authorized admin diagnostics may
 * include them", and the ticket's own outcome, "without exposing dollar
 * ceilings").
 *
 * The sibling `/usage-runway` route has always done this via `toCustomerRunway`;
 * `/usage` returned `checkTokenUsage` verbatim, so `costUsed` and
 * `costAllowance` reached every authenticated customer in plain USD. That was
 * not a deliberate product choice — the UI states the opposite intent in two
 * places: SubscriptionCard renders the cost quota "ONLY as a percentage bar
 * (never the dollar figures)" and "Dollars stay admin-only; to the user this is
 * simply 'usage'". `costUsed` had no non-test reader anywhere in the portal.
 *
 * `costPercentUsed` stays: a percentage is not a dollar amount, and it is what
 * the bar actually renders. Admin dollar figures are unaffected — the partner
 * portal builds them from subscription-type policy, not from this endpoint.
 *
 * Strip at the boundary, once, here — the internal type is unchanged, so
 * emailService and the policy services keep the figures they need.
 */
export function toCustomerTokenUsage(status: TokenUsageStatus): CustomerTokenUsageStatus {
  // `paygBlock` is carried by `usageBlock.reason` instead of twice. `overage` passes through:
  // it is percentages by construction (ENG-668).
  const { costUsed: _costUsed, costAllowance, used, paygBlock, ...customerSafe } = status;
  return {
    ...customerSafe,
    ...(status.effectiveAllowance === null ? {} : { used }),
    hasCostAllowance: costAllowance != null,
    usageBlock: buildUsageBlockCopy({ month: status.month, paygBlock }),
  };
}

/**
 * For org members, returns the org owner's userId so that all quota checks
 * and usage increments are applied to the owner (the subscription holder).
 * Returns the original userId for solo users and org owners.
 */
export async function resolveBillingUserId(userId: string): Promise<string> {
  const user = await userDb.getUserById(userId);
  if (!user || !user.orgId) return userId;

  const org = await orgDb.getOrgById(user.orgId);
  if (!org) return userId;

  // Anchored on the billing root, not on a role. The previous test was
  // `user.orgRole !== "member"`, which treated "member" as a synonym for "not the
  // owner". With admins (or a second owner) that is false: they are not "member",
  // so usage stopped landing on the org counter and started burning their own
  // quota — silently. Everyone except the billing root pools onto it.
  // ENG-1084: a member holding their own live subscription no longer pools onto
  // the root — `inheritsOrgBilling` is now the single predicate entitlement and
  // quota both resolve through, so the two cannot drift a fourth time.
  if (
    !inheritsOrgBilling(
      { userId, orgId: user.orgId, subscription_status: user.subscription_status },
      org,
    )
  ) {
    return userId;
  }

  // ENG-1215: the org can name an owner that does not resolve. Two shapes exist
  // in real data: `ownerUserId` absent from the row entirely, and an id left
  // dangling when the owner was deleted while members remained.
  //
  // Returning either one hands every caller a billing subject that
  // `getUserTokenUsage` throws `User not found` on. That is not confined to the
  // usage surfaces it was first seen on (a 500 from /usage-runway): this
  // function also resolves the subject for `checkTokenUsage`, the gate on the
  // chat path, so a member whose OWN record is perfectly healthy is locked out
  // of the product by a defect in a row they cannot see.
  //
  // Fall back to the member's own partition, exactly as the `!org` case above
  // does. There is no org counter to pool onto when the root does not exist, so
  // the member is billed and quota'd on their own — the restrictive direction,
  // never an uncapped one.
  if (!org.ownerUserId) return userId;
  const billingRoot = await userDb.getUserById(org.ownerUserId);
  if (!billingRoot) return userId;

  return org.ownerUserId;
}

export function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getNextResetDate(): string {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.toISOString();
}

/**
 * Percent of an allowance consumed. Returns 0 for an unlimited (null) allowance.
 * For a zero allowance, any usage counts as 100% (fully consumed).
 */
function computePercentUsed(used: number, allowance: number | null): number {
  if (allowance === null || allowance === undefined) return 0;
  if (allowance > 0) return Math.round((used / allowance) * 100);
  return used > 0 ? 100 : 0;
}

/**
 * Fixed, conservative dollar cap for an anonymous (`anon_`-owned) session.
 * There is no subscription tier to size this from — an anon owner has no
 * AW-Users row — so this exists purely to bound worst-case spend on the
 * publicly reachable ishare/generate path (ENG-705, ENG-1163). Observed
 * cost to run the full two-step Founder_Linkedin_Sales_Readiness_Eval plan
 * is ~$0.45; this caps at roughly 4x that.
 */
export const ANONYMOUS_SESSION_COST_CAP_USD = 2;

/**
 * Sums `totalCost` across every AW-ChatSessions row owned by an anonymous
 * `anon_<uuid>` id (via the existing UserIdIndex GSI). Lazy-imported —
 * chatbotService pulls in agentModeService, and a static import here would
 * drag that graph into every suite that mocks this module (same reasoning
 * as the tokenUsageService lazy-import in agentModeService).
 */
async function getAnonymousSessionCostUsedUsd(userId: string): Promise<number> {
  const { chatbotDb } = await import('./chatbotService');
  const { sessions } = await chatbotDb.getUserSessions(userId);
  return sessions.reduce((sum, session) => sum + (session.totalCost || 0), 0);
}

/**
 * Get a user's current month token usage, performing lazy reset if month changed.
 */
export async function getUserTokenUsage(
  userId: string
): Promise<{ month: string; totalTokens: number; totalCost: number; bonus: number }> {
  // ENG-1163: mirrors checkTokenUsage's anon_ short-circuit. This function is
  // also called directly (bypassing checkTokenUsage entirely) by
  // getEffectiveLlmUsagePolicy — every generateSharedResponse turn reaches it
  // via resolveEffectiveModelForUser right after the checkTokenUsage gate — so
  // without this guard an anon-owned session still throws 'User not found' on
  // its first reply even after the checkTokenUsage fix, just one call deeper.
  if (typeof userId === 'string' && userId.startsWith('anon_')) {
    const currentMonth = getCurrentMonth();
    let totalCost: number;
    try {
      totalCost = await getAnonymousSessionCostUsedUsd(userId);
    } catch (err) {
      console.error(`[tokenUsageService] Failed to resolve anon session cost for ${userId}:`, err);
      totalCost = ANONYMOUS_SESSION_COST_CAP_USD;
    }
    return { month: currentMonth, totalTokens: 0, totalCost, bonus: 0 };
  }

  const user = await userDb.getUserById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  const currentMonth = getCurrentMonth();
  const usage = user.tokenUsage;

  // If no usage yet, or month has changed → treat as zero
  if (!usage || usage.month !== currentMonth) {
    return { month: currentMonth, totalTokens: 0, totalCost: 0, bonus: 0 };
  }

  return {
    month: currentMonth,
    totalTokens: usage.totalTokens || 0,
    totalCost: usage.totalCost || 0,
    bonus: user.tokenAllowanceBonus || 0,
  };
}

/**
 * Get the token allowance for a user based on their subscription type + bonus.
 */
export async function getUserTokenAllowance(
  userId: string
): Promise<{
  allowance: number | null;
  bonus: number;
  effectiveAllowance: number | null;
  costAllowance: number | null;
  llmUsagePolicy: LlmUsagePolicy | null;
  subscriptionType: string;
}> {
  const subscriptionTypeName = await getUserSubscriptionType(userId);
  const config = await getSubscriptionTypeConfig(subscriptionTypeName);

  const baseAllowance = config?.monthlyTokenAllowance ?? null;
  const costAllowance = config?.monthlyCostAllowance ?? null;
  const llmUsagePolicy = config?.llmUsagePolicy ?? null;
  const user = await userDb.getUserById(userId);
  const bonus = user?.tokenAllowanceBonus || 0;

  if (baseAllowance === null || baseAllowance === undefined) {
    return { allowance: null, bonus, effectiveAllowance: null, costAllowance, llmUsagePolicy, subscriptionType: subscriptionTypeName };
  }

  return {
    allowance: baseAllowance,
    bonus,
    effectiveAllowance: baseAllowance + bonus,
    costAllowance,
    llmUsagePolicy,
    subscriptionType: subscriptionTypeName,
  };
}

/**
 * ENG-668: pass this from a TURN gate — a check that admits a turn about to run — so a PAYG admission
 * is recorded (the month becomes billable, its cap high-water may rise). Any caller that only reads
 * usage passes nothing and writes nothing.
 */
export const TURN_ADMISSION = { recordAdmission: true } as const;

/**
 * Check if a user can send messages. Returns usage status with warning/blocked flags.
 * For org members, quota is checked against the org owner's subscription and usage.
 */
export async function checkTokenUsage(
  userId: string,
  options: { recordAdmission?: boolean; projectedCostMicroUsd?: number; minimumCostUsedMicroUsd?: number } = {},
): Promise<TokenUsageStatus> {
  // ENG-1163: an anonymous predefined-work-plan session (createSessionWithPlan)
  // is owned by a synthetic `anon_<uuid>` id that has no AW-Users row and never
  // will — resolveBillingUserId returns it unchanged (no org to pool onto), and
  // getUserTokenUsage then throws "User not found", which generateSharedResponse
  // does not catch specially: the visitor's very first reply on an anonymous
  // work-plan session came back as a raw error instead of the agent's response.
  // There is no owner to gate spend against by subscription here, but that does
  // NOT mean uncapped: createSessionWithPlan activates interactive sharing on
  // every one of these sessions, and generateSharedResponse's ishare/generate
  // route is the ENG-705 gate meant to bound an anonymous visitor's spend — the
  // only rate limiter on that public route. A strict `anon_` prefix check (not
  // the broader isAnonymousUserId, which also swallowed empty/non-string ids
  // into this same free pass) plus a fixed conservative cost cap keeps that
  // invariant intact instead of trading a crash for unlimited free generation.
  if (typeof userId === 'string' && userId.startsWith('anon_')) {
    let costUsed: number;
    try {
      costUsed = await getAnonymousSessionCostUsedUsd(userId);
    } catch (err) {
      // Fail closed: if we can't verify how much this anon owner has already
      // spent, do not hand out an unlimited allowance — treat as at-cap.
      console.error(`[tokenUsageService] Failed to resolve anon session cost for ${userId}:`, err);
      costUsed = ANONYMOUS_SESSION_COST_CAP_USD;
    }
    const costPercentUsed = computePercentUsed(costUsed, ANONYMOUS_SESSION_COST_CAP_USD);
    return {
      allowed: costUsed < ANONYMOUS_SESSION_COST_CAP_USD,
      warning: costUsed < ANONYMOUS_SESSION_COST_CAP_USD && costPercentUsed >= 80,
      used: 0,
      allowance: null,
      bonus: 0,
      effectiveAllowance: null,
      percentUsed: 0,
      month: getCurrentMonth(),
      costUsed,
      costAllowance: ANONYMOUS_SESSION_COST_CAP_USD,
      costPercentUsed,
      costEnforced: true,
      alertThresholds: resolveAlertThresholds(null),
    };
  }

  const billingUserId = await resolveBillingUserId(userId);
  // ENG-1250 AC7: the gate no longer reads the legacy per-user counter. The month is the clock's,
  // and spend comes from the ledger (below); the counter is consulted only if the rollback path
  // falls back to the legacy basis.
  const month = getCurrentMonth();
  const [{ bonus, costAllowance, llmUsagePolicy, subscriptionType }, billingUser] = await Promise.all([
    getUserTokenAllowance(billingUserId),
    userDb.getUserById(billingUserId),
  ]);

  // Two dimensions are measured — token-count and dollar cost — but only ONE of
  // them gates at a time. Dollars are the real unit of consumption: a token-count
  // cap cannot bound spend once models are priced differently (ENG-207), so a
  // token allowance sized for cheap models silently becomes either a giveaway or,
  // as happened here, a wall. ENFORCE_COST_CAP selects which dimension gates.
  //
  // ENG-1116 — this used to AND the two caps (cost as an *additional* limit).
  // It now REPLACES: with the flag on, cost gates and the token counter is
  // observe-only. Keeping the token cap live alongside cost would defeat the flip
  // entirely, because the token allowances are the thing being retired — four prod
  // users are already past them, one at 1600% of a Free tier's 3M.
  // Versioned admin policy is the explicit cost-gating switch. The legacy env
  // flag retains the same replacement semantics for tiers without a versioned
  // policy: when cost is gated, token volume is observe-only.
  // Cost enforcement is OFF by default (observe-only): we accumulate and surface
  // per-user cost so we can gather real spend data before deciding to gate on it,
  // but we do NOT block users on cost yet. Token-count remains the only hard gate.
  // Per-model pricing is now normalized and accurate (ENG-207 — every model,
  // including Fable, is priced from the shared llmPricing book), so the dollar
  // figure is trustworthy. We still keep the cap observe-only until we've
  // validated real per-user spend against the shadow book. Flip
  // ENFORCE_COST_CAP=true to enable the cost cap; the enforcement path stays
  // tested below.
  const versionedCostPolicyEnforced = !!llmUsagePolicy && llmUsagePolicy.enforcementState !== "observe";
  const enforceCostCap = versionedCostPolicyEnforced || process.env.ENFORCE_COST_CAP === "true";

  // ENG-668: spend basis, credits and the hard-threshold predicate (plus PAYG, for an account that
  // opted in) come from the one decision getEffectiveLlmUsagePolicy also uses, so the two gates
  // cannot disagree about whether this account is paused.
  const pool = await resolveLlmUsagePoolDecision({
    billingUserId,
    billingUser,
    month,
    subscriptionType,
    basePolicy: llmUsagePolicy,
    paygTier: async () => (await getSubscriptionTypeConfig(subscriptionType))?.paygOverage,
    // Lazy: read only if the basis falls back to legacy (rollback path), never on the live ledger path.
    legacyRawCostUsedMicroUsd: async (): Promise<number> =>
      Math.max(0, Math.round(((await getUserTokenUsage(billingUserId)).totalCost || 0) * 1_000_000)),
    recordAdmission: options.recordAdmission === true,
    projectedCostMicroUsd: options.projectedCostMicroUsd,
    minimumCostUsedMicroUsd: options.minimumCostUsedMicroUsd,
  });
  const effectiveLlmUsagePolicy = pool.policy;
  const costUsedMicroUsd = pool.costUsedMicroUsd;
  const usageDecision = pool.mode;
  const effectiveCostAllowance = versionedCostPolicyEnforced
    ? effectiveLlmUsagePolicy!.hardCostThresholdMicroUsd / 1_000_000
    : costAllowance;

  const policyCostUsed = costUsedMicroUsd / 1_000_000;
  const costPercentUsed = computePercentUsed(policyCostUsed, effectiveCostAllowance);

  // A tier with no configured dollar allowance has no cost gate. It used to fall back to its token
  // cap here; the token counter is retired (ENG-1250 AC7), so such a tier is now uncapped until
  // someone prices it. Accepted deliberately for the accounts on those tiers.
  const costIsGate = enforceCostCap && effectiveCostAllowance !== null;

  const costAllowed = effectiveCostAllowance === null || costPercentUsed < 100;
  // Once a versioned cost policy is enforced, raw token volume is observe-only:
  // admission is governed exclusively by provider/model cost. Legacy rows retain
  // the old token gate until an admin explicitly saves a versioned policy.
  // ENG-1250 AC7: there is no token-count gate any more — it needed the retiring counter, and
  // dollars are the unit that actually bounds spend. A tier with neither an enforced policy nor a
  // cost gate is therefore uncapped, deliberately (25 such accounts were identified and accepted).
  const allowed = versionedCostPolicyEnforced
    ? usageDecision.admissionAllowed
    : costIsGate
      ? costAllowed
      : true;

  // Warn only on the dimension that can actually block. Warning about an
  // observe-only cap is the same stale nag ENG-951 removed from customer surfaces.
  const costWarning =
    costIsGate && costPercentUsed >= 80 && costPercentUsed < 100;

  return {
    allowed,
    warning: allowed && costWarning,
    // Token volume is no longer measured (see `allowed` above): null allowance reads as "no token
    // limit" everywhere, which is also what hides the customer usage meter for such tiers.
    used: 0,
    allowance: null,
    bonus,
    effectiveAllowance: null,
    percentUsed: 0,
    month,
    costUsed: policyCostUsed,
    costAllowance: effectiveCostAllowance,
    costPercentUsed: effectiveCostAllowance === null ? 0 : costPercentUsed,
    costEnforced: costIsGate,
    usageMode: versionedCostPolicyEnforced ? usageDecision.usageMode : (allowed ? "full_choice" : "paused"),
    usagePolicyVersion: llmUsagePolicy?.version || null,
    // Always present, always resolved — see the note on the field.
    alertThresholds: resolveAlertThresholds(llmUsagePolicy),
    // ENG-668: present only for an account with PAYG live and past its pool, so every other
    // account's status is exactly what it was.
    ...(pool.overage
      ? {
          overage: {
            // Covering = admitted on PAYG AND spend at or past the pool overage is measured on (even when
            // an opt-in baseline makes none of it billable yet). Admitted BELOW that pool (a downgrade
            // still under this month's high-water pool) is included usage, not PAYG covering anything.
            active: usageDecision.reason === "payg_overage" && pool.costUsedMicroUsd >= pool.overage.poolMicroUsd,
            percentOfCap: pool.overage.percentOfCap,
          },
        }
      : {}),
    // ENG-668: the owner of a suspended account is pointed at the unpaid invoice (the 429's usageBlock).
    ...(pool.paygBlock
      ? { paygBlock: withOwnerOpenInvoice(pool.paygBlock, userId === billingUserId, (billingUser as User | undefined)?.paygSettlements)! }
      : {}),
  };
}

/**
 * Given a usage status, determine whether a *block* was caused by the dollar cost
 * cap rather than the token-count cap (ENG-200). Shared by the scheduled-chat
 * block message (agentModeController) and its email (emailService) so both agree
 * on the reason — a user with an unlimited token allowance can only be blocked by
 * the cost cap, and the message must then read in dollars, not "0 / N/A tokens".
 *
 * Tolerant of partial status objects (the email caller passes a subset): a missing
 * effectiveAllowance falls back to allowance, and missing percentages read as 0.
 */
export function deriveBlockedByCost(status: {
  allowance?: number | null;
  effectiveAllowance?: number | null;
  percentUsed?: number;
  costAllowance?: number | null;
  costPercentUsed?: number;
  costEnforced?: boolean;
}): { costCapTriggered: boolean; tokenCapTriggered: boolean; blockedByCost: boolean } {
  const costCapTriggered =
    status.costAllowance != null && (status.costPercentUsed ?? 0) >= 100;
  const effectiveTokenAllowance =
    status.effectiveAllowance != null ? status.effectiveAllowance : status.allowance;
  const tokenCapTriggered =
    effectiveTokenAllowance != null && (status.percentUsed ?? 0) >= 100;

  // ENG-1116: when cost is the gate, the token counter cannot block anyone, so a
  // block over both caps is a COST block and must be worded in dollars. The old
  // `!tokenCapTriggered` veto was right only while the caps were ANDed — under
  // replacement it would tell a user they had run out of tokens, pointing them at
  // a limit that no longer exists. When cost is not the gate the original
  // attribution stands: a token block reads in tokens.
  const blockedByCost = status.costEnforced
    ? costCapTriggered
    : costCapTriggered && !tokenCapTriggered;

  return { costCapTriggered, tokenCapTriggered, blockedByCost };
}

/**
 * Atomically increment a user's token usage for the current month.
 * For org members, usage is recorded on the org owner's account.
 * Performs lazy monthly reset if the stored month differs from current.
 */
/**
 * ENG-1250 AC7 / ENG-2286 stage 3: the legacy per-user counter (`AW-Users.tokenUsage`, plus the
 * `AW-LlmChargeEvents` audit rows written with it) is no longer maintained. Admission, the usage views,
 * the admin surfaces and itemization all read the spend ledger now, and `recordUsage` writes every call
 * to it independently of this function. Set to `true` to resume the legacy writes (rollback).
 */
export const LEGACY_COUNTER_WRITES_ENV = "AW_LEGACY_TOKEN_COUNTER_WRITES";

export function isLegacyCounterWriteEnabled(): boolean {
  return process.env[LEGACY_COUNTER_WRITES_ENV] === "true";
}

/**
 * Charge a call to the legacy monthly counter. A NO-OP unless `AW_LEGACY_TOKEN_COUNTER_WRITES=true`; the
 * ledger, not this counter, is the record of spend. Retained (not deleted) for one rollback window and
 * removed in stage 4.
 */
export async function incrementUserTokenUsage(
  userId: string,
  tokens: number,
  cost: number,
  audit?: {
    eventId?: string;
    model?: string;
    provider?: string;
    feature?: string;
    sessionId?: string;
    /**
     * ENG-1251 Greptile P1: overrides the charge event's occurredAt. A
     * caller that ALSO writes a paired shadow-ledger row for the same
     * logical usage (internalUsage.ts is the only one today) must derive
     * this from the exact same instant as that row's date -- otherwise two
     * independent `new Date()` calls a few awaits apart can straddle a
     * UTC-midnight boundary, and the itemization reconciliation's
     * (date, model, feature) key no longer matches between the two.
     * Omit for every other caller -- defaults to `new Date()`, unchanged.
     */
    occurredAt?: string;
    /**
     * ENG-1251 Greptile P1: how many underlying calls this ONE charge event
     * represents. internalUsage.ts sums an engine batch's tokens/cost into
     * one charge event per (user, model, feature), so that event can stand
     * in for several calls, not one -- the itemization reconciliation must
     * subtract the true count from the aggregate row's callCount, or a
     * multi-call batch under-subtracts and leaves phantom "uncovered" calls
     * behind. Every other caller charges exactly one call per invocation,
     * so omitting this defaults to 1, unchanged.
     */
    calls?: number;
  }
): Promise<void> {
  if (tokens <= 0 && cost <= 0) return;
  if (!isLegacyCounterWriteEnabled()) return;

  const currentMonth = getCurrentMonth();

  try {
    const billingUserId = await resolveBillingUserId(userId);
    // Persist the evidence before changing the counter. A failed evidence write
    // therefore fails open (no surprise charge), while a retry with the same
    // event id is a no-op rather than a duplicate counter increment.
    //
    // ENG-1251 Greptile P1: the random fallback below only protects a caller
    // that truly has no stable identity for this charge. When the SAME usage
    // report is retried without an eventId, the fallback mints a fresh one
    // every time and the dedup above never fires — so callers that CAN supply
    // a real one must. The two highest-volume paths (agentModeService.callLLM,
    // chatbotService's chat turn) now pass the provider response's own id,
    // which is identical across a re-processed/retried response and distinct
    // across genuinely separate calls. Other callers (image/video/voice/deep
    // research/llmService) still fall through to the random default — each is
    // either structurally called at most once per success today or lacks a
    // verified stable id at the call site; tracked as a fast-follow rather
    // than guessed here.
    const occurredAt = audit?.occurredAt || new Date().toISOString();
    const eventId = audit?.eventId || `${occurredAt}#${randomUUID()}`;
    // ENG-1251 Greptile P1: isNewCharge=false means an event with this ID was
    // ALREADY RECORDED -- it does NOT mean it was already APPLIED. A prior
    // attempt could have recorded the event and then been interrupted before
    // (or during) the atomic apply below -- e.g. a crash, a timeout, or the
    // retry loop below exhausting its attempts. Returning here on
    // isNewCharge=false used to strand that event permanently: eventId is
    // stable across a legitimate retry, so recordLlmChargeEvent would keep
    // returning false for it forever, and the counter would never be
    // charged. So this is intentionally NOT gated on isNewCharge -- always
    // proceed to the atomic apply below; its own idempotency guard
    // (attribute_not_exists(counterAppliedAt) inside applyMonthlyChargeAtomic)
    // is what makes re-attempting a truly-already-applied charge a no-op.
    await recordLlmChargeEvent({
      billingUserId, eventId, occurredAt, actingUserId: userId,
      tokens: Math.max(0, Math.round(tokens)), costMicroUsd: Math.max(0, Math.round(cost * 1_000_000)),
      model: audit?.model, provider: audit?.provider, feature: audit?.feature, sessionId: audit?.sessionId,
      calls: audit?.calls,
    });

    // Apply the counter update and mark the audit event applied atomically —
    // either both land or neither does (ENG-1251 Greptile fix). Previously
    // these were two separate calls: a markLlmChargeApplied failure after a
    // successful counter update silently hid an applied charge from
    // itemization, and a lost concurrency race still marked the event
    // applied even though the counter was never touched. Bounded retry
    // against a fresh read handles a genuine concurrent writer (rollover or
    // same-month increment) the same way the old two-branch logic did.
    const MAX_ATTEMPTS = 3;
    let outcome: "applied" | "already_applied" | "lost_race" | "no_user" = "lost_race";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Greptile P1: getUserById reads through the UserIdIndex GSI, which
      // DynamoDB cannot serve as a strongly consistent read. After a lost
      // race (another writer just committed the counter this attempt is
      // about to retry against), a GSI read can still return the
      // pre-transaction row, so this attempt derives isNewMonth from stale
      // state and fails the SAME way again -- all MAX_ATTEMPTS retries can
      // exhaust on a staleness window rather than genuine repeated
      // contention, silently dropping the charge. getUserByIdConsistent
      // does the same two-step lookup this codebase already uses elsewhere
      // for exactly this guarantee (see its own docstring): resolve the
      // key via the GSI, then a strongly consistent read on the base table.
      const user = await userDb.getUserByIdConsistent(billingUserId);
      if (!user || !user.email) {
        outcome = "no_user";
        break;
      }

      const existingMonth = user.tokenUsage?.month;
      const isNewMonth = existingMonth !== currentMonth;

      let history: Array<{ month: string; totalTokens: number; totalCost: number }> | undefined;
      if (isNewMonth) {
        // New month — archive previous month to history, reset usage, clear bonus.
        const prevUsage = user.tokenUsage;
        const existingHistory = user.tokenUsageHistory || [];
        history = existingHistory;
        if (prevUsage && prevUsage.month) {
          const entry = { month: prevUsage.month, totalTokens: prevUsage.totalTokens, totalCost: prevUsage.totalCost };
          history = [...existingHistory, entry].slice(-24);
        }
      }

      outcome = await userDb.applyMonthlyChargeAtomic({
        userId: billingUserId,
        userEmail: user.email,
        month: currentMonth,
        tokens,
        cost,
        resetDate: isNewMonth ? getNextResetDate() : (user.tokenUsage?.resetDate || getNextResetDate()),
        isNewMonth,
        history,
        auditTableName: LLM_CHARGE_EVENTS_TABLE,
        billingUserId,
        eventId,
      });

      if (outcome === "applied" || outcome === "already_applied") break;
      // outcome === "lost_race": another writer rolled the month or incremented
      // this user concurrently — re-read fresh state and retry.
    }

    if (outcome === "lost_race") {
      // Exhausted retries under real contention. Fail open, per the same
      // contract recordLlmChargeEvent already documents: the counter is NOT
      // incremented, and the audit event is left unmarked rather than
      // falsely claiming the charge was applied.
      console.warn(
        `[tokenUsageService] Failed to atomically apply charge for ${billingUserId} after ${MAX_ATTEMPTS} attempts ` +
        `(eventId=${eventId}): concurrent writers kept winning the race. Charge NOT counted.`
      );
    }
  } catch (error) {
    // Don't block message flow on usage tracking failures
    console.error(`[tokenUsageService] Failed to increment usage for ${userId}:`, error);
  }
}

/**
 * Grant bonus tokens to a user (additive to any existing bonus).
 */
export async function grantTokenBonus(
  userId: string,
  bonusTokens: number
): Promise<void> {
  const user = await userDb.getUserById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);

  const currentBonus = user.tokenAllowanceBonus || 0;
  await userDb.updateUser(userId, {
    tokenAllowanceBonus: currentBonus + bonusTokens,
  });
}
