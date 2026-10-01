import {
  clearZ0BridgeCapabilitiesCacheForTests,
  getZ0BridgeCapabilities,
  z0BridgeCapabilitySupported,
  type Z0BridgeCapabilitiesV1,
  type Z0CapabilitiesFetchLike,
} from './z0BridgeCapabilities';
import type { Z0BridgeKind, Z0BridgeMode } from './z0BridgeProtocol';

export type Z0BridgeBackpressureMode = 'off' | 'enforce';

export type Z0BridgeAdmissionDenialReason =
  | 'circuit_open'
  | 'capability_unavailable'
  | 'capability_unsupported'
  | 'local_backpressure'
  | 'request_too_large';

export interface Z0BridgeAdmissionToken {
  baseUrl: string;
  capabilities: Z0BridgeCapabilitiesV1;
  released: boolean;
}

export type Z0BridgeAdmissionResult =
  | {
      admitted: true;
      token: Z0BridgeAdmissionToken;
    }
  | {
      admitted: false;
      reason: Z0BridgeAdmissionDenialReason;
      retryAfterMs: number;
      message: string;
    };

export type Z0BridgeObservedResponse =
  | { kind: 'success' }
  | { kind: 'known_rejection' }
  | { kind: 'ambiguous_failure'; circuitOpened: boolean; retryAfterMs: number }
  | { kind: 'pre_execution_overload'; retryAfterMs: number };

interface CircuitState {
  inFlight: number;
  openUntilMs: number;
  openReason: string | null;
  consecutiveAmbiguousFailures: number;
}

interface HeaderReader {
  get(name: string): string | null;
}

interface ResponseLike {
  ok: boolean;
  status: number;
  headers?: HeaderReader;
}

const states = new Map<string, CircuitState>();

const DISCOVERY_COOLDOWN_MS = 1000;
const AMBIGUOUS_FAILURE_THRESHOLD = 3;
const MAX_RETRY_AFTER_MS = 30_000;
const MIN_RETRY_AFTER_MS = 100;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function stateFor(baseUrl: string): CircuitState {
  const key = normalizeBaseUrl(baseUrl);
  let state = states.get(key);
  if (!state) {
    state = {
      inFlight: 0,
      openUntilMs: 0,
      openReason: null,
      consecutiveAmbiguousFailures: 0,
    };
    states.set(key, state);
  }
  return state;
}

function clampRetryAfterMs(value: number, fallbackMs: number): number {
  const chosen = Number.isFinite(value) && value >= 0 ? value : fallbackMs;
  return Math.min(
    MAX_RETRY_AFTER_MS,
    Math.max(MIN_RETRY_AFTER_MS, Math.ceil(chosen)),
  );
}

export function parseZ0RetryAfterMs(
  raw: string | null | undefined,
  nowMs: number,
  fallbackMs: number,
): number {
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return clampRetryAfterMs(seconds * 1000, fallbackMs);
    }

    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
      return clampRetryAfterMs(Math.max(0, dateMs - nowMs), fallbackMs);
    }
  }
  return clampRetryAfterMs(fallbackMs, fallbackMs);
}

function openCircuit(
  baseUrl: string,
  nowMs: number,
  retryAfterMs: number,
  reason: string,
): number {
  const state = stateFor(baseUrl);
  const bounded = clampRetryAfterMs(retryAfterMs, DISCOVERY_COOLDOWN_MS);
  state.openUntilMs = Math.max(state.openUntilMs, nowMs + bounded);
  state.openReason = reason;
  return Math.max(0, state.openUntilMs - nowMs);
}

function currentCircuitDelay(baseUrl: string, nowMs: number): number {
  const state = stateFor(baseUrl);
  if (state.openUntilMs <= nowMs) {
    state.openUntilMs = 0;
    state.openReason = null;
    return 0;
  }
  return state.openUntilMs - nowMs;
}

export function readZ0BridgeBackpressureMode(
  env: NodeJS.ProcessEnv = process.env,
): Z0BridgeBackpressureMode {
  return (env.Z0INT_AGENTWEB_BACKPRESSURE ?? '').trim().toLowerCase() === 'enforce'
    ? 'enforce'
    : 'off';
}

