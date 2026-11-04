/**
 * ENG-2797 (ENG-1970.4): execution-authorization gate + rollback-inverse builder.
 *
 * Builds on the ENG-2775 risk classifier (`marketingActionRisk.ts`). ENG-1970
 * outcome 3: execute only authorized, reversible actions; outcome 4 (rollback
 * half): every executed mutation has an exact inverse.
 *
 * Contract:
 *   - PURE + deterministic: no provider/network calls, no persistence, no clock.
 *   - SHADOW ONLY: exported and unit-tested; nothing in a live execution path
 *     consults it yet. Persisting staged payloads/receipts is ENG-2776.
 *   - Fail closed: anything not proven authorized AND reversible is refused.
 */
import { createHash } from 'crypto';
import { classifyMarketingActionRisk } from './marketingActionRisk';
import type {
  MarketingActionObjectLevel,
  MarketingActionRiskClass,
  MarketingActionRiskClassification,
} from './marketingActionRisk';

export interface ProposedMarketingMutation {
  /** ENG-445 action verb, e.g. "pause_ad". */
  actionType: string;
  objectLevel?: MarketingActionObjectLevel | string;
  /** Provider object id the mutation targets. */
  objectId: string;
  owned?: boolean;
  /** Provider fields the mutation sets, e.g. { status: 'PAUSED' }. */
  changes: Readonly<Record<string, unknown>>;
}

export interface MarketingMutationApproval {
  /** `hashMarketingMutation` of the exact payload the approver saw. */
  payloadHash: string;
}

export interface ExecutionAuthorization {
  allowed: boolean;
  reason: string;
}

export type ProviderState = Readonly<Record<string, unknown>>;

/** Classes whose effect cannot be exactly inverted. */
const IRREVERSIBLE_CLASSES: ReadonlySet<MarketingActionRiskClass> = new Set<MarketingActionRiskClass>([
  'destructive',
  'conversion_definition',
  'account_wide',
  'unknown',
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    // Null prototype: an own `__proto__` key stays an ordinary own property.
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable sha256 over every field of the mutation (key-order independent). */
export function hashMarketingMutation(mutation: ProposedMarketingMutation): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(mutation))).digest('hex');
}

export function isReversibleRiskClass(riskClass: MarketingActionRiskClass): boolean {
  return !IRREVERSIBLE_CLASSES.has(riskClass);
}

export function authorizeExecution(
  proposedMutation: ProposedMarketingMutation | null | undefined,
  classification: MarketingActionRiskClassification | null | undefined,
  approval?: MarketingMutationApproval | null,
): ExecutionAuthorization {
  if (!proposedMutation || !classification) {
    return { allowed: false, reason: 'missing mutation or classification; fail closed' };
  }
  // Bind the classification to this exact mutation: a classification produced
  // for a different (e.g. owned pause_ad) action must never authorize this one.
  const derived = classifyMarketingActionRisk(proposedMutation);
  if (
    derived.riskClass !== classification.riskClass ||
    derived.requiresApproval !== classification.requiresApproval
  ) {
    return { allowed: false, reason: 'classification does not match the proposed mutation; fail closed' };
  }
  if (!isReversibleRiskClass(classification.riskClass)) {
    return { allowed: false, reason: `${classification.riskClass} mutations are irreversible; never executed` };
  }
  if (!classification.requiresApproval) {
    return { allowed: true, reason: `standing authorization: ${classification.reason}` };
  }
  if (!approval || typeof approval.payloadHash !== 'string' || !approval.payloadHash) {
    return { allowed: false, reason: `${classification.riskClass} requires explicit approval; none supplied` };
  }
  if (approval.payloadHash !== hashMarketingMutation(proposedMutation)) {
    return { allowed: false, reason: 'approval payload hash does not match the proposed mutation' };
  }
  return { allowed: true, reason: `approved exact payload for ${classification.riskClass}` };
}

/** Verb-level inverse; the restored field values come from prior state. */
const INVERSE_ACTION: Readonly<Record<string, string>> = Object.freeze({
  pause: 'activate',
  pause_ad: 'activate_ad',
  pause_adset: 'activate_adset',
  pause_campaign: 'activate_campaign',
  kill: 'activate',
  kill_ad: 'activate_ad',
  kill_adset: 'activate_adset',
  activate: 'pause',
  activate_ad: 'pause_ad',
  activate_adset: 'pause_adset',
  activate_campaign: 'pause_campaign',
  resume: 'pause',
  launch_campaign: 'pause_campaign',
  scale_budget: 'decrease_budget',
  increase_budget: 'decrease_budget',
  decrease_budget: 'increase_budget',
  raise_bid: 'lower_bid',
  increase_bid: 'lower_bid',
  lower_bid: 'increase_bid',
  refresh_creative: 'update_creative',
  swap_creative: 'update_creative',
  update_creative: 'update_creative',
  update_targeting: 'update_targeting',
  expand_audience: 'update_targeting',
  narrow_audience: 'update_targeting',
  change_placements: 'change_placements',
});

/**
 * Exact inverse of `proposedMutation`, restoring every changed field to its
 * value in `priorProviderState`. Returns null (irreversible) for verbs without
 * an inverse (deletes, conversion-definition, account-wide), account-level
 * targets, empty changes, or any changed field missing from prior state.
 */
export function buildRollback(
  proposedMutation: ProposedMarketingMutation | null | undefined,
  priorProviderState: ProviderState | null | undefined,
): ProposedMarketingMutation | null {
  if (!proposedMutation || !priorProviderState) return null;
  const actionType =
    typeof proposedMutation.actionType === 'string' ? proposedMutation.actionType.trim().toLowerCase() : '';
  if (!Object.prototype.hasOwnProperty.call(INVERSE_ACTION, actionType)) return null;
  const level =
    typeof proposedMutation.objectLevel === 'string' ? proposedMutation.objectLevel.trim().toLowerCase() : '';
  if (level === 'account') return null;
  const keys = Object.keys(proposedMutation.changes ?? {});
  if (keys.length === 0) return null;
  const changes: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(priorProviderState, key)) return null;
    changes[key] = priorProviderState[key];
  }
  return {
    actionType: INVERSE_ACTION[actionType],
    objectLevel: proposedMutation.objectLevel,
    objectId: proposedMutation.objectId,
    owned: proposedMutation.owned,
    changes,
  };
}
