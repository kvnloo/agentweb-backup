import { createHash } from 'crypto';

export const Z0_BRIDGE_PROTOCOL_VERSION = 'agentweb.z0.bridge.v1' as const;

export type Z0BridgeMode = 'shadow' | 'advisory' | 'active';
export type Z0BridgeRiskClass = 'read' | 'artifact' | 'mutation' | 'external_side_effect';
export type Z0BridgeApprovalState = 'not_required' | 'required' | 'granted' | 'denied' | 'unknown';

export interface Z0BridgeEvidenceV1 {
  source_id: string;
  retrieved_at: string;
  sha256: string;
  content: string;
}

export interface Z0BridgeCapabilityV1 {
  function: string;
  task: string;
  context?: string;
  state?: unknown;
  expected_parent_tokens?: number;
  expected_parent_ms?: number;
  experimental?: boolean;
  automatic?: boolean;
  max_tokens?: number;
}

export interface Z0BridgePolicyV1 {
  allow_remote_context: boolean;
  free_only: boolean;
  risk_class: Z0BridgeRiskClass;
  approval_state: Z0BridgeApprovalState;
}

export interface AgentWebZ0BridgeRequestV1 {
  protocol_version: typeof Z0_BRIDGE_PROTOCOL_VERSION;
  mode: Z0BridgeMode;
  operation_id: string;
  trace_id: string;
  integration_instance: string;
  parent_agent: string;
  deadline_unix_ms: number;
  capability: Z0BridgeCapabilityV1;
  policy: Z0BridgePolicyV1;
  evidence?: Z0BridgeEvidenceV1[];
  correlation?: {
    reliability_event_id?: string;
    observation_id?: string;
  };
}

export interface BuildAgentWebZ0BridgeRequestV1Params {
  mode: Z0BridgeMode;
  operationId: string;
  sessionId: string;
  integrationInstanceId: string;
  deadlineUnixMs: number;
  capability: Z0BridgeCapabilityV1;
  policy: Z0BridgePolicyV1;
  evidence?: Z0BridgeEvidenceV1[];
  correlation?: AgentWebZ0BridgeRequestV1['correlation'];
}

const MAX_REQUEST_BYTES = 48_000;
const HEX_64 = /^[0-9a-f]{64}$/;
const PARENT = /^agentweb:[0-9a-f]{24,64}$/;
const INSTANCE = /^agentweb-instance:[0-9a-f]{16,64}$/;
const TZ_SUFFIX = /(Z|[+-]\d{2}:\d{2})$/;

const TOP_LEVEL_KEYS = new Set([
  'protocol_version',
  'mode',
  'operation_id',
  'trace_id',
  'integration_instance',
  'parent_agent',
  'deadline_unix_ms',
  'capability',
  'policy',
  'evidence',
  'correlation',
]);
const CAPABILITY_KEYS = new Set([
  'function',
  'task',
  'context',
  'state',
  'expected_parent_tokens',
  'expected_parent_ms',
  'experimental',
  'automatic',
  'max_tokens',
]);
const POLICY_KEYS = new Set([
  'allow_remote_context',
  'free_only',
  'risk_class',
  'approval_state',
]);
const EVIDENCE_KEYS = new Set(['source_id', 'retrieved_at', 'sha256', 'content']);
const CORRELATION_KEYS = new Set(['reliability_event_id', 'observation_id']);
const FORBIDDEN_KEYS = new Set([
  'user_id',
  'userid',
  'session_id',
  'sessionid',
  'api_key',
  'apikey',
  'access_token',
  'accesstoken',
  'authorization',
  'credential',
  'credentials',
  'password',
  'secret',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function pseudonymousAgentWebParent(sessionId: string): string {
  if (!sessionId?.trim()) throw new Error('sessionId is required');
  return `agentweb:${sha256(sessionId).slice(0, 24)}`;
}

export function pseudonymousAgentWebIntegrationInstance(integrationInstanceId: string): string {
  if (!integrationInstanceId?.trim()) throw new Error('integrationInstanceId is required');
  return `agentweb-instance:${sha256(integrationInstanceId).slice(0, 24)}`;
}

export function deriveAgentWebZ0TraceId(parentAgent: string, operationId: string): string {
  if (!operationId?.trim()) throw new Error('operationId is required');
  return sha256(`${parentAgent}\0${operationId}`);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value).filter(key => !allowed.has(key)).sort();
}

function findForbiddenKey(value: unknown, path = '$'): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findForbiddenKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(normalizeKey(key))) return `${path}.${key}`;
    const found = findForbiddenKey(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => item === undefined ? 'null' : stableJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
}

