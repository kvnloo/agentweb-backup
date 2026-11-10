/**
 * ENG-2890 (ENG-1970.3): deterministic rollback-plan builder.
 *
 * Given a PROPOSED provider mutation (the ENG-2775 classifier's payload shape
 * plus the target entity id) and the pre-change entity snapshot the caller
 * already holds, returns the exact inverse mutation that restores the
 * snapshot, or `{ reversible: false, reason }`.
 *
 * Contract:
 *   - PURE + deterministic: no I/O, no clock, no LLM. Same input -> same output.
 *   - Reversible: status changes (pause/kill/activate), budget edits and bid
 *     edits on an ad/adset/campaign. The inverse restores the snapshot value.
 *   - Fail closed: deletes, conversion-definition, targeting, creative,
 *     account-wide and unknown actions; missing/mismatched snapshot (entity id
 *     or object level differs, field absent) -> reversible:false, never a guess.
 *   - Consistency: classification comes from `classifyMarketingActionRisk`, so
 *     every action that classifier marks reversible_low gets a plan here when a
 *     valid snapshot is supplied.
 *
 * SHADOW ONLY: no execution path consults this; no provider writes.
 */
import {
  classifyMarketingActionRisk,
  MarketingActionObjectLevel,
  MarketingActionRiskClass,
  MarketingActionRiskInput,
} from './marketingActionRisk';

export type RollbackField = 'status' | 'dailyBudget' | 'bidAmount';

export interface RollbackEntitySnapshot {
  entityId: string;
  objectLevel: MarketingActionObjectLevel | string;
  status?: string;
  dailyBudget?: number;
  bidAmount?: number;
}

export interface RollbackPlanInput extends MarketingActionRiskInput {
  entityId: string;
}

export interface RollbackMutation {
  objectLevel: Exclude<MarketingActionObjectLevel, 'account'>;
  entityId: string;
  field: RollbackField;
  value: string | number;
}

export type RollbackPlan =
  | { reversible: true; riskClass: MarketingActionRiskClass; inverse: RollbackMutation; reason: string }
  | { reversible: false; riskClass: MarketingActionRiskClass; reason: string };

const STATUS_CLASSES: readonly MarketingActionRiskClass[] = ['reversible_low', 'activation'];
const SPEND_CLASSES: readonly MarketingActionRiskClass[] = ['spend_increase', 'spend_decrease'];
const ENTITY_LEVELS: readonly string[] = ['ad', 'adset', 'campaign'];

function fieldFor(riskClass: MarketingActionRiskClass, actionType: string): RollbackField | undefined {
  if (STATUS_CLASSES.includes(riskClass)) return 'status';
  if (SPEND_CLASSES.includes(riskClass)) {
    if (/budget/.test(actionType)) return 'dailyBudget';
    if (/bid/.test(actionType)) return 'bidAmount';
  }
  return undefined;
}

function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

export function buildMarketingActionRollbackPlan(
  input: RollbackPlanInput | null | undefined,
  snapshot: RollbackEntitySnapshot | null | undefined,
): RollbackPlan {
  const { riskClass } = classifyMarketingActionRisk(input);
  const no = (reason: string): RollbackPlan => ({ reversible: false, riskClass, reason });

  const actionType = norm(input?.actionType);
  const field = fieldFor(riskClass, actionType);
  if (!field) return no(`${riskClass} action "${actionType}" has no safe inverse; fail closed`);

  const level = norm(input?.objectLevel);
  if (!ENTITY_LEVELS.includes(level)) return no(`object level "${level}" not rollback-eligible; fail closed`);
  // A level-qualified verb must agree with objectLevel (classifier only checks pause/kill).
  const verbLevel = /_(adset|ad|campaign)$/.exec(actionType)?.[1];
  if (verbLevel && verbLevel !== level) return no(`${actionType} names a ${verbLevel} but objectLevel is ${level}`);

  const entityId = typeof input?.entityId === 'string' ? input.entityId.trim() : '';
  if (!entityId) return no('missing entity id; fail closed');
  if (!snapshot) return no('missing pre-change snapshot; fail closed');
  if (typeof snapshot.entityId !== 'string' || snapshot.entityId.trim() !== entityId) {
    return no('snapshot entity id does not match target; fail closed');
  }
  if (norm(snapshot.objectLevel) !== level) return no('snapshot object level does not match target; fail closed');

  const raw = snapshot[field];
  const valid =
    field === 'status'
      ? typeof raw === 'string' && raw.trim() !== ''
      : typeof raw === 'number' && Number.isFinite(raw) && raw >= 0;
  if (!valid) return no(`snapshot lacks a valid ${field}; fail closed`);

  return {
    reversible: true,
    riskClass,
    inverse: {
      objectLevel: level as RollbackMutation['objectLevel'],
      entityId,
      field,
      value: field === 'status' ? (raw as string).trim() : (raw as number),
    },
    reason: `restore ${level} ${entityId} ${field} to snapshot value`,
  };
}
