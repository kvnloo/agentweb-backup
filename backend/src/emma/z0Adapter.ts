/**
 * Downstream-only AgentWeb -> z0intelligence adapter.
 *
 * Default off. Shadow mode calls /v1/plan (no physical execution or canonical
 * dispatch receipt). Active mode calls /v1/intelligence and never retries after
 * an ambiguous response: the same operation identity must be reconciled.
 */
import { createHash } from 'crypto';
import {
  Z0_BRIDGE_SCHEMA_V1,
  bridgeFailureDisposition,
  validateZ0BridgeRequestV1,
  validateZ0BridgeResponseV1,
  type Z0BridgeKind,
  type Z0BridgeMode,
  type Z0BridgeRequestV1,
  type Z0BridgeResponseV1,
} from './z0BridgeProtocol';

export type Z0AgentWebMode = 'off' | 'shadow' | 'active';

export interface Z0AgentWebConfig {
  mode: Z0AgentWebMode;
  baseUrl: string;
  timeoutMs: number;
}

export interface Z0RouteArgs {
  operation_id: string;
  task: string;
  function: string;
  context?: string;
  state?: Record<string, unknown>;
  expected_parent_tokens?: number;
  expected_parent_ms?: number;
  allow_remote?: boolean;
  experimental?: boolean;
  max_tokens?: number;
}

export type Z0FetchLike = typeof fetch;

