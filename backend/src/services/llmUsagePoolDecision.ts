/**
 * The ONE pool decision both admission gates reach (ENG-668).
 *
 * `checkTokenUsage` (gate 1, the 429 before any work starts) and `getEffectiveLlmUsagePolicy` (gate 2,
 * which `resolveEffectiveModelForUser` turns into a `blocked` model decision for /generate, scheduled
 * runs and Compare) used to each run this pipeline inline: raw spend basis -> credit adjustment ->
 * `evaluateLlmUsageMode`. The copies were identical, which is the only reason the two gates agreed.
 * PAYG adds a step that must apply in BOTH or neither — a turn gate 1 admits and gate 2 refuses is a
 * 429 after the user already saw it accepted — so the pipeline now exists exactly once, here.
 *
 * For an account that has never stored a PAYG opt-in this does precisely what both gates did before: no
 * extra read, no write, the same decision object. The switch and the high-water mark are reached only
 * for a billing owner whose row carries a `paygOverage` record (on or off — the mark is kept while off,
 * see below); the PAYG evaluation only when that record says `enabled === true`. The decision for an
 * account whose opt-in is off is always the base decision.
 */
import type { User } from './db';
import { userDb } from './db';
import {
  applyLlmUsageCredits,
  getCurrentUsageMonth,
  getLlmUsageCreditAdjustment,
  getRevocablePurchasedCreditMicroUsd,
  type LlmUsageCreditAdjustment,
} from './llmUsageCreditService';
import { evaluateLlmUsageMode, type LlmUsageModeDecision, type LlmUsagePolicy } from './llmUsagePolicyService';
import { resolveEnforcementCostBasisMicroUsd } from './spendEnforcementBasis';
import {
  evaluatePaygAdmission,
  paygOverageThresholdMicroUsd,
  type PaygBlock,
  type PaygOverageSettings,
  type PaygOverageStatus,
  type SubscriptionPaygOverageConfig,
} from './paygOverage';

export interface LlmUsagePoolDecision {
  /** The tier policy with its hard threshold raised by this month's credits; null when none is configured. */
  policy: LlmUsagePolicy | null;
  /** Spend after migration offsets, in micro-USD. */
  costUsedMicroUsd: number;
  adjustment: LlmUsageCreditAdjustment;
  mode: LlmUsageModeDecision;
  /** Non-null only while a PAYG-enabled account is past its pool (see `evaluatePaygAdmission`). */
  overage: PaygOverageStatus | null;
  paygBlock: PaygBlock | null;
}

export async function resolveLlmUsagePoolDecision(input: {
  billingUserId: string;
  /**
   * The billing owner's row, already read by the gate. Re-read (strongly consistent) only for a
   * PAYG-enabled account past its pool, where its PAYG state decides admission.
   */
  billingUser: PoolBillingOwner | null | undefined;
  /** The gate's billing month (the credit ledger's key). */
  month: string;
  subscriptionType: string;
  basePolicy: LlmUsagePolicy | null;
  /** The tier's PAYG config. Lazy: read only for a billing owner who opted in. */
  paygTier: () => Promise<SubscriptionPaygOverageConfig | null | undefined>;
  /** Lazy: read only if the basis falls back to legacy (rollback path), never on the live ledger path. */
  legacyRawCostUsedMicroUsd: () => Promise<number>;
}): Promise<LlmUsagePoolDecision> {
  const { billingUserId, billingUser, month, basePolicy } = input;
  // ENG-1250 §9.6 enforcement cutover (dark by default): swap the raw spend basis
  // onto the vendor-inclusive spend ledger and leave the rest of this pipeline —
  // credit application, threshold, predicate — untouched. See spendEnforcementBasis.ts.
  const { rawCostUsedMicroUsd } = await resolveEnforcementCostBasisMicroUsd({
    billingUserId,
    billingMonth: month,
    legacyRawCostUsedMicroUsd: input.legacyRawCostUsedMicroUsd,
    tier: input.subscriptionType,
  });
  const adjustment = getLlmUsageCreditAdjustment(billingUser?.llmUsageCredits, month);
  const adjusted = basePolicy
    ? applyLlmUsageCredits({
        rawCostUsedMicroUsd,
        hardThresholdMicroUsd: basePolicy.hardCostThresholdMicroUsd,
        adjustment,
      })
    : { policyCostUsedMicroUsd: rawCostUsedMicroUsd, effectiveHardThresholdMicroUsd: 0 };
  const policy = basePolicy
    ? { ...basePolicy, hardCostThresholdMicroUsd: adjusted.effectiveHardThresholdMicroUsd }
    : null;
  const costUsedMicroUsd = adjusted.policyCostUsedMicroUsd;
  const mode = evaluateLlmUsageMode({ costUsedMicroUsd, policy });
  const base: LlmUsagePoolDecision = {
    policy,
    costUsedMicroUsd,
    adjustment,
    mode,
    overage: null,
    paygBlock: null,
  };

  // Opt-in is per billing owner and the row is already in hand, so every account that never stored a
  // PAYG record stops here: no switch read, no write. `policy_not_enforced` has no pool to go past.
  const account = billingUser?.paygOverage;
  if (!account || !policy || mode.reason === 'policy_not_enforced') return base;
  const { paygOverageSwitch } = await import('./paygOverageService');
  if (!(await paygOverageSwitch.isEnabled())) return base;
  const paygTier = await input.paygTier();
  if (paygTier?.allowed !== true) return base;

  const usageMonth = getCurrentUsageMonth();
  // Past the pool, the PAYG state decides admission, so read it strongly consistent. `billingUser` came
  // through UserIdIndex, an eventually consistent GSI: a snapshot a moment old can miss a high-water
  // mark raised just before a downgrade (measuring overage against the smaller pool and blocking usage
  // the earlier pool still covers), or an opt-out the owner just made. Below the pool nothing is decided
  // here, so the snapshot is enough and no extra read is paid. A failed read keeps the snapshot.
  let owner: PoolBillingOwner = billingUser!;
  if (account.enabled === true && mode.reason === 'hard_threshold_reached') {
    const fresh = await readOwnerConsistently(billingUserId);
    if (fresh) {
      if (!fresh.paygOverage) return base;
      owner = fresh;
    }
  }
  const ownerAccount = owner.paygOverage!;
  // The mark is kept for a stored opt-in even while PAYG is OFF. A same-month re-enable keeps the
  // month's opt-in baseline, so the pool it is measured against must include any larger pool the month
  // had while PAYG was off — otherwise usage that pool included (upgrade, spend, downgrade, re-enable)
  // would be counted, and billed, as overage. Written only when it rises, as for an enabled opt-in.
  // The mark leaves out top-up credit a refund or dispute can still revoke: a live top-up already
  // extends today's pool (the overage threshold is the larger of the two), and once revoked it must not
  // linger in the mark as capacity nobody paid for. Seat and admin credit stay in it.
  const poolHighWater = await recordPoolHighWater({
    billingUserId,
    account: ownerAccount,
    month: usageMonth,
    thresholdMicroUsd: Math.max(
      0,
      policy.hardCostThresholdMicroUsd - getRevocablePurchasedCreditMicroUsd(billingUser?.llmUsageCredits, month),
    ),
  });
  // Only an opt-in that is ON is ever evaluated; an OFF one keeps today's decision exactly.
  if (ownerAccount.enabled !== true) return base;
  const payg = evaluatePaygAdmission({
    decision: mode,
    switchOn: true,
    tier: paygTier,
    account: { ...ownerAccount, ...(poolHighWater ? { poolHighWater } : {}) },
    hasPaymentMethod: owner.has_payment_method,
    subscriptionStatus: owner.subscription_status,
    costUsedMicroUsd,
    overageThresholdMicroUsd: paygOverageThresholdMicroUsd({
      effectiveHardThresholdMicroUsd: policy.hardCostThresholdMicroUsd,
      poolHighWater,
      month: usageMonth,
    }),
    month: usageMonth,
  });
  return { ...base, mode: payg.decision, overage: payg.overage, paygBlock: payg.block };
}

