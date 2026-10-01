/**
 * Provider-neutral verified-event batching for downstream z0 observations.
 *
 * Provider-specific signature verification stays in AgentWeb. This module only
 * accepts events already verified by that native boundary, hashes raw webhook
 * material locally, and exports normalized projections.
 */
import { createHash } from 'crypto';
import {
  projectOutcomeObservationToZ0,
  type Z0OutcomeFetchLike,
  type Z0OutcomeObservationInput,
  type Z0OutcomeObservationV1,
} from './z0OutcomeObservation';

export interface Z0VerifiedExternalEventInput {
  provider: string;
  externalEventId: string;
  eventType: string;
  eventTime: string;
  receivedAt: string;
  subjectId?: string;
  verification: {
    verified: boolean;
    scheme: string;
    verifiedAt: string;
  };
  payload: unknown;
  outcomes: readonly Z0OutcomeObservationInput[];
}

export interface Z0VerifiedEventBatchV1 {
  schema: 'agentweb.verified_event_batch.v1';
  event_id: string;
  provider: string;
  event_type: string;
  event_time: string;
  received_at: string;
  subject_ref?: string;
  verification: {
    status: 'verified';
    scheme: string;
    verified_at: string;
  };
  payload_sha256: string;
  projections: Array<{
    kind: 'outcome';
    value: Z0OutcomeObservationV1;
  }>;
  quality_authoritative: false;
}

export type Z0VerifiedEventExportMode = 'off' | 'shadow';

const ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const MAX_EXTERNAL_EVENT_ID = 500;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_PAYLOAD_DEPTH = 16;
const MAX_PAYLOAD_NODES = 10_000;
const MAX_PROJECTIONS = 16;
const MAX_IN_FLIGHT = 16;
const DEFAULT_TIMEOUT_MS = 1000;
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

function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const encode = (current: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES) {
      throw new Error(`payload exceeds max node count ${MAX_PAYLOAD_NODES}`);
    }
    if (depth > MAX_PAYLOAD_DEPTH) {
      throw new Error(`payload exceeds max depth ${MAX_PAYLOAD_DEPTH}`);
    }

    if (current === null) return 'null';
    if (typeof current === 'string') return JSON.stringify(current);
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('payload contains non-finite number');
      return JSON.stringify(current);
    }

    if (typeof current !== 'object') {
      throw new Error('payload must contain JSON-compatible values only');
    }

    const objectValue = current as object;
    if (seen.has(objectValue)) throw new Error('payload must be acyclic');
    seen.add(objectValue);

    try {
      if (Array.isArray(current)) {
        return `[${current.map(entry => encode(entry, depth + 1)).join(',')}]`;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('payload objects must be plain JSON objects');
      }

      const entries = Object.entries(current as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry, depth + 1)}`);
      return `{${entries.join(',')}}`;
    } finally {
      seen.delete(objectValue);
    }
  };

  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new Error(`payload exceeds ${MAX_PAYLOAD_BYTES} byte bound`);
  }
  return encoded;
}

export function projectVerifiedEventBatchToZ0(
  input: Z0VerifiedExternalEventInput,
): Z0VerifiedEventBatchV1 {
  if (!ID_RE.test(input.provider)) throw new Error('provider is invalid');
  if (
    typeof input.externalEventId !== 'string' ||
    input.externalEventId.trim().length === 0 ||
    input.externalEventId.length > MAX_EXTERNAL_EVENT_ID
  ) {
    throw new Error('externalEventId is invalid');
  }
  if (!ID_RE.test(input.eventType)) throw new Error('eventType is invalid');

  parseInstant(input.eventTime, 'eventTime');
  parseInstant(input.receivedAt, 'receivedAt');

  if (input.verification?.verified !== true) {
    throw new Error('external event must already be signature-verified');
  }
  if (!ID_RE.test(input.verification.scheme)) {
    throw new Error('verification.scheme is invalid');
  }
  parseInstant(input.verification.verifiedAt, 'verification.verifiedAt');

  if (
    !Array.isArray(input.outcomes) ||
    input.outcomes.length < 1 ||
    input.outcomes.length > MAX_PROJECTIONS
  ) {
    throw new Error(`outcomes must contain 1..${MAX_PROJECTIONS} projections`);
  }

  const canonicalPayload = canonicalJson(input.payload);
  const eventId = `agentweb-event-${sha256(
    `${input.provider}\0${input.externalEventId}`,
  )}`;
  const subjectRef = input.subjectId
    ? `agentweb-subject:${sha256(input.subjectId).slice(0, 24)}`
    : undefined;

  return {
    schema: 'agentweb.verified_event_batch.v1',
    event_id: eventId,
    provider: input.provider,
    event_type: input.eventType,
    event_time: input.eventTime,
    received_at: input.receivedAt,
    ...(subjectRef ? { subject_ref: subjectRef } : {}),
    verification: {
      status: 'verified',
      scheme: input.verification.scheme,
      verified_at: input.verification.verifiedAt,
    },
    payload_sha256: sha256(canonicalPayload),
    projections: input.outcomes.map(outcome => ({
      kind: 'outcome',
      value: projectOutcomeObservationToZ0(outcome),
    })),
    quality_authoritative: false,
  };
}

export function readZ0VerifiedEventExportMode(
  env: NodeJS.ProcessEnv = process.env,
): Z0VerifiedEventExportMode {
  return (env.Z0INT_AGENTWEB_EVENT_FORWARD ?? '').trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'off';
}

function readTimeout(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env.Z0INT_AGENTWEB_EVENT_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 5000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

export async function exportVerifiedEventBatchToZ0Safe(
  input: Z0VerifiedExternalEventInput,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: Z0OutcomeFetchLike;
  } = {},
): Promise<{
  exported: boolean;
  reason: string;
  event_id?: string;
  replayed?: boolean;
  fanout_count?: number;
}> {
  const env = options.env ?? process.env;
  if (readZ0VerifiedEventExportMode(env) === 'off') {
    return { exported: false, reason: 'disabled' };
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    return { exported: false, reason: 'inflight_cap' };
  }

  let batch: Z0VerifiedEventBatchV1;
  try {
    batch = projectVerifiedEventBatchToZ0(input);
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
    const response = await fetchImpl(`${baseUrl}/v1/observe/event-batch`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        exported: false,
        reason: `http_${response.status}`,
        event_id: batch.event_id,
      };
    }

    const payload = (await response.json()) as any;
    if (
      !payload ||
      payload.ok !== true ||
      payload.event_id !== batch.event_id ||
      typeof payload.replayed !== 'boolean' ||
      !Number.isInteger(payload.fanout_count)
    ) {
      return {
        exported: false,
        reason: 'invalid_response',
        event_id: batch.event_id,
      };
    }

    return {
      exported: true,
      reason: payload.replayed ? 'replayed' : 'stored',
      event_id: batch.event_id,
      replayed: payload.replayed,
      fanout_count: payload.fanout_count,
    };
  } catch (error) {
    return {
      exported: false,
      reason: error instanceof Error && error.name === 'AbortError'
        ? 'timeout'
        : 'transport_error',
      event_id: batch.event_id,
    };
  } finally {
    clearTimeout(timer);
    inFlight -= 1;
  }
}

export function getZ0VerifiedEventExporterInFlightForTests(): number {
  return inFlight;
}
