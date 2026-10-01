/**
 * Randomized AgentWeb outcome assignment + causal-review client.
 *
 * This is a review barrier, not an auto-promotion path. Even when all
 * randomized evidence gates pass, routing changes remain human-reviewed.
 */
import { createHash } from 'crypto';
import {
  outcomeDataPromotionEligible,
  validateZ0OutcomeCoverageSummaryV1,
  type Z0OutcomeCoverageSummaryV1,
} from './z0OutcomeCoverage';
import {
  pseudonymousOutcomeSubject,
  type Z0OutcomeFetchLike,
} from './z0OutcomeObservation';

export type Z0OutcomeArmId = 'candidate' | 'reference';
export type Z0OutcomeAssignmentMethod =
  | 'randomized'
  | 'deterministic'
  | 'unknown';
export type Z0OutcomeSelectionPolicy =
  | 'active'
  | 'audit'
  | 'historical_replay'
  | 'production';

export interface Z0OutcomeAssignmentInput {
  decisionTraceId: string;
  subjectId: string;
  experimentId: string;
  pairId?: string;
  armId: Z0OutcomeArmId;
  treatmentHash: string;
  selectionPolicy: Z0OutcomeSelectionPolicy;
  assignmentMethod: Z0OutcomeAssignmentMethod;
  assignmentProbability: number;
  assignedAt: string;
}

export interface Z0OutcomeAssignmentV1 {
  schema: 'agentweb.outcome_assignment.v1';
  assignment_id: string;
  decision_trace_id: string;
  unit_ref: string;
  experiment_id: string;
  pair_id?: string;
  arm_id: Z0OutcomeArmId;
  treatment_hash: string;
  selection_policy: Z0OutcomeSelectionPolicy;
  assignment_method: Z0OutcomeAssignmentMethod;
  assignment_probability: number;
  assigned_at: string;
  quality_authoritative: false;
}

export interface Z0RandomizedEffectSummary {
  candidate_n: number;
  reference_n: number;
  candidate_mean: number | null;
  reference_mean: number | null;
  difference_in_means: number | null;
  standard_error: number | null;
  ci95: [number, number] | null;
}

export interface Z0RandomizedExperimentSummary {
  registered_assignments: number;
  valid_randomized_assignments: number;
  assignment_probability: number | null;
  arms: {
    candidate: { units: number; treatment_hashes: string[] };
    reference: { units: number; treatment_hashes: string[] };
  };
  metric_windows: Record<
    string,
    Record<string, Z0RandomizedEffectSummary>
  >;
  review_ready: boolean;
  human_review_required: true;
  auto_promotion_allowed: false;
  causal_quality_proven: false;
  reasons: string[];
}

export interface Z0RandomizedOutcomeEvidenceSummaryV1 {
  schema: 'z0int.agentweb_randomized_outcome_evidence.v1';
  as_of: string;
  coverage: Z0OutcomeCoverageSummaryV1;
  policy: {
    min_total_live_units: number;
    min_complete_units_per_arm: number;
  };
  experiments: Record<string, Z0RandomizedExperimentSummary>;
  review_ready_any: boolean;
  human_review_required: true;
  auto_promotion_allowed: false;
  causal_quality_proven: false;
}

export type Z0OutcomeAssignmentExportMode = 'off' | 'shadow';

const TRACE_ID = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const TREATMENT_RE = /^[a-f0-9]{16,64}$/;
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_CACHE_TTL_MS = 60_000;

const evidenceCache = new Map<
  string,
  { expiresAt: number; value: Z0RandomizedOutcomeEvidenceSummaryV1 }
>();

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseInstant(value: string, name: string): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new Error(`${name} must be a bounded ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid ISO timestamp`);
  if (!/[zZ]|[+-]\d\d:\d\d$/.test(value)) {
    throw new Error(`${name} must be timezone-aware`);
  }
  return parsed;
}

