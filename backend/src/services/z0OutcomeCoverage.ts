/**
 * Outcome expectation registration and coverage-gate client.
 *
 * The coverage gate is a data-quality prerequisite only. Passing it does not
 * prove causality or authorize routing changes.
 */
import { createHash } from 'crypto';
import {
  pseudonymousOutcomeSubject,
  type Z0OutcomeDirection,
  type Z0OutcomeFetchLike,
  type Z0OutcomeWindow,
} from './z0OutcomeObservation';

export interface Z0OutcomeExpectationMetric {
  source: string;
  name: string;
  unit?: string;
  direction?: Z0OutcomeDirection;
}

export interface Z0OutcomeExpectationInput {
  decisionTraceId: string;
  decisionTime: string;
  executionTime?: string;
  requiredWindows: Z0OutcomeWindow[];
  subjectId?: string;
  metric: Z0OutcomeExpectationMetric;
}

export interface Z0OutcomeExpectationV1 {
  schema: 'agentweb.outcome_expectation.v1';
  expectation_id: string;
  decision_trace_id: string;
  subject_ref?: string;
  decision_time: string;
  execution_time?: string;
  required_windows: Z0OutcomeWindow[];
  metric: Z0OutcomeExpectationMetric;
  quality_authoritative: false;
}

export interface Z0OutcomeCoverageWindow {
  registered: number;
  eligible: number;
  observed: number;
  complete: number;
  partial: number;
  missing: number;
  early_or_invalid: number;
  coverage: number | null;
  complete_coverage: number | null;
  passes: boolean;
  reasons: string[];
}

export interface Z0OutcomeCoverageSummaryV1 {
  schema: 'z0int.agentweb_outcome_coverage.v1';
  as_of: string;
  policy: {
    min_eligible_per_window: number;
    min_coverage: number;
    min_complete_coverage: number;
  };
  expectations: number;
  observations: number;
  required_windows: Z0OutcomeWindow[];
  by_window: Record<Z0OutcomeWindow, Z0OutcomeCoverageWindow>;
  orphan_observations: number;
  promotion_gate: {
    eligible: boolean;
    necessary_not_sufficient: true;
    causal_quality_proven: false;
    reasons: string[];
  };
}

export type Z0OutcomeExpectationExportMode = 'off' | 'shadow';

const TRACE_ID = /^[a-f0-9]{64}$/;
const METRIC_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const WINDOW_ORDER: Z0OutcomeWindow[] = ['1h', '24h', '7d'];
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const coverageCache = new Map<
  string,
  { expiresAt: number; value: Z0OutcomeCoverageSummaryV1 }
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

function validateMetric(metric: Z0OutcomeExpectationMetric): void {
  if (!metric || typeof metric !== 'object') throw new Error('metric is required');
  if (!METRIC_ID.test(metric.source)) throw new Error('metric.source is invalid');
  if (!METRIC_ID.test(metric.name)) throw new Error('metric.name is invalid');
  if (
    metric.unit !== undefined &&
    (
      typeof metric.unit !== 'string' ||
      metric.unit.trim().length === 0 ||
      metric.unit.length > 32 ||
      /[\u0000-\u001f]/.test(metric.unit)
    )
  ) {
    throw new Error('metric.unit is invalid');
  }
  if (
    metric.direction !== undefined &&
    !['higher_better', 'lower_better', 'neutral'].includes(metric.direction)
  ) {
    throw new Error('metric.direction is invalid');
  }
}

function canonicalWindows(windows: Z0OutcomeWindow[]): Z0OutcomeWindow[] {
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error('requiredWindows must be non-empty');
  }
  const set = new Set(windows);
  if (
    set.size !== windows.length ||
    [...set].some(window => !WINDOW_ORDER.includes(window))
  ) {
    throw new Error('requiredWindows must be a unique subset of 1h/24h/7d');
  }
  return WINDOW_ORDER.filter(window => set.has(window));
}

export function projectOutcomeExpectationToZ0(
  input: Z0OutcomeExpectationInput,
): Z0OutcomeExpectationV1 {
  if (!TRACE_ID.test(input.decisionTraceId)) {
    throw new Error('decisionTraceId must be lowercase 64-character hex');
  }
  validateMetric(input.metric);
  const windows = canonicalWindows(input.requiredWindows);

  const decisionMs = parseInstant(input.decisionTime, 'decisionTime');
  if (input.executionTime !== undefined) {
    const executionMs = parseInstant(input.executionTime, 'executionTime');
    if (executionMs < decisionMs) throw new Error('executionTime cannot predate decisionTime');
  }

  const subjectRef = input.subjectId
    ? pseudonymousOutcomeSubject(input.subjectId)
    : undefined;

  const identity = JSON.stringify({
    decision_trace_id: input.decisionTraceId,
    subject_ref: subjectRef ?? null,
    source: input.metric.source,
    name: input.metric.name,
  });

  return {
    schema: 'agentweb.outcome_expectation.v1',
    expectation_id: `agentweb-outcome-expectation-${sha256(identity)}`,
    decision_trace_id: input.decisionTraceId,
    ...(subjectRef ? { subject_ref: subjectRef } : {}),
    decision_time: input.decisionTime,
    ...(input.executionTime ? { execution_time: input.executionTime } : {}),
    required_windows: windows,
    metric: {
      source: input.metric.source,
      name: input.metric.name,
      ...(input.metric.unit !== undefined ? { unit: input.metric.unit } : {}),
      ...(input.metric.direction !== undefined ? { direction: input.metric.direction } : {}),
    },
    quality_authoritative: false,
  };
}