export interface Z0RouteOptions {
  sessionId: string;
  config?: Z0AgentWebConfig;
  fetchImpl?: Z0FetchLike;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:11501';
const DEFAULT_TIMEOUT_MS = 5000;

export function parseZ0AgentWebMode(raw: string | undefined): Z0AgentWebMode {
  const mode = (raw ?? 'off').trim().toLowerCase();
  if (mode === 'shadow' || mode === 'active') return mode;
  return 'off';
}

export function readZ0AgentWebConfig(env: NodeJS.ProcessEnv = process.env): Z0AgentWebConfig {
  const timeoutRaw = Number.parseInt(env.Z0INT_AGENTWEB_TIMEOUT_MS ?? '', 10);
  return {
    mode: parseZ0AgentWebMode(env.Z0INT_AGENTWEB_MODE),
    baseUrl: (env.Z0INT_SERVICE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    timeoutMs:
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 && timeoutRaw <= 120000
        ? timeoutRaw
        : DEFAULT_TIMEOUT_MS,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function pseudonymousAgentWebParent(sessionId: string): string {
  if (!sessionId?.trim()) throw new Error('sessionId is required');
  return `agentweb:${sha256(sessionId).slice(0, 24)}`;
}

export function agentWebTraceId(parentAgent: string, args: Pick<Z0RouteArgs, 'operation_id'>): string {
  if (!args.operation_id?.trim()) throw new Error('operation_id is required');
  return sha256(`${parentAgent}\0${args.operation_id}`);
}

function validateArgs(args: Z0RouteArgs): string | null {
  if (!args || typeof args !== 'object') return 'request must be an object';
  if (!args.operation_id?.trim() || args.operation_id.length > 200) return 'operation_id must be 1-200 characters';
  if (!args.function?.trim() || args.function.length > 200) return 'function must be 1-200 characters';
  if (!args.task?.trim() || args.task.length > 24000) return 'task must be 1-24000 characters';
  if (args.context !== undefined && typeof args.context !== 'string') return 'context must be a string';
  for (const [name, value] of [
    ['expected_parent_tokens', args.expected_parent_tokens],
    ['expected_parent_ms', args.expected_parent_ms],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) return `${name} must be non-negative`;
  }
  if (
    args.max_tokens !== undefined &&
    (!Number.isInteger(args.max_tokens) || args.max_tokens < 1 || args.max_tokens > 2048)
  ) {
    return 'max_tokens must be an integer from 1 to 2048';
  }
  return null;
}

function skipped(
  mode: Z0AgentWebMode,
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ok: false,
    skipped: true,
    executed: false,
    mode,
    reason,
    message,
    ...extra,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function buildBridgeRequest(params: {
  operationId: string;
  traceId: string;
  parentAgent: string;
  mode: Z0BridgeMode;
  kind: Z0BridgeKind;
  capability: string;
  allowRemote: boolean;
  freeOnly: boolean;
  experimental: boolean;
  payload: Record<string, unknown>;
}): Z0BridgeRequestV1 {
  const request: Z0BridgeRequestV1 = {
    schema: Z0_BRIDGE_SCHEMA_V1,
    operation_id: params.operationId,
    trace_id: params.traceId,
    parent_agent: params.parentAgent,
    mode: params.mode,
    kind: params.kind,
    capability: params.capability,
    policy: {
      allow_remote: params.allowRemote,
      free_only: params.freeOnly,
      experimental: params.experimental,
      risk_class: params.kind === 'decide' ? 'read' : 'generate',
      approval_state: 'not_required',
    },
    payload: params.payload,
  };
  const errors = validateZ0BridgeRequestV1(request);
  if (errors.length) {
    throw new Error(`bridge_policy_violation: ${errors.join('; ')}`);
  }
  return request;
}

function bridgePolicyMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unwrapBridgeResponse(
  payload: unknown,
  expected: {
    operationId: string;
    traceId: string;
    mode: Z0BridgeMode;
    kind: Z0BridgeKind;
  },
):
  | { bridge: Z0BridgeResponseV1; output: Record<string, unknown> }
  | { error: string } {
  const errors = validateZ0BridgeResponseV1(payload);
  if (errors.length) return { error: errors.join('; ') };

  const bridge = payload as Z0BridgeResponseV1;
  if (
    bridge.operation_id !== expected.operationId ||
    bridge.trace_id !== expected.traceId ||
    bridge.mode !== expected.mode ||
    bridge.kind !== expected.kind
  ) {
    return { error: 'bridge response identity/mode/kind mismatch' };
  }
  if (!isRecord(bridge.output)) {
    return { error: 'bridge response output must be an object' };
  }
  return { bridge, output: bridge.output };
}

function bridgeFailureExtra(
  mode: Z0BridgeMode,
  kind: Z0BridgeKind,
  failure: 'http_4xx' | 'http_5xx' | 'timeout' | 'transport' | 'invalid_response',
) {
  const disposition = bridgeFailureDisposition(mode, failure, kind);
  return {
    execution_status: disposition.status,
    reconcile_required: disposition.reconcile_required,
    bridge_retry: disposition.retry,
  };
}

export async function runZ0Route(args: Z0RouteArgs, options: Z0RouteOptions) {
  const config = options.config ?? readZ0AgentWebConfig();

  if (config.mode === 'off') {
    return skipped(config.mode, 'disabled', 'Z0INT_AGENTWEB_MODE is off; z0 routing skipped.');
  }

  const validationError = validateArgs(args);
  if (validationError) {
    return skipped(config.mode, 'validation_error', validationError);
  }

  let parentAgent: string;
  try {
    parentAgent = pseudonymousAgentWebParent(options.sessionId);
  } catch (error) {
    return skipped(config.mode, 'missing_session', error instanceof Error ? error.message : String(error));
  }

  const traceId = agentWebTraceId(parentAgent, args);
  const bridgeMode: Z0BridgeMode = config.mode === 'active' ? 'active' : 'shadow';
  const bridgeKind: Z0BridgeKind = bridgeMode === 'shadow' ? 'plan' : 'dispatch';
  const routePayload: Record<string, unknown> = {
    function: args.function,
    task: args.task,
  };
  if (args.context !== undefined) routePayload.context = args.context;
  if (args.state !== undefined) routePayload.state = args.state;
  if (args.expected_parent_tokens !== undefined) routePayload.expected_parent_tokens = args.expected_parent_tokens;
  if (args.expected_parent_ms !== undefined) routePayload.expected_parent_ms = args.expected_parent_ms;
  if (args.max_tokens !== undefined) routePayload.max_tokens = args.max_tokens;

  let body: Z0BridgeRequestV1;
  try {
    body = buildBridgeRequest({
      operationId: args.operation_id,
      traceId,
      parentAgent,
      mode: bridgeMode,
      kind: bridgeKind,
      capability: args.function,
      allowRemote: args.allow_remote === true,
      freeOnly: true,
      experimental: args.experimental === true,
      payload: routePayload,
    });
  } catch (error) {
    return skipped(config.mode, 'bridge_policy_violation', bridgePolicyMessage(error), {
      trace_id: traceId,
      parent_agent: parentAgent,
      execution_status: 'rejected',
      reconcile_required: false,
      bridge_retry: 'none',
    });
  }

  const endpoint = bridgeMode === 'shadow' ? '/v1/plan' : '/v1/intelligence';
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(`${config.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const failure = response.status >= 500 ? 'http_5xx' : 'http_4xx';
      return skipped(config.mode, 'http_error', `z0intelligence returned HTTP ${response.status}`, {
        trace_id: traceId,
        parent_agent: parentAgent,
        ...bridgeFailureExtra(bridgeMode, bridgeKind, failure),
      });
    }

    const payload = (await response.json()) as unknown;
    const unwrapped = unwrapBridgeResponse(payload, {
      operationId: args.operation_id,
      traceId,
      mode: bridgeMode,
      kind: bridgeKind,
    });
    if ('error' in unwrapped) {
      return skipped(config.mode, 'invalid_response', unwrapped.error, {
        trace_id: traceId,
        parent_agent: parentAgent,
        ...bridgeFailureExtra(bridgeMode, bridgeKind, 'invalid_response'),
      });
    }

    return {
      ...unwrapped.output,
      z0: true,
      skipped: false,
      mode: config.mode,
      trace_id: traceId,
      parent_agent: parentAgent,
      reconcile_required: unwrapped.bridge.reconcile_required,
      bridge_schema: unwrapped.bridge.schema,
      bridge_status: unwrapped.bridge.status,
      bridge_retry: unwrapped.bridge.retry,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return skipped(config.mode, isTimeout ? 'timeout' : 'transport_error', isTimeout
      ? `z0intelligence timed out after ${config.timeoutMs}ms`
      : 'z0intelligence transport failed', {
      trace_id: traceId,
      parent_agent: parentAgent,
      ...bridgeFailureExtra(bridgeMode, bridgeKind, isTimeout ? 'timeout' : 'transport'),
      instruction:
        bridgeMode === 'active'
          ? 'Retry only with the identical operation_id and request; never mint a new execution identity.'
          : 'Shadow planning made no physical model call.',
    });
  } finally {
    clearTimeout(timer);
  }
}


export interface Z0ChoiceExperimentArgs {
  operation_id: string;
  decision_id: string;
  state: string | Record<string, unknown> | unknown[];
  instructions: string;
  options: Record<string, string>;
  allow_remote?: boolean;
}

export interface Z0ChoiceExperimentOptions {
  scopeId: string;
  config?: Z0AgentWebConfig;
  fetchImpl?: Z0FetchLike;
}

export function agentWebChoiceExperimentTraceId(
  parentAgent: string,
  args: Pick<Z0ChoiceExperimentArgs, 'operation_id' | 'decision_id'>,
): string {
  if (!args.operation_id?.trim()) throw new Error('operation_id is required');
  if (!args.decision_id?.trim()) throw new Error('decision_id is required');
  return sha256(`${parentAgent}\0${args.decision_id}\0${args.operation_id}`);
}

function validateChoiceExperiment(args: Z0ChoiceExperimentArgs): string | null {
  if (!args.operation_id?.trim() || args.operation_id.length > 200) return 'operation_id must be 1-200 characters';
  if (!args.decision_id?.trim() || args.decision_id.length > 200) return 'decision_id must be 1-200 characters';
  if (!args.instructions?.trim() || args.instructions.length > 4000) return 'instructions must be 1-4000 characters';
  if (!args.state || !['string', 'object'].includes(typeof args.state)) return 'state must be nonempty structured data';
  if (!args.options || typeof args.options !== 'object' || Array.isArray(args.options)) return 'options must be an object';
  const entries = Object.entries(args.options);
  if (entries.length < 2 || entries.length > 16) return 'options must contain 2-16 labels';
  for (const [label, description] of entries) {
    if (!label.trim() || label.length > 80 || !description.trim() || description.length > 1000) {
      return 'option labels/descriptions must be bounded nonempty strings';
    }
  }
  return null;
}

export async function runZ0ChoiceExperiment(
  args: Z0ChoiceExperimentArgs,
  options: Z0ChoiceExperimentOptions,
) {
  const config = options.config ?? readZ0AgentWebConfig();
  if (config.mode === 'off') {
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow', reason: 'disabled',
      message: 'Z0INT_AGENTWEB_MODE is off; z0 choice experiment skipped.',
    };
  }

  const validationError = validateChoiceExperiment(args);
  if (validationError) {
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow', reason: 'validation_error', message: validationError,
    };
  }
  if (args.allow_remote !== true) {
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow', reason: 'remote_context_not_authorized',
      message: 'Explicit allow_remote=true is required before experiment state may leave AgentWeb.',
    };
  }

  let parentAgent: string;
  try {
    parentAgent = pseudonymousAgentWebParent(options.scopeId);
  } catch (error) {
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow', reason: 'missing_scope',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const traceId = agentWebChoiceExperimentTraceId(parentAgent, args);
  const bridgeMode: Z0BridgeMode = 'shadow';
  const bridgeKind: Z0BridgeKind = 'decide';
  let body: Z0BridgeRequestV1;
  try {
    body = buildBridgeRequest({
      operationId: args.operation_id,
      traceId,
      parentAgent,
      mode: bridgeMode,
      kind: bridgeKind,
      capability: `experiment.${args.decision_id}`,
      allowRemote: true,
      freeOnly: false,
      experimental: true,
      payload: {
        function: 'experimental_choice',
        decision_id: args.decision_id,
        state: args.state,
        instructions: args.instructions,
        options: args.options,
      },
    });
  } catch (error) {
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow', reason: 'bridge_policy_violation',
      message: bridgePolicyMessage(error),
      trace_id: traceId, parent_agent: parentAgent,
      execution_status: 'rejected', reconcile_required: false, bridge_retry: 'none',
    };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/experimental/choice`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = response.status >= 500 ? 'http_5xx' : 'http_4xx';
      return {
        ok: false, skipped: true, executed: false, applied: false,
        mode: 'shadow', reason: 'http_error',
        message: `z0intelligence returned HTTP ${response.status}`,
        trace_id: traceId, parent_agent: parentAgent,
        ...bridgeFailureExtra(bridgeMode, bridgeKind, failure),
      };
    }
    const payload = (await response.json()) as unknown;
    const unwrapped = unwrapBridgeResponse(payload, {
      operationId: args.operation_id,
      traceId,
      mode: bridgeMode,
      kind: bridgeKind,
    });
    if ('error' in unwrapped) {
      return {
        ok: false, skipped: true, executed: false, applied: false,
        mode: 'shadow', reason: 'invalid_response',
        message: unwrapped.error,
        trace_id: traceId, parent_agent: parentAgent,
        ...bridgeFailureExtra(bridgeMode, bridgeKind, 'invalid_response'),
      };
    }
    return {
      ...unwrapped.output,
      z0: true,
      skipped: false,
      trace_id: traceId,
      parent_agent: parentAgent,
      reconcile_required: unwrapped.bridge.reconcile_required,
      bridge_schema: unwrapped.bridge.schema,
      bridge_status: unwrapped.bridge.status,
      bridge_retry: unwrapped.bridge.retry,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow',
      reason: isTimeout ? 'timeout' : 'transport_error',
      message: isTimeout
        ? `z0intelligence timed out after ${config.timeoutMs}ms`
        : 'z0intelligence transport failed',
      trace_id: traceId,
      parent_agent: parentAgent,
      ...bridgeFailureExtra(bridgeMode, bridgeKind, isTimeout ? 'timeout' : 'transport'),
      instruction: 'Reconcile the identical decision_id + operation_id + request; never mint a new trace.',
    };
  } finally {
    clearTimeout(timer);
  }
}


export interface Z0NoulExperimentArgs {
  operation_id: string;
  decision_id: string;
  state: string | Record<string, unknown> | unknown[];
  proposition: string;
  allow_remote?: boolean;
}

export interface Z0NoulExperimentOptions {
  scopeId: string;
  config?: Z0AgentWebConfig;
  fetchImpl?: Z0FetchLike;
}

export function agentWebNoulExperimentTraceId(
  parentAgent: string,
  args: Pick<Z0NoulExperimentArgs, 'operation_id' | 'decision_id'>,
): string {
  if (!args.operation_id?.trim()) throw new Error('operation_id is required');
  if (!args.decision_id?.trim()) throw new Error('decision_id is required');
  return sha256(`${parentAgent}\0${args.decision_id}\0${args.operation_id}`);
}

export async function runZ0NoulExperiment(
  args: Z0NoulExperimentArgs,
  options: Z0NoulExperimentOptions,
) {
  const config = options.config ?? readZ0AgentWebConfig();
  if (config.mode === 'off') {
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow', reason: 'disabled',
      message: 'Z0INT_AGENTWEB_MODE is off; z0 noul experiment skipped.',
    };
  }
  if (!args.operation_id?.trim() || args.operation_id.length > 200) {
    return { ok: false, skipped: true, executed: false, applied: false, mode: 'shadow', reason: 'validation_error', message: 'operation_id must be 1-200 characters' };
  }
  if (!args.decision_id?.trim() || args.decision_id.length > 200) {
    return { ok: false, skipped: true, executed: false, applied: false, mode: 'shadow', reason: 'validation_error', message: 'decision_id must be 1-200 characters' };
  }
  if (!args.proposition?.trim() || args.proposition.length > 4000) {
    return { ok: false, skipped: true, executed: false, applied: false, mode: 'shadow', reason: 'validation_error', message: 'proposition must be 1-4000 characters' };
  }
  if (!args.state || !['string', 'object'].includes(typeof args.state)) {
    return { ok: false, skipped: true, executed: false, applied: false, mode: 'shadow', reason: 'validation_error', message: 'state must be nonempty structured data' };
  }
  if (args.allow_remote !== true) {
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow', reason: 'remote_context_not_authorized',
      message: 'Explicit allow_remote=true is required before experiment state may leave AgentWeb.',
    };
  }

  let parentAgent: string;
  try {
    parentAgent = pseudonymousAgentWebParent(options.scopeId);
  } catch (error) {
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow', reason: 'missing_scope',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const traceId = agentWebNoulExperimentTraceId(parentAgent, args);
  const bridgeMode: Z0BridgeMode = 'shadow';
  const bridgeKind: Z0BridgeKind = 'decide';
  let body: Z0BridgeRequestV1;
  try {
    body = buildBridgeRequest({
      operationId: args.operation_id,
      traceId,
      parentAgent,
      mode: bridgeMode,
      kind: bridgeKind,
      capability: `experiment.${args.decision_id}`,
      allowRemote: true,
      freeOnly: false,
      experimental: true,
      payload: {
        function: 'experimental_noul',
        decision_id: args.decision_id,
        state: args.state,
        proposition: args.proposition,
      },
    });
  } catch (error) {
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow', reason: 'bridge_policy_violation',
      message: bridgePolicyMessage(error),
      trace_id: traceId, parent_agent: parentAgent,
      execution_status: 'rejected', reconcile_required: false, bridge_retry: 'none',
    };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/experimental/noul`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = response.status >= 500 ? 'http_5xx' : 'http_4xx';
      return {
        ok: false, skipped: true, executed: false, applied: false,
        mode: 'shadow', reason: 'http_error',
        message: `z0intelligence returned HTTP ${response.status}`,
        trace_id: traceId, parent_agent: parentAgent,
        ...bridgeFailureExtra(bridgeMode, bridgeKind, failure),
      };
    }
    const payload = (await response.json()) as unknown;
    const unwrapped = unwrapBridgeResponse(payload, {
      operationId: args.operation_id,
      traceId,
      mode: bridgeMode,
      kind: bridgeKind,
    });
    if ('error' in unwrapped) {
      return {
        ok: false, skipped: true, executed: false, applied: false,
        mode: 'shadow', reason: 'invalid_response',
        message: unwrapped.error,
        trace_id: traceId, parent_agent: parentAgent,
        ...bridgeFailureExtra(bridgeMode, bridgeKind, 'invalid_response'),
      };
    }
    return {
      ...unwrapped.output,
      z0: true,
      skipped: false,
      trace_id: traceId,
      parent_agent: parentAgent,
      reconcile_required: unwrapped.bridge.reconcile_required,
      bridge_schema: unwrapped.bridge.schema,
      bridge_status: unwrapped.bridge.status,
      bridge_retry: unwrapped.bridge.retry,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false, skipped: true, executed: false, applied: false,
      mode: 'shadow',
      reason: isTimeout ? 'timeout' : 'transport_error',
      message: isTimeout
        ? `z0intelligence timed out after ${config.timeoutMs}ms`
        : 'z0intelligence transport failed',
      trace_id: traceId,
      parent_agent: parentAgent,
      ...bridgeFailureExtra(bridgeMode, bridgeKind, isTimeout ? 'timeout' : 'transport'),
      instruction: 'Reconcile the identical decision_id + operation_id + request; never mint a new trace.',
    };
  } finally {
    clearTimeout(timer);
  }
}