export function projectOutcomeAssignmentToZ0(
  input: Z0OutcomeAssignmentInput,
): Z0OutcomeAssignmentV1 {
  if (!TRACE_ID.test(input.decisionTraceId)) {
    throw new Error('decisionTraceId must be lowercase 64-character hex');
  }
  if (!ID_RE.test(input.experimentId)) throw new Error('experimentId is invalid');
  if (input.pairId !== undefined && !ID_RE.test(input.pairId)) {
    throw new Error('pairId is invalid');
  }
  if (!['candidate', 'reference'].includes(input.armId)) {
    throw new Error('armId is invalid');
  }
  if (!TREATMENT_RE.test(input.treatmentHash)) {
    throw new Error('treatmentHash must be lowercase hex with length 16-64');
  }
  if (!['active', 'audit', 'historical_replay', 'production'].includes(input.selectionPolicy)) {
    throw new Error('selectionPolicy is invalid');
  }
  if (!['randomized', 'deterministic', 'unknown'].includes(input.assignmentMethod)) {
    throw new Error('assignmentMethod is invalid');
  }
  if (
    !Number.isFinite(input.assignmentProbability) ||
    input.assignmentProbability <= 0 ||
    input.assignmentProbability >= 1
  ) {
    throw new Error('assignmentProbability must be strictly between 0 and 1');
  }
  parseInstant(input.assignedAt, 'assignedAt');

  const unitRef = pseudonymousOutcomeSubject(input.subjectId);
  const identity = JSON.stringify({
    decision_trace_id: input.decisionTraceId,
    unit_ref: unitRef,
    experiment_id: input.experimentId,
  });

  return {
    schema: 'agentweb.outcome_assignment.v1',
    assignment_id: `agentweb-outcome-assignment-${sha256(identity)}`,
    decision_trace_id: input.decisionTraceId,
    unit_ref: unitRef,
    experiment_id: input.experimentId,
    ...(input.pairId ? { pair_id: input.pairId } : {}),
    arm_id: input.armId,
    treatment_hash: input.treatmentHash,
    selection_policy: input.selectionPolicy,
    assignment_method: input.assignmentMethod,
    assignment_probability: input.assignmentProbability,
    assigned_at: input.assignedAt,
    quality_authoritative: false,
  };
}

export function readZ0OutcomeAssignmentExportMode(
  env: NodeJS.ProcessEnv = process.env,
): Z0OutcomeAssignmentExportMode {
  return (env.Z0INT_AGENTWEB_OUTCOME_ASSIGNMENT ?? '').trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'off';
}

function timeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.Z0INT_AGENTWEB_OUTCOME_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