export function readZ0OutcomeExpectationExportMode(
  env: NodeJS.ProcessEnv = process.env,
): Z0OutcomeExpectationExportMode {
  return (env.Z0INT_AGENTWEB_OUTCOME_EXPECT ?? '').trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'off';
}

function timeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.Z0INT_AGENTWEB_OUTCOME_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

export async function exportOutcomeExpectationToZ0Safe(
  input: Z0OutcomeExpectationInput,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: Z0OutcomeFetchLike;
  } = {},
): Promise<{
  exported: boolean;
  reason: string;
  expectation_id?: string;
  replayed?: boolean;
}> {
  const env = options.env ?? process.env;
  if (readZ0OutcomeExpectationExportMode(env) === 'off') {
    return { exported: false, reason: 'disabled' };
  }

  let expectation: Z0OutcomeExpectationV1;
  try {
    expectation = projectOutcomeExpectationToZ0(input);
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
      `${baseUrl}/v1/observe/outcome/expectation`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(expectation),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      return {
        exported: false,
        reason: `http_${response.status}`,
        expectation_id: expectation.expectation_id,
      };
    }

    const payload = (await response.json()) as any;
    if (
      !payload ||
      payload.ok !== true ||
      payload.expectation_id !== expectation.expectation_id ||
      typeof payload.replayed !== 'boolean'
    ) {
      return {
        exported: false,
        reason: 'invalid_response',
        expectation_id: expectation.expectation_id,
      };
    }

    return {
      exported: true,
      reason: payload.replayed ? 'replayed' : 'stored',
      expectation_id: expectation.expectation_id,
      replayed: payload.replayed,
    };
  } catch (error) {
    return {
      exported: false,
      reason: error instanceof Error && error.name === 'AbortError'
        ? 'timeout'
        : 'transport_error',
      expectation_id: expectation.expectation_id,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateZ0OutcomeCoverageSummaryV1(value: unknown): string[] {
  if (!isRecord(value)) return ['coverage summary must be an object'];
  const errors: string[] = [];

  if (value.schema !== 'z0int.agentweb_outcome_coverage.v1') {
    errors.push('invalid coverage schema');
  }
  if (typeof value.as_of !== 'string' || !Number.isFinite(Date.parse(value.as_of))) {
    errors.push('invalid as_of');
  }
  if (!isRecord(value.policy)) {
    errors.push('policy must be an object');
  } else {
    const p = value.policy;
    if (!Number.isInteger(p.min_eligible_per_window) || Number(p.min_eligible_per_window) < 1) {
      errors.push('policy.min_eligible_per_window is invalid');
    }
    for (const field of ['min_coverage', 'min_complete_coverage'] as const) {
      const n = p[field];
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
        errors.push(`policy.${field} is invalid`);
      }
    }
  }
  if (!Array.isArray(value.required_windows) ||
      !value.required_windows.every(window => WINDOW_ORDER.includes(window))) {
    errors.push('required_windows is invalid');
  }
  if (!isRecord(value.by_window)) {
    errors.push('by_window must be an object');
  } else {
    for (const window of WINDOW_ORDER) {
      if (!isRecord(value.by_window[window])) errors.push(`by_window.${window} is invalid`);
    }
  }
  if (!isRecord(value.promotion_gate)) {
    errors.push('promotion_gate must be an object');
  } else {
    if (typeof value.promotion_gate.eligible !== 'boolean') {
      errors.push('promotion_gate.eligible must be boolean');
    }
    if (value.promotion_gate.necessary_not_sufficient !== true) {
      errors.push('promotion_gate must be necessary_not_sufficient');
    }
    if (value.promotion_gate.causal_quality_proven !== false) {
      errors.push('coverage gate cannot claim causal quality');
    }
    if (!Array.isArray(value.promotion_gate.reasons)) {
      errors.push('promotion_gate.reasons must be an array');
    }
  }

  return errors;
}

export async function getZ0OutcomeCoverage(
  options: {
    baseUrl: string;
    timeoutMs?: number;
    cacheTtlMs?: number;
    fetchImpl?: Z0OutcomeFetchLike;
    now?: () => number;
  },
): Promise<Z0OutcomeCoverageSummaryV1> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('baseUrl is required');
  const now = options.now ?? Date.now;
  const currentTime = now();
  const cached = coverageCache.get(baseUrl);
  if (cached && cached.expiresAt > currentTime) return cached.value;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${baseUrl}/v1/observe/outcome/coverage`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`z0 outcome coverage returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    const errors = validateZ0OutcomeCoverageSummaryV1(payload);
    if (errors.length) {
      throw new Error(`invalid z0 outcome coverage: ${errors.join('; ')}`);
    }
    const value = payload as Z0OutcomeCoverageSummaryV1;
    coverageCache.set(baseUrl, { expiresAt: currentTime + cacheTtlMs, value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export function outcomeDataPromotionEligible(
  summary: Z0OutcomeCoverageSummaryV1,
): boolean {
  return (
    summary.promotion_gate.eligible === true &&
    summary.promotion_gate.necessary_not_sufficient === true &&
    summary.promotion_gate.causal_quality_proven === false
  );
}

export function clearZ0OutcomeCoverageCacheForTests(): void {
  coverageCache.clear();
}
