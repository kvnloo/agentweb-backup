/**
 * Versioned AgentWeb <-> z0intelligence bridge contract.
 *
 * This module is deliberately transport-agnostic. It describes the authority
 * boundary; endpoint-specific adapters remain responsible for HTTP details.
 */

export const Z0_BRIDGE_SCHEMA_V1 = 'agentweb.z0.bridge.v1' as const;

export type Z0BridgeMode = 'shadow' | 'active';
export type Z0BridgeKind = 'plan' | 'decide' | 'dispatch' | 'observe';
export type Z0BridgeRiskClass =
  | 'read'
  | 'generate'
  | 'mutate'
  | 'external_side_effect';
export type Z0BridgeApprovalState =
  | 'not_required'
  | 'required'
  | 'confirmed';

export interface Z0BridgePolicyV1 {
  allow_remote: boolean;
  free_only: boolean;
  experimental: boolean;
  risk_class: Z0BridgeRiskClass;
  approval_state: Z0BridgeApprovalState;
}

export interface Z0BridgeRequestV1 {
  schema: typeof Z0_BRIDGE_SCHEMA_V1;
  operation_id: string;
  trace_id: string;
  parent_agent: string;
  mode: Z0BridgeMode;
  kind: Z0BridgeKind;
  capability: string;
  policy: Z0BridgePolicyV1;
  payload: unknown;
}

export type Z0BridgeStatus =
  | 'completed'
  | 'not_executed'
  | 'rejected'
  | 'failed'
  | 'unknown';

export type Z0BridgeRetry =
  | 'none'
  | 'caller_may_fallback'
  | 'same_identity_only';

export interface Z0BridgeErrorV1 {
  code: string;
  message?: string;
}

export interface Z0BridgeEvidenceV1 {
  receipt_id?: string;
  evidence_id?: string;
  schema?: string;
}

export interface Z0BridgeResponseV1 {
  schema: typeof Z0_BRIDGE_SCHEMA_V1;
  operation_id: string;
  trace_id: string;
  mode: Z0BridgeMode;
  kind: Z0BridgeKind;
  status: Z0BridgeStatus;
  applied: boolean;
  replayed: boolean;
  reconcile_required: boolean;
  retry: Z0BridgeRetry;
  evidence?: Z0BridgeEvidenceV1;
  error?: Z0BridgeErrorV1;
  output?: unknown;
}

export type Z0BridgeFailureClass =
  | 'validation'
  | 'policy'
  | 'trace_conflict'
  | 'http_4xx'
  | 'overload_pre_execution'
  | 'timeout'
  | 'transport'
  | 'http_5xx'
  | 'invalid_response';

export interface Z0BridgeFailureDisposition {
  status: Extract<Z0BridgeStatus, 'not_executed' | 'rejected' | 'unknown'>;
  reconcile_required: boolean;
  retry: Z0BridgeRetry;
}

const MODES = new Set<Z0BridgeMode>(['shadow', 'active']);
const KINDS = new Set<Z0BridgeKind>(['plan', 'decide', 'dispatch', 'observe']);
const RISKS = new Set<Z0BridgeRiskClass>([
  'read',
  'generate',
  'mutate',
  'external_side_effect',
]);
const APPROVALS = new Set<Z0BridgeApprovalState>([
  'not_required',
  'required',
  'confirmed',
]);

const FORBIDDEN_TOP_LEVEL_FIELDS = new Set([
  'user_id',
  'userId',
  'account_id',
  'accountId',
  'session_id',
  'sessionId',
  'api_key',
  'apiKey',
  'oauth_token',
  'oauthToken',
  'access_token',
  'accessToken',
  'authorization',
  'cookie',
  'password',
]);

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'userid',
  'accountid',
  'sessionid',
  'apikey',
  'oauthtoken',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'authorization',
  'cookie',
  'password',
  'clientsecret',
  'privatekey',
  'secretkey',
  'credential',
  'credentials',
]);

const MAX_PAYLOAD_DEPTH = 12;
const MAX_PAYLOAD_NODES = 4096;

function normalizePayloadKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function validateZ0BridgePayloadIsolationV1(payload: unknown): string[] {
  const errors: string[] = [];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let stopped = false;

  const visit = (value: unknown, path: string, depth: number): void => {
    if (stopped) return;

    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES) {
      errors.push(`payload structure exceeds max node count ${MAX_PAYLOAD_NODES}`);
      stopped = true;
      return;
    }

    if (depth > MAX_PAYLOAD_DEPTH) {
      errors.push(`payload structure exceeds max depth ${MAX_PAYLOAD_DEPTH}`);
      stopped = true;
      return;
    }

    if (!value || typeof value !== 'object') return;

    const objectValue = value as object;
    if (seen.has(objectValue)) {
      errors.push('payload must be acyclic');
      stopped = true;
      return;
    }
    seen.add(objectValue);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PAYLOAD_KEYS.has(normalizePayloadKey(key))) {
        errors.push(`forbidden payload field at ${path}.${key}: ${key}`);
      }
      visit(entry, `${path}.${key}`, depth + 1);
      if (stopped) return;
    }
  };

  visit(payload, 'payload', 0);
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function validateZ0BridgeRequestV1(value: unknown): string[] {
  if (!isRecord(value)) return ['request must be an object'];

  const errors: string[] = [];

  for (const field of FORBIDDEN_TOP_LEVEL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      errors.push(`forbidden top-level field: ${field}`);
    }
  }

  if (value.schema !== Z0_BRIDGE_SCHEMA_V1) {
    errors.push(`schema must be ${Z0_BRIDGE_SCHEMA_V1}`);
  }
  if (!boundedString(value.operation_id, 200)) {
    errors.push('operation_id must be a non-empty string <= 200 characters');
  }
  if (typeof value.trace_id !== 'string' || !/^[a-f0-9]{64}$/.test(value.trace_id)) {
    errors.push('trace_id must be a lowercase 64-character sha256 hex string');
  }
  if (typeof value.parent_agent !== 'string' || !/^agentweb:[a-f0-9]{24}$/.test(value.parent_agent)) {
    errors.push('parent_agent must be a pseudonymous agentweb:<24 hex> identifier');
  }
  if (!MODES.has(value.mode as Z0BridgeMode)) {
    errors.push('mode must be shadow or active');
  }
  if (!KINDS.has(value.kind as Z0BridgeKind)) {
    errors.push('kind must be plan, decide, dispatch, or observe');
  }
  if (!boundedString(value.capability, 200)) {
    errors.push('capability must be a non-empty string <= 200 characters');
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'payload')) {
    errors.push('payload is required');
  }
  else {
    errors.push(...validateZ0BridgePayloadIsolationV1(value.payload));
  }

  if (!isRecord(value.policy)) {
    errors.push('policy must be an object');
  } else {
    const policy = value.policy;
    for (const field of ['allow_remote', 'free_only', 'experimental'] as const) {
      if (typeof policy[field] !== 'boolean') {
        errors.push(`policy.${field} must be boolean`);
      }
    }
    if (!RISKS.has(policy.risk_class as Z0BridgeRiskClass)) {
      errors.push('policy.risk_class is invalid');
    }
    if (!APPROVALS.has(policy.approval_state as Z0BridgeApprovalState)) {
      errors.push('policy.approval_state is invalid');
    }

    if (
      value.mode === 'active' &&
      value.kind === 'dispatch' &&
      policy.risk_class === 'external_side_effect' &&
      policy.approval_state !== 'confirmed'
    ) {
      errors.push('active external_side_effect dispatch requires confirmed AgentWeb approval');
    }
  }

  return errors;
}

export function assertZ0BridgeRequestV1(value: unknown): asserts value is Z0BridgeRequestV1 {
  const errors = validateZ0BridgeRequestV1(value);
  if (errors.length) throw new Error(`invalid z0 bridge v1 request: ${errors.join('; ')}`);
}

export function bridgeFailureDisposition(
  mode: Z0BridgeMode,
  failure: Z0BridgeFailureClass,
  kind: Z0BridgeKind = mode === 'shadow' ? 'plan' : 'dispatch',
): Z0BridgeFailureDisposition {
  if (failure === 'overload_pre_execution') {
    return {
      status: 'not_executed',
      reconcile_required: false,
      retry: 'caller_may_fallback',
    };
  }

  const knownRejection =
    failure === 'validation' ||
    failure === 'policy' ||
    failure === 'trace_conflict' ||
    failure === 'http_4xx';

  if (knownRejection) {
    return {
      status: 'rejected',
      reconcile_required: false,
      retry: 'none',
    };
  }

  if (mode === 'shadow' && kind !== 'decide') {
    return {
      status: 'not_executed',
      reconcile_required: false,
      retry: 'caller_may_fallback',
    };
  }

  return {
    status: 'unknown',
    reconcile_required: true,
    retry: 'same_identity_only',
  };
}

export function validateZ0BridgeResponseV1(value: unknown): string[] {
  if (!isRecord(value)) return ['response must be an object'];

  const errors: string[] = [];
  if (value.schema !== Z0_BRIDGE_SCHEMA_V1) {
    errors.push(`schema must be ${Z0_BRIDGE_SCHEMA_V1}`);
  }
  if (!boundedString(value.operation_id, 200)) {
    errors.push('operation_id must be a non-empty string <= 200 characters');
  }
  if (typeof value.trace_id !== 'string' || !/^[a-f0-9]{64}$/.test(value.trace_id)) {
    errors.push('trace_id must be a lowercase 64-character sha256 hex string');
  }
  if (!MODES.has(value.mode as Z0BridgeMode)) {
    errors.push('mode must be shadow or active');
  }
  if (!KINDS.has(value.kind as Z0BridgeKind)) {
    errors.push('kind must be plan, decide, dispatch, or observe');
  }
  if (!new Set<Z0BridgeStatus>(['completed', 'not_executed', 'rejected', 'failed', 'unknown'])
    .has(value.status as Z0BridgeStatus)) {
    errors.push('status is invalid');
  }
  for (const field of ['applied', 'replayed', 'reconcile_required'] as const) {
    if (typeof value[field] !== 'boolean') errors.push(`${field} must be boolean`);
  }
  if (!new Set<Z0BridgeRetry>(['none', 'caller_may_fallback', 'same_identity_only'])
    .has(value.retry as Z0BridgeRetry)) {
    errors.push('retry is invalid');
  }

  if (value.mode === 'shadow' && value.applied === true) {
    errors.push('shadow response cannot be applied');
  }

  if (
    value.mode === 'shadow' &&
    value.kind !== 'decide' &&
    value.status === 'unknown'
  ) {
    errors.push('side-effect-free shadow response cannot have unknown execution status');
  }

  if (
    value.mode === 'shadow' &&
    value.kind !== 'decide' &&
    value.reconcile_required === true
  ) {
    errors.push('side-effect-free shadow response cannot require reconciliation');
  }

  if (value.status === 'unknown') {
    if (value.reconcile_required !== true) errors.push('unknown status requires reconciliation');
    if (value.retry !== 'same_identity_only') errors.push('unknown status requires same_identity_only retry');
  }

  return errors;
}