export async function exportOutcomeAssignmentToZ0Safe(
  input: Z0OutcomeAssignmentInput,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: Z0OutcomeFetchLike;
  } = {},
): Promise<{
  exported: boolean;
  reason: string;
  assignment_id?: string;
  replayed?: boolean;
}> {
  const env = options.env ?? process.env;
  if (readZ0OutcomeAssignmentExportMode(env) === 'off') {
    return { exported: false, reason: 'disabled' };
  }

  let assignment: Z0OutcomeAssignmentV1;
  try {
    assignment = projectOutcomeAssignmentToZ0(input);
  } catch (error) {
    return {
      exported: false,
      reason: error instanceof Error ? `validation_error:${error.message}` : 'validation_error',
    };
  }

  const baseUrl = (env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutFromEnv(env));

  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${baseUrl}/v1/observe/outcome/assignment`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(assignment),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return {
        exported: false,
        reason: `http_${response.status}`,
        assignment_id: assignment.assignment_id,
      };
    }

    const payload = (await response.json()) as any;
    if (
      !payload ||
      payload.ok !== true ||
      payload.assignment_id !== assignment.assignment_id ||
      typeof payload.replayed !== 'boolean'
    ) {
      return {
        exported: false,
        reason: 'invalid_response',
        assignment_id: assignment.assignment_id,
      };
    }

    return {
      exported: true,
      reason: payload.replayed ? 'replayed' : 'stored',
      assignment_id: assignment.assignment_id,
      replayed: payload.replayed,
    };
  } catch (error) {
    return {
      exported: false,
      reason: error instanceof Error && error.name === 'AbortError'
        ? 'timeout'
        : 'transport_error',
      assignment_id: assignment.assignment_id,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validEffect(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!Number.isInteger(value.candidate_n) || Number(value.candidate_n) < 0) return false;
  if (!Number.isInteger(value.reference_n) || Number(value.reference_n) < 0) return false;
  for (const field of [
    'candidate_mean',
    'reference_mean',
    'difference_in_means',
    'standard_error',
  ] as const) {
    const v = value[field];
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) return false;
  }
  if (
    value.ci95 !== null &&
    (
      !Array.isArray(value.ci95) ||
      value.ci95.length !== 2 ||
      !value.ci95.every(v => typeof v === 'number' && Number.isFinite(v))
    )
  ) {
    return false;
  }
  return true;
}

export function validateZ0RandomizedOutcomeEvidenceSummaryV1(
  value: unknown,
): string[] {
  if (!isRecord(value)) return ['randomized evidence must be an object'];
  const errors: string[] = [];

  if (value.schema !== 'z0int.agentweb_randomized_outcome_evidence.v1') {
    errors.push('invalid randomized evidence schema');
  }
  if (typeof value.as_of !== 'string' || !Number.isFinite(Date.parse(value.as_of))) {
    errors.push('invalid as_of');
  }

  const coverageErrors = validateZ0OutcomeCoverageSummaryV1(value.coverage);
  errors.push(...coverageErrors.map(error => `coverage:${error}`));

  if (!isRecord(value.policy)) {
    errors.push('policy must be an object');
  } else {
    if (
      !Number.isInteger(value.policy.min_total_live_units) ||
      Number(value.policy.min_total_live_units) < 1
    ) {
      errors.push('policy.min_total_live_units is invalid');
    }
    if (
      !Number.isInteger(value.policy.min_complete_units_per_arm) ||
      Number(value.policy.min_complete_units_per_arm) < 1
    ) {
      errors.push('policy.min_complete_units_per_arm is invalid');
    }
  }

  if (value.human_review_required !== true) {
    errors.push('human_review_required must be true');
  }
  if (value.auto_promotion_allowed !== false) {
    errors.push('auto_promotion_allowed must be false');
  }
  if (value.causal_quality_proven !== false) {
    errors.push('summary cannot claim causal quality proven');
  }

  if (!isRecord(value.experiments)) {
    errors.push('experiments must be an object');
  } else {
    for (const [experimentId, raw] of Object.entries(value.experiments)) {
      if (!ID_RE.test(experimentId) || !isRecord(raw)) {
        errors.push(`experiment ${experimentId} is invalid`);
        continue;
      }
      if (raw.human_review_required !== true) {
        errors.push(`${experimentId}.human_review_required must be true`);
      }
      if (raw.auto_promotion_allowed !== false) {
        errors.push(`${experimentId}.auto_promotion_allowed must be false`);
      }
      if (raw.causal_quality_proven !== false) {
        errors.push(`${experimentId} cannot claim causal quality proven`);
      }
      if (typeof raw.review_ready !== 'boolean') {
        errors.push(`${experimentId}.review_ready must be boolean`);
      }
      if (!Array.isArray(raw.reasons)) {
        errors.push(`${experimentId}.reasons must be an array`);
      }
      if (!isRecord(raw.metric_windows)) {
        errors.push(`${experimentId}.metric_windows must be an object`);
      } else {
        for (const [metric, windows] of Object.entries(raw.metric_windows)) {
          if (!isRecord(windows)) {
            errors.push(`${experimentId}.${metric} windows are invalid`);
            continue;
          }
          for (const [window, effect] of Object.entries(windows)) {
            if (!validEffect(effect)) {
              errors.push(`${experimentId}.${metric}.${window} effect is invalid`);
            }
          }
        }
      }
    }
  }

  return errors;
}

export async function getZ0RandomizedOutcomeEvidence(
  options: {
    baseUrl: string;
    timeoutMs?: number;
    cacheTtlMs?: number;
    fetchImpl?: Z0OutcomeFetchLike;
    now?: () => number;
  },
): Promise<Z0RandomizedOutcomeEvidenceSummaryV1> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('baseUrl is required');

  const now = options.now ?? Date.now;
  const currentTime = now();
  const cached = evidenceCache.get(baseUrl);
  if (cached && cached.expiresAt > currentTime) return cached.value;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${baseUrl}/v1/observe/outcome/randomized-evidence`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`z0 randomized outcome evidence returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    const errors = validateZ0RandomizedOutcomeEvidenceSummaryV1(payload);
    if (errors.length) {
      throw new Error(`invalid z0 randomized outcome evidence: ${errors.join('; ')}`);
    }
    const value = payload as Z0RandomizedOutcomeEvidenceSummaryV1;
    evidenceCache.set(baseUrl, { expiresAt: currentTime + cacheTtlMs, value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export function randomizedOutcomeEvidenceReviewReady(
  summary: Z0RandomizedOutcomeEvidenceSummaryV1,
  experimentId: string,
): boolean {
  const experiment = summary.experiments[experimentId];
  if (!experiment) return false;

  const minTotal = summary.policy.min_total_live_units;
  const minPerArm = summary.policy.min_complete_units_per_arm;
  const effects = Object.values(experiment.metric_windows)
    .flatMap(windows => Object.values(windows));

  return (
    outcomeDataPromotionEligible(summary.coverage) &&
    summary.human_review_required === true &&
    summary.auto_promotion_allowed === false &&
    summary.causal_quality_proven === false &&
    experiment.review_ready === true &&
    experiment.human_review_required === true &&
    experiment.auto_promotion_allowed === false &&
    experiment.causal_quality_proven === false &&
    experiment.reasons.length === 0 &&
    experiment.valid_randomized_assignments >= minTotal &&
    experiment.arms.candidate.units >= minPerArm &&
    experiment.arms.reference.units >= minPerArm &&
    effects.length > 0 &&
    effects.every(
      effect =>
        effect.candidate_n >= minPerArm &&
        effect.reference_n >= minPerArm,
    )
  );
}

export function clearZ0RandomizedOutcomeEvidenceCacheForTests(): void {
  evidenceCache.clear();
}