type PoolBillingOwner = Pick<User, 'llmUsageCredits' | 'paygOverage' | 'has_payment_method' | 'subscription_status'>;

/** The billing owner's row, strongly consistent; null when it cannot be read (the caller keeps its snapshot). */
async function readOwnerConsistently(billingUserId: string): Promise<PoolBillingOwner | null> {
  try {
    return ((await userDb.getUserByIdConsistent(billingUserId)) as PoolBillingOwner | undefined) ?? null;
  } catch (error: any) {
    console.error(`[paygOverage] Consistent read of ${billingUserId} failed; using the indexed snapshot:`, error?.message || error);
    return null;
  }
}

/**
 * Raise this month's pool high-water mark when today's effective threshold is above it, and return the
 * mark the check should measure against.
 *
 * Written only when it rises, and conditionally on the stored mark still being lower, so two gates
 * (or two instances) racing on the same check cannot lower it. It is NOT the settings version: the
 * settings route writes only its own fields, so the two never overwrite each other.
 *
 * Losing that condition means someone stored an equal-or-higher mark this read did not see. The check
 * then re-reads the row strongly consistent and uses that mark — measuring against the lower one it
 * holds would count usage the higher pool still covers as overage. Any other failure is logged and the
 * check continues on the in-memory maximum, which is what the write would have stored.
 */
async function recordPoolHighWater(input: {
  billingUserId: string;
  account: PaygOverageSettings;
  month: string;
  thresholdMicroUsd: number;
}): Promise<PaygOverageSettings['poolHighWater']> {
  const stored = input.account.poolHighWater;
  if (stored?.month === input.month && stored.thresholdMicroUsd >= input.thresholdMicroUsd) return stored;
  const ours = { month: input.month, thresholdMicroUsd: input.thresholdMicroUsd };
  try {
    await userDb.updateUser(input.billingUserId, {}, {
      pathSets: [{ path: ['paygOverage', 'poolHighWater'], value: ours }],
      condition: {
        expression:
          'attribute_exists(#payg) AND (attribute_not_exists(#payg.#hw) OR #payg.#hw.#month <> :hwMonth OR #payg.#hw.#threshold < :hwThreshold)',
        names: { '#payg': 'paygOverage', '#hw': 'poolHighWater', '#month': 'month', '#threshold': 'thresholdMicroUsd' },
        values: { ':hwMonth': input.month, ':hwThreshold': input.thresholdMicroUsd },
      },
    });
    return ours;
  } catch (error: any) {
    if (error?.code !== 'ConditionalCheckFailedException') {
      console.error(`[paygOverage] Failed to record the pool high-water mark for ${input.billingUserId}:`, error?.message || error);
      return ours;
    }
    // Lost to an equal-or-higher mark: use it.
    const current = (await readOwnerConsistently(input.billingUserId))?.paygOverage?.poolHighWater;
    return current?.month === input.month && Number.isFinite(current.thresholdMicroUsd)
      && current.thresholdMicroUsd > input.thresholdMicroUsd
      ? current
      : ours;
  }
}
