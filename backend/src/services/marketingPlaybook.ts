/**
 * ENG-2891 (ENG-1970.4): pure versioned campaign-playbook model, validator,
 * and diff.
 *
 * A playbook is an ordered list of proposed provider mutations (steps) that
 * use the ENG-2775 action vocabulary. `validatePlaybook` enforces:
 *   - well-formed id + semver-ish version (MAJOR.MINOR.PATCH),
 *   - known action types (ENG-2775 classifier, fail closed on `unknown`),
 *   - unique step ids,
 *   - every HIGH-risk step (see HIGH_RISK_CLASSES) carries a rollback plan the
 *     ENG-2890 builder proves reversible from the step's own snapshot.
 * `diffPlaybooks` returns added/removed/changed step ids, sorted.
 *
 * PURE + deterministic: no I/O, no clock, no persistence (ENG-2776 owns
 * storage). SHADOW ONLY: not wired into any runtime path.
 */

import {
  classifyMarketingActionRisk,
  type MarketingActionRiskClass,
} from './marketingActionRisk';
import { buildRollbackPlan, type RollbackEntitySnapshot } from './marketingActionRollback';

export interface PlaybookStep {
  id: string;
  actionType: string;
  objectLevel?: string;
  owned?: boolean;
  entityId?: string;
  /** Pre-change snapshot used to prove the step can be rolled back. */
  snapshot?: RollbackEntitySnapshot;
}

export interface CampaignPlaybook {
  id: string;
  version: string;
  steps: PlaybookStep[];
}

export type PlaybookValidationCode =
  | 'invalid_playbook'
  | 'invalid_id'
  | 'invalid_version'
  | 'invalid_step'
  | 'unknown_action_type'
  | 'duplicate_step_id'
  | 'missing_rollback';

export interface PlaybookValidationError {
  code: PlaybookValidationCode;
  stepId?: string;
  message: string;
}

export interface PlaybookValidationResult {
  valid: boolean;
  errors: PlaybookValidationError[];
}

/** Classes that change spend, delivery, measurement, or are irreversible. */
export const HIGH_RISK_CLASSES: ReadonlySet<MarketingActionRiskClass> = new Set<MarketingActionRiskClass>([
  'spend_increase',
  'conversion_definition',
  'targeting',
  'activation',
  'destructive',
  'account_wide',
]);

const VERSION_RE = /^\d+\.\d+\.\d+$/;

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function validatePlaybook(playbook: CampaignPlaybook | null | undefined): PlaybookValidationResult {
  const errors: PlaybookValidationError[] = [];
  if (!playbook || typeof playbook !== 'object' || !Array.isArray(playbook.steps)) {
    return { valid: false, errors: [{ code: 'invalid_playbook', message: 'playbook must have a steps array' }] };
  }
  if (!nonEmpty(playbook.id)) errors.push({ code: 'invalid_id', message: 'playbook id is required' });
  if (typeof playbook.version !== 'string' || !VERSION_RE.test(playbook.version.trim())) {
    errors.push({ code: 'invalid_version', message: 'version must be MAJOR.MINOR.PATCH' });
  }

  const seen = new Set<string>();
  playbook.steps.forEach((step, index) => {
    if (!step || typeof step !== 'object' || !nonEmpty(step.id)) {
      errors.push({ code: 'invalid_step', message: `step ${index} has no id` });
      return;
    }
    const stepId = step.id.trim();
    if (seen.has(stepId)) {
      errors.push({ code: 'duplicate_step_id', stepId, message: `duplicate step id "${stepId}"` });
    }
    seen.add(stepId);

    const { riskClass } = classifyMarketingActionRisk(step);
    if (riskClass === 'unknown') {
      errors.push({ code: 'unknown_action_type', stepId, message: `step "${stepId}" has an unknown or unclassifiable action` });
      return;
    }
    if (HIGH_RISK_CLASSES.has(riskClass)) {
      const plan = buildRollbackPlan(step, step.snapshot);
      if (!plan.reversible) {
        errors.push({
          code: 'missing_rollback',
          stepId,
          message: `high-risk step "${stepId}" (${riskClass}) has no rollback plan: ${plan.reason}`,
        });
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

export interface PlaybookDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Canonical JSON with sorted keys so field order never registers as a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function index(playbook: CampaignPlaybook | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const step of playbook?.steps ?? []) {
    if (step && nonEmpty(step.id) && !map.has(step.id.trim())) map.set(step.id.trim(), canonical(step));
  }
  return map;
}

export function diffPlaybooks(
  a: CampaignPlaybook | null | undefined,
  b: CampaignPlaybook | null | undefined,
): PlaybookDiff {
  const before = index(a);
  const after = index(b);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, sig] of after) {
    if (!before.has(id)) added.push(id);
    else if (before.get(id) !== sig) changed.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