export async function acquireZ0BridgeAdmission(options: {
  baseUrl: string;
  mode: Z0BridgeMode;
  kind: Z0BridgeKind;
  capability: string;
  freeOnly: boolean;
  requestBytes: number;
  fetchImpl?: Z0CapabilitiesFetchLike;
  timeoutMs?: number;
  now?: () => number;
}): Promise<Z0BridgeAdmissionResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const now = options.now ?? Date.now;
  const nowMs = now();

  const circuitDelay = currentCircuitDelay(baseUrl, nowMs);
  if (circuitDelay > 0) {
    return {
      admitted: false,
      reason: 'circuit_open',
      retryAfterMs: circuitDelay,
      message: 'z0 bridge circuit is open; no transport attempted',
    };
  }

  let capabilities: Z0BridgeCapabilitiesV1;
  try {
    capabilities = await getZ0BridgeCapabilities({
      baseUrl,
      fetchImpl: options.fetchImpl,
      timeoutMs: Math.min(options.timeoutMs ?? 1000, 1000),
      now,
    });
  } catch (error) {
    const retryAfterMs = openCircuit(
      baseUrl,
      nowMs,
      DISCOVERY_COOLDOWN_MS,
      'capability_unavailable',
    );
    return {
      admitted: false,
      reason: 'capability_unavailable',
      retryAfterMs,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!z0BridgeCapabilitySupported(capabilities, {
    mode: options.mode,
    kind: options.kind,
    capability: options.capability,
    freeOnly: options.freeOnly,
  })) {
    return {
      admitted: false,
      reason: 'capability_unsupported',
      retryAfterMs: 0,
      message: 'z0 bridge capability is not advertised for this request',
    };
  }

  if (
    !Number.isInteger(options.requestBytes) ||
    options.requestBytes < 0 ||
    options.requestBytes > capabilities.transport.max_request_bytes
  ) {
    return {
      admitted: false,
      reason: 'request_too_large',
      retryAfterMs: 0,
      message: 'z0 bridge request exceeds advertised max_request_bytes',
    };
  }

  const state = stateFor(baseUrl);
  if (state.inFlight >= capabilities.transport.max_active) {
    return {
      admitted: false,
      reason: 'local_backpressure',
      retryAfterMs: clampRetryAfterMs(
        capabilities.transport.retry_after_seconds * 1000,
        1000,
      ),
      message: 'local z0 admission cap reached; request was not queued',
    };
  }

  state.inFlight += 1;
  return {
    admitted: true,
    token: {
      baseUrl,
      capabilities,
      released: false,
    },
  };
}

export function releaseZ0BridgeAdmission(token: Z0BridgeAdmissionToken | null): void {
  if (!token || token.released) return;
  token.released = true;
  const state = stateFor(token.baseUrl);
  state.inFlight = Math.max(0, state.inFlight - 1);
}

function noteAmbiguousFailure(
  token: Z0BridgeAdmissionToken,
  nowMs: number,
): { circuitOpened: boolean; retryAfterMs: number } {
  const state = stateFor(token.baseUrl);
  state.consecutiveAmbiguousFailures += 1;

  if (state.consecutiveAmbiguousFailures < AMBIGUOUS_FAILURE_THRESHOLD) {
    return { circuitOpened: false, retryAfterMs: 0 };
  }

  const retryAfterMs = openCircuit(
    token.baseUrl,
    nowMs,
    token.capabilities.transport.retry_after_seconds * 1000,
    'ambiguous_transport_failures',
  );
  return { circuitOpened: true, retryAfterMs };
}

export function observeZ0BridgeResponse(
  token: Z0BridgeAdmissionToken,
  response: ResponseLike,
  now: () => number = Date.now,
): Z0BridgeObservedResponse {
  const nowMs = now();
  const transport = token.capabilities.transport;
  const proofHeader = response.headers?.get(transport.overload_execution_header);

  if (
    response.status === transport.overload_status &&
    transport.queue_policy === 'reject_excess' &&
    transport.overload_execution === 'not_started' &&
    proofHeader === 'not_started'
  ) {
    const retryAfterMs = parseZ0RetryAfterMs(
      response.headers?.get('Retry-After'),
      nowMs,
      transport.retry_after_seconds * 1000,
    );
    const bounded = openCircuit(
      token.baseUrl,
      nowMs,
      retryAfterMs,
      'pre_execution_overload',
    );
    stateFor(token.baseUrl).consecutiveAmbiguousFailures = 0;
    return { kind: 'pre_execution_overload', retryAfterMs: bounded };
  }

  if (response.ok) {
    stateFor(token.baseUrl).consecutiveAmbiguousFailures = 0;
    return { kind: 'success' };
  }

  if (response.status >= 500) {
    const noted = noteAmbiguousFailure(token, nowMs);
    return {
      kind: 'ambiguous_failure',
      circuitOpened: noted.circuitOpened,
      retryAfterMs: noted.retryAfterMs,
    };
  }

  stateFor(token.baseUrl).consecutiveAmbiguousFailures = 0;
  return { kind: 'known_rejection' };
}

export function noteZ0BridgeTransportFailure(
  token: Z0BridgeAdmissionToken,
  now: () => number = Date.now,
): { circuitOpened: boolean; retryAfterMs: number } {
  return noteAmbiguousFailure(token, now());
}

export function getZ0BridgeBackpressureStateForTests(baseUrl: string) {
  const state = stateFor(baseUrl);
  return { ...state };
}

export function clearZ0BridgeBackpressureStateForTests(): void {
  states.clear();
  clearZ0BridgeCapabilitiesCacheForTests();
}
