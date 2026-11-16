/**
 * ENG-2890 (ENG-1970.3): pure rollback-plan builder for reversible campaign
 * actions.
 *
 * Given a PROPOSED provider mutation (the ENG-2775 classifier payload plus the
 * target entity id) and the pre-change entity snapshot the caller already
 * holds, returns the exact inverse mutation that restores the snapshot, or
 * `{ reversible: false, reason }`.
 *
 * Contract:
 *   - PURE + deterministic: no I/O, no clock, no LLM. Same input → same output.
 *   - Only status (pause/kill/activate/resume), budget, and bid edits on an
 *     OWNED ad/adset/campaign are reversible. Deletes, conversion-definition,
 *     targeting, creative, account-wide, and unknown actions fail closed.
 *   - Never guesses: a missing snapshot, an entity-id mismatch, or an absent
 *     snapshot field returns reversible:false.
 *
 * SHADOW ONLY: nothing calls this in an execution path; no provider writes.
 */

import {
  classifyMarketingActionRisk,
  type MarketingActionRiskInput,
} from './marketingActionRisk';

export type RollbackField = 'status' | 'dailyBudget' | 'bidAmount';
export type RollbackObjectLevel = 'ad' | 'adset' | 'campaign';

export interface RollbackActionInput extends MarketingActionRiskInput {
  /** Provider id of the entity the mutation targets. */
  entityId?: string;
}

export interface RollbackEntitySnapshot {
  entityId?: string;
  status?: string;
  dailyBudget?: number;
  bidAmount?: number;
}

export interface RollbackMutation {
  actionType: 'set_status' | 'set_daily_budget' | 'set_bid_amount';
  objectLevel: RollbackObjectLevel;
  entityId: string;
  field: RollbackField;
  value: string | number;
}

export type RollbackPlan =
  | { reversible: true; inverse: RollbackMutation; reason: string }
  | { reversible: false; reason: string };

const FIELD_FOR_CLASS: Readonly<Record<string, RollbackField>> = Object.freeze({
  reversible_low: 'status',
  activation: 'status',
});

const BUDGET_VERBS = new Set(['scale_budget', 'increase_budget', 'decrease_budget']);
const BID_VERBS = new Set(['raise_bid', 'increase_bid', 'lower_bid']);
/** activation verbs that re-enable an existing entity (launch creates one). */
const NON_REVERSIBLE_ACTIVATION = new Set(['launch_campaign']);

const INVERSE_ACTION: Readonly<Record<RollbackField, RollbackMutation['actionType']>> = Object.freeze({
  status: 'set_status',
  dailyBudget: 'set_daily_budget',
  bidAmount: 'set_bid_amount',
});

const LEVELS: readonly RollbackObjectLevel[] = ['ad', 'adset', 'campaign'];

function no(reason: string): RollbackPlan {
  return { reversible: false, reason };
}

function snapshotValue(snapshot: RollbackEntitySnapshot, field: RollbackField): string | number | undefined {
  const v = snapshot[field];
  if (field === 'status') return typeof v === 'string' && v.trim() ? v : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function buildRollbackPlan(
  action: RollbackActionInput | null | undefined,
  snapshot: RollbackEntitySnapshot | null | undefined,
): RollbackPlan {
  if (!action || typeof action !== 'object') return no('missing action; fail closed');
  const classification = classifyMarketingActionRisk(action);
  const actionType = typeof action.actionType === 'string' ? action.actionType.trim().toLowerCase() : '';

  let field: RollbackField | undefined;
  if (BUDGET_VERBS.has(actionType)) field = 'dailyBudget';
  else if (BID_VERBS.has(actionType)) field = 'bidAmount';
  else if (!NON_REVERSIBLE_ACTIVATION.has(actionType)) field = FIELD_FOR_CLASS[classification.riskClass];
  if (!field) {
    return no(`${actionType || 'action'} is ${classification.riskClass.replace(/_/g, '-')}; not reversible`);
  }

  const rawLevel = typeof action.objectLevel === 'string' ? action.objectLevel.trim().toLowerCase() : '';
  if (!(LEVELS as readonly string[]).includes(rawLevel)) {
    return no(`${actionType} has no reversible object level; fail closed`);
  }
  const level = rawLevel as RollbackObjectLevel;
  const verbLevel = /_(adset|ad|campaign)$/.exec(actionType)?.[1];
  if (verbLevel && verbLevel !== level) {
    return no(`${actionType} names a ${verbLevel} but objectLevel is ${level}; fail closed`);
  }
  if (action.owned !== true) return no(`${actionType} target not proven owned; fail closed`);

  const entityId = typeof action.entityId === 'string' ? action.entityId.trim() : '';
  if (!entityId) return no('missing entity id; fail closed');
  if (!snapshot || typeof snapshot !== 'object') return no('missing pre-change snapshot; fail closed');
  if (typeof snapshot.entityId !== 'string' || snapshot.entityId.trim() !== entityId) {
    return no('snapshot entity id does not match action; fail closed');
  }
  const value = snapshotValue(snapshot, field);
  if (value === undefined) return no(`snapshot lacks ${field}; fail closed`);

  return {
    reversible: true,
    inverse: { actionType: INVERSE_ACTION[field], objectLevel: level, entityId, field, value },
    reason: `restore ${level} ${field} to snapshot value`,
  };
}