export function canonicalAgentWebZ0RequestFingerprint(request: AgentWebZ0BridgeRequestV1): string {
  const correlation = request.correlation ? { ...request.correlation } : undefined;
  if (correlation) delete correlation.observation_id;
  const semantic: AgentWebZ0BridgeRequestV1 = {
    ...request,
    correlation,
  };
  return sha256(stableJson(semantic));
}

function validateEvidence(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'evidence items must be objects';
  const raw = item as Record<string, unknown>;
  const extras = unknownKeys(raw, EVIDENCE_KEYS);
  if (extras.length) return `unknown evidence fields: ${extras.join(',')}`;

  const sourceId = raw.source_id;
  const retrievedAt = raw.retrieved_at;
  const digest = raw.sha256;
  const content = raw.content;
  if (typeof sourceId !== 'string' || !sourceId.trim() || sourceId.length > 200) return 'invalid evidence source_id';
  if (
    typeof retrievedAt !== 'string' ||
    !retrievedAt ||
    retrievedAt.length > 64 ||
    !TZ_SUFFIX.test(retrievedAt) ||
    !Number.isFinite(Date.parse(retrievedAt))
  ) {
    return 'invalid evidence retrieved_at';
  }
  if (typeof digest !== 'string' || !HEX_64.test(digest)) return 'invalid evidence sha256';
  if (typeof content !== 'string' || !content.trim() || content.length > 8000) return 'invalid evidence content';
  if (sha256(content) !== digest) return 'evidence sha256 does not match content';
  return null;
}

