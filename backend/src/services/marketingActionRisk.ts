/**
 * ENG-2775 (ENG-1970.1): deterministic campaign-action risk classifier.
 *
 * Classifies a PROPOSED provider mutation (Meta/Google campaign/adset/ad
 * change) into a risk class and the authorization it requires. Policy half of
 * ENG-1970's first slice; reuses the ENG-445 `actionType` vocabulary.
 *
 * Contract:
 *   - PURE + deterministic: no I/O, no clock, no LLM, no tenant lookups. The
 *     same payload always yields the same classification (table-driven).
 *   - Only pausing/killing an OWNED ad or adset is `reversible_low` and may
 *     run without approval. Spend increases, conversion-definition, targeting,
 *     activation, destructive, and account-wide changes always require
 *     approval — never auto (spend-increasing auto-actions are out of scope
 *     per the ENG-1991 ruling).
 *   - Fail closed: unknown action types, missing/unknown object levels, and
 *     unproven ownership all require approval.
 *
 * SHADOW ONLY: nothing in an execution path consults this result yet. The
 * producer exposes it through an optional observer (see
 * `candidatesFromRecommendations`); no behavior changes.
 */

export type MarketingActionRiskClass =
  | 'reversible_low'
  | 'creative_change'
  | 'spend_increase'
  | 'spend_decrease'
  | 'conversion_definition'
  | 'targeting'
  | 'activation'
  | 'destructive'
  | 'account_wide'
  | 'unknown';

export type MarketingActionObjectLevel = 'ad' | 'adset' | 'campaign' | 'account';

export interface MarketingActionRiskInput {
  /** ENG-445 action verb, e.g. "pause_ad", "scale_budget". */
  actionType: string;
  /** Provider object the mutation targets. Missing → fail closed. */
  objectLevel?: MarketingActionObjectLevel | string;
  /** True only when the object is proven to be Emma/AgentWeb-owned. */
  owned?: boolean;
}

export interface MarketingActionRiskClassification {
  riskClass: MarketingActionRiskClass;
  requiresApproval: boolean;
  reason: string;
}

/** Action verb → base class. Keys are normalized (trim + lowercase). */
const ACTION_CLASS: Readonly<Record<string, MarketingActionRiskClass>> = Object.freeze({
  pause: 'reversible_low',
  pause_ad: 'reversible_low',
  pause_adset: 'reversible_low',
  pause_campaign: 'reversible_low',
  kill: 'reversible_low',
  kill_ad: 'reversible_low',
  kill_adset: 'reversible_low',
  refresh_creative: 'creative_change',
  swap_creative: 'creative_change',
  update_creative: 'creative_change',
  scale_budget: 'spend_increase',
  increase_budget: 'spend_increase',
  raise_bid: 'spend_increase',
  increase_bid: 'spend_increase',
  decrease_budget: 'spend_decrease',
  lower_bid: 'spend_decrease',
  update_conversion: 'conversion_definition',
  change_conversion_event: 'conversion_definition',
  change_optimization_goal: 'conversion_definition',
  update_targeting: 'targeting',
  expand_audience: 'targeting',
  narrow_audience: 'targeting',
  change_placements: 'targeting',
  activate: 'activation',
  activate_ad: 'activation',
  activate_adset: 'activation',
  activate_campaign: 'activation',
  resume: 'activation',
  launch_campaign: 'activation',
  delete: 'destructive',
  delete_ad: 'destructive',
  delete_adset: 'destructive',
  delete_campaign: 'destructive',
  archive_campaign: 'destructive',
  change_account_spend_limit: 'account_wide',
  update_account_settings: 'account_wide',
  change_billing: 'account_wide',
});

const OBJECT_LEVELS: readonly MarketingActionObjectLevel[] = ['ad', 'adset', 'campaign', 'account'];
/** Object levels where a pause/kill may be auto (reversible, bounded blast radius). */
const LOW_RISK_LEVELS: readonly MarketingActionObjectLevel[] = ['ad', 'adset'];

function approval(riskClass: MarketingActionRiskClass, reason: string): MarketingActionRiskClassification {
  return { riskClass, requiresApproval: true, reason };
}

export function classifyMarketingActionRisk(
  input: MarketingActionRiskInput | null | undefined,
): MarketingActionRiskClassification {
  const actionType =
    input && typeof input.actionType === 'string' ? input.actionType.trim().toLowerCase() : '';
  if (!actionType) return approval('unknown', 'missing action type; fail closed');

  const base = Object.prototype.hasOwnProperty.call(ACTION_CLASS, actionType)
    ? ACTION_CLASS[actionType]
    : undefined;
  if (!base) return approval('unknown', `unrecognized action type "${actionType}"; fail closed`);

  const rawLevel = typeof input?.objectLevel === 'string' ? input.objectLevel.trim().toLowerCase() : '';
  const level = (OBJECT_LEVELS as readonly string[]).includes(rawLevel)
    ? (rawLevel as MarketingActionObjectLevel)
    : undefined;

  if (level === 'account') {
    return approval('account_wide', `${actionType} at account level is account-wide`);
  }

  if (base !== 'reversible_low') {
    return approval(base, `${actionType} is ${base.replace(/_/g, '-')}; approval required`);
  }

  // Pause/kill: auto only for an owned ad/adset.
  if (!level) return approval('unknown', `${actionType} has no recognized object level; fail closed`);
  // A level-qualified verb (pause_campaign) must agree with objectLevel, so a
  // campaign action labelled as an ad cannot reach the auto branch.
  const verbLevel = /_(adset|ad|campaign)$/.exec(actionType)?.[1];
  if (verbLevel && verbLevel !== level) {
    return approval('unknown', `${actionType} names a ${verbLevel} but objectLevel is ${level}; fail closed`);
  }
  if (!(LOW_RISK_LEVELS as readonly string[]).includes(level)) {
    return approval('reversible_low', `${actionType} on a ${level} exceeds ad/adset blast radius`);
  }
  if (input?.owned !== true) {
    return approval('reversible_low', `${actionType} target ${level} not proven owned; fail closed`);
  }
  return {
    riskClass: 'reversible_low',
    requiresApproval: false,
    reason: `${actionType} on an owned ${level} is reversible and low risk`,
  };
}
