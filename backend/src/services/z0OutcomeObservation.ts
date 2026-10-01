/**
 * Privacy-minimized AgentWeb -> z0 real-world outcome observation ETL.
 *
 * These measurements are observational only. A metric row does not become
 * verified/gold merely because it exists or improved.
 */
import { createHash } from 'crypto';

export type Z0OutcomeWindow = '1h' | '24h' | '7d';
export type Z0OutcomeMeasurementState = 'complete' | 'partial';
export type Z0OutcomeDirection = 'higher_better' | 'lower_better' | 'neutral';
export type Z0OutcomeFetchLike = typeof fetch;

export interface Z0OutcomeMetric {
  source: string;
  name: string;
  value: number;
  unit?: string;
  direction?: Z0OutcomeDirection;
}

export interface Z0OutcomeObservationInput {
  decisionTraceId: string;
  decisionTime: string;
  executionTime?: string;
  observationTime: string;
  window: Z0OutcomeWindow;
  subjectId?: string;
  metric: Z0OutcomeMetric;
  measurementState?: Z0OutcomeMeasurementState;
}

export interface Z0OutcomeObservationV1 {
  schema: 'agentweb.outcome_observation.v1';
  observation_id: string;
  decision_trace_id: string;
  subject_ref?: string;
  window: Z0OutcomeWindow;
  decision_time: string;
  execution_time?: string;
  observation_time: string;
  measurement_state: Z0OutcomeMeasurementState;
  metric: Z0OutcomeMetric;
  quality_authoritative: false;
}

export type Z0OutcomeExportMode = 'off' | 'shadow';

const DEFAULT_TIMEOUT_MS = 1000;
const MAX_IN_FLIGHT = 16;
const METRIC_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const TRACE_ID = /^[a-f0-9]{64}$/;
const WINDOW_MS: Record<Z0OutcomeWindow, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};
let inFlight = 0;

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

function validateMetric(metric: Z0OutcomeMetric): void {
  if (!metric || typeof metric !== 'object') throw new Error('metric is required');
  if (!METRIC_ID.test(metric.source)) throw new Error('metric.source is invalid');
  if (!METRIC_ID.test(metric.name)) throw new Error('metric.name is invalid');
  if (!Number.isFinite(metric.value) || Math.abs(metric.value) > 1e15) {
    throw new Error('metric.value must be finite and bounded');
  }
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

export function pseudonymousOutcomeSubject(subjectId: string): string {
  if (!subjectId?.trim()) throw new Error('subjectId is required');
  return `agentweb-subject:${sha256(subjectId).slice(0, 24)}`;
}

export function projectOutcomeObservationToZ0(
  input: Z0OutcomeObservationInput,
): Z0OutcomeObservationV1 {
  if (!TRACE_ID.test(input.decisionTraceId)) {
    throw new Error('decisionTraceId must be lowercase 64-character hex');
  }
  if (!['1h', '24h', '7d'].includes(input.window)) {
    throw new Error('window must be 1h, 24h, or 7d');
  }
  validateMetric(input.metric);

  const decisionMs = parseInstant(input.decisionTime, 'decisionTime');
  const executionMs = input.executionTime === undefined
    ? undefined
    : parseInstant(input.executionTime, 'executionTime');
  const observationMs = parseInstant(input.observationTime, 'observationTime');

  if (executionMs !== undefined && executionMs < decisionMs) {
    throw new Error('executionTime cannot predate decisionTime');
  }
  if (observationMs < decisionMs) {
    throw new Error('observationTime cannot predate decisionTime');
  }
  if (executionMs !== undefined && observationMs < executionMs) {
    throw new Error('observationTime cannot predate executionTime');
  }
  if (observationMs - decisionMs < WINDOW_MS[input.window]) {
    throw new Error('observationTime is earlier than the declared measurement window');
  }

  const subjectRef = input.subjectId
    ? pseudonymousOutcomeSubject(input.subjectId)
    : undefined;

  const observationMaterial = JSON.stringify({
    decision_trace_id: input.decisionTraceId,
    subject_ref: subjectRef ?? null,
    window: input.window,
    source: input.metric.source,
    name: input.metric.name,
  });

  return {
    schema: 'agentweb.outcome_observation.v1',
    observation_id: `agentweb-outcome-${sha256(observationMaterial)}`,
    decision_trace_id: input.decisionTraceId,
    ...(subjectRef ? { subject_ref: subjectRef } : {}),
    window: input.window,
    decision_time: input.decisionTime,
    ...(input.executionTime ? { execution_time: input.executionTime } : {}),
    observation_time: input.observationTime,
    measurement_state: input.measurementState ?? 'complete',
    metric: {
      source: input.metric.source,
      name: input.metric.name,
      value: input.metric.value,
      ...(input.metric.unit !== undefined ? { unit: input.metric.unit } : {}),
      ...(input.metric.direction !== undefined ? { direction: input.metric.direction } : {}),
    },
    quality_authoritative: false,
  };
}

export function readZ0OutcomeExportMode(
  env: NodeJS.ProcessEnv = process.env,
): Z0OutcomeExportMode {
  return (env.Z0INT_AGENTWEB_OUTCOME_OBSERVE ?? '').trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'off';
}

function readTimeout(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.Z0INT_AGENTWEB_OUTCOME_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

export async function exportOutcomeObservationToZ0Safe(
  input: Z0OutcomeObservationInput,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: Z0OutcomeFetchLike;
  } = {},
): Promise<{
  exported: boolean;
  reason: string;
  observation_id?: string;
  replayed?: boolean;
  age_seconds?: number;
  window_seconds?: number;
}> {
  const env = options.env ?? process.env;
  if (readZ0OutcomeExportMode(env) === 'off') {
    return { exported: false, reason: 'disabled' };
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    return { exported: false, reason: 'inflight_cap' };
  }

  let observation: Z0OutcomeObservationV1;
  try {
    observation = projectOutcomeObservationToZ0(input);
  } catch (error) {
    return {
      exported: false,
      reason: error instanceof Error ? `validation_error:${error.message}` : 'validation_error',
    };
  }

  const baseUrl = (env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501').replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), readTimeout(env));
  const fetchImpl = options.fetchImpl ?? fetch;
  inFlight += 1;

  try {
    const response = await fetchImpl(`${baseUrl}/v1/observe/outcome`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(observation),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { exported: false, reason: `http_${response.status}`, observation_id: observation.observation_id };
    }
    const payload = (await response.json()) as any;
    if (
      !payload ||
      payload.ok !== true ||
      payload.observation_id !== observation.observation_id ||
      typeof payload.replayed !== 'boolean'
    ) {
      return { exported: false, reason: 'invalid_response', observation_id: observation.observation_id };
    }
    return {
      exported: true,
      reason: payload.replayed ? 'replayed' : 'stored',
      observation_id: observation.observation_id,
      replayed: payload.replayed,
      ...(typeof payload.age_seconds === 'number' ? { age_seconds: payload.age_seconds } : {}),
      ...(typeof payload.window_seconds === 'number' ? { window_seconds: payload.window_seconds } : {}),
    };
  } catch (error) {
    return {
      exported: false,
      reason: error instanceof Error && error.name === 'AbortError'
        ? 'timeout'
        : 'transport_error',
      observation_id: observation.observation_id,
    };
  } finally {
    clearTimeout(timer);
    inFlight -= 1;
  }
}

export function getZ0OutcomeExporterInFlightForTests(): number {
  return inFlight;
}