export function validateAgentWebZ0BridgeRequestV1(
  request: unknown,
  nowUnixMs = Date.now(),
): string | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'request must be an object';
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(request);
  } catch {
    return 'request must be JSON-serializable';
  }
  if (encoded === undefined) return 'request must be JSON-serializable';
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) return 'request too large';

  const raw = request as Record<string, unknown>;
  const extraTop = unknownKeys(raw, TOP_LEVEL_KEYS);
  if (extraTop.length) return `unknown top-level fields: ${extraTop.join(',')}`;

  const typed = raw as unknown as AgentWebZ0BridgeRequestV1;
  if (typed.protocol_version !== Z0_BRIDGE_PROTOCOL_VERSION) return 'unsupported protocol_version';
  if (!['shadow', 'advisory', 'active'].includes(typed.mode)) return 'unsupported mode';
  if (!typed.operation_id?.trim() || typed.operation_id.length > 200) return 'invalid operation_id';
  if (!PARENT.test(typed.parent_agent)) return 'parent_agent must be pseudonymous';
  if (!INSTANCE.test(typed.integration_instance)) return 'integration_instance must be pseudonymous';
  if (!HEX_64.test(typed.trace_id)) return 'trace_id must be sha256 hex';
  if (typed.trace_id !== deriveAgentWebZ0TraceId(typed.parent_agent, typed.operation_id)) {
    return 'trace_id does not match parent_agent + operation_id';
  }
  if (!Number.isInteger(typed.deadline_unix_ms) || typed.deadline_unix_ms <= nowUnixMs) {
    return 'deadline_expired';
  }

  if (!typed.capability || typeof typed.capability !== 'object' || Array.isArray(typed.capability)) {
    return 'capability must be an object';
  }
  const capability = typed.capability;
  const extraCapability = unknownKeys(capability as unknown as Record<string, unknown>, CAPABILITY_KEYS);
  if (extraCapability.length) return `unknown capability fields: ${extraCapability.join(',')}`;
  if (!capability.function?.trim() || capability.function.length > 200) return 'invalid capability.function';
  if (!capability.task?.trim() || capability.task.length > 24000) return 'invalid capability.task';
  if (capability.context !== undefined && typeof capability.context !== 'string') return 'invalid capability.context';
  if (capability.experimental !== undefined && typeof capability.experimental !== 'boolean') {
    return 'invalid capability.experimental';
  }
  if (capability.automatic !== undefined && typeof capability.automatic !== 'boolean') {
    return 'invalid capability.automatic';
  }
  for (const value of [capability.expected_parent_tokens, capability.expected_parent_ms]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return 'invalid parent estimate';
  }
  if (
    capability.max_tokens !== undefined &&
    (!Number.isInteger(capability.max_tokens) || capability.max_tokens < 1 || capability.max_tokens > 2048)
  ) {
    return 'invalid capability.max_tokens';
  }

  if (!typed.policy || typeof typed.policy !== 'object' || Array.isArray(typed.policy)) {
    return 'policy must be an object';
  }
  const policy = typed.policy;
  const extraPolicy = unknownKeys(policy as unknown as Record<string, unknown>, POLICY_KEYS);
  if (extraPolicy.length) return `unknown policy fields: ${extraPolicy.join(',')}`;
  if (typeof policy.allow_remote_context !== 'boolean') return 'invalid policy.allow_remote_context';
  if (typeof policy.free_only !== 'boolean') return 'invalid policy.free_only';
  if (!['read', 'artifact', 'mutation', 'external_side_effect'].includes(policy.risk_class)) {
    return 'unsupported risk_class';
  }
  if (!['not_required', 'required', 'granted', 'denied', 'unknown'].includes(policy.approval_state)) {
    return 'unsupported approval_state';
  }
  if (
    typed.mode === 'active' &&
    ['mutation', 'external_side_effect'].includes(policy.risk_class) &&
    policy.approval_state !== 'granted'
  ) {
    return 'active mutation/external side effect requires approval_state=granted';
  }

  const evidence = typed.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 16) return 'invalid evidence list';
  for (const item of evidence) {
    const error = validateEvidence(item);
    if (error) return error;
  }

  if (typed.correlation !== undefined) {
    if (!typed.correlation || typeof typed.correlation !== 'object' || Array.isArray(typed.correlation)) {
      return 'correlation must be an object';
    }
    const extraCorrelation = unknownKeys(
      typed.correlation as unknown as Record<string, unknown>,
      CORRELATION_KEYS,
    );
    if (extraCorrelation.length) return `unknown correlation fields: ${extraCorrelation.join(',')}`;
    for (const [key, value] of Object.entries(typed.correlation)) {
      if (typeof value !== 'string' || !value.trim() || value.length > 200) {
        return `invalid correlation.${key}`;
      }
    }
  }

  const forbidden = findForbiddenKey({
    capability: typed.capability,
    evidence: typed.evidence,
    correlation: typed.correlation,
  });
  if (forbidden) return `forbidden secret/raw-identity field at ${forbidden}`;

  return null;
}

export function buildAgentWebZ0BridgeRequestV1(
  params: BuildAgentWebZ0BridgeRequestV1Params,
): AgentWebZ0BridgeRequestV1 {
  const parentAgent = pseudonymousAgentWebParent(params.sessionId);
  const request: AgentWebZ0BridgeRequestV1 = {
    protocol_version: Z0_BRIDGE_PROTOCOL_VERSION,
    mode: params.mode,
    operation_id: params.operationId,
    trace_id: deriveAgentWebZ0TraceId(parentAgent, params.operationId),
    integration_instance: pseudonymousAgentWebIntegrationInstance(params.integrationInstanceId),
    parent_agent: parentAgent,
    deadline_unix_ms: params.deadlineUnixMs,
    capability: params.capability,
    policy: params.policy,
    evidence: params.evidence,
    correlation: params.correlation,
  };
  const validationError = validateAgentWebZ0BridgeRequestV1(request);
  if (validationError) throw new Error(`invalid AgentWeb/z0 bridge request: ${validationError}`);
  return request;
}
