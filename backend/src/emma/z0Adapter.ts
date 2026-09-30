/**
 * Downstream-only AgentWeb -> z0intelligence adapter.
 *
 * Default off. Shadow mode calls /v1/plan (no physical execution or canonical
 * dispatch receipt). Active mode calls /v1/intelligence and never retries after
 * an ambiguous response: the same operation identity must be reconciled.
 */
import { createHash } from 'crypto';

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
  const body: Record<string, unknown> = {
    harness: 'agentweb',
    trace_id: traceId,
    parent_agent: parentAgent,
    function: args.function,
    task: args.task,
    allow_remote: args.allow_remote === true,
    experimental: args.experimental === true,
    free_only: true,
  };
  if (args.context !== undefined) body.context = args.context;
  if (args.state !== undefined) body.state = args.state;
  if (args.expected_parent_tokens !== undefined) body.expected_parent_tokens = args.expected_parent_tokens;
  if (args.expected_parent_ms !== undefined) body.expected_parent_ms = args.expected_parent_ms;
  if (args.max_tokens !== undefined) body.max_tokens = args.max_tokens;

  const endpoint = config.mode === 'shadow' ? '/v1/plan' : '/v1/intelligence';
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
      return skipped(config.mode, 'http_error', `z0intelligence returned HTTP ${response.status}`, {
        trace_id: traceId,
        parent_agent: parentAgent,
        execution_status: config.mode === 'active' ? 'unknown' : 'not_executed',
        reconcile_required: config.mode === 'active',
      });
    }

    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return skipped(config.mode, 'invalid_response', 'z0intelligence returned a non-object response', {
        trace_id: traceId,
        parent_agent: parentAgent,
        execution_status: config.mode === 'active' ? 'unknown' : 'not_executed',
        reconcile_required: config.mode === 'active',
      });
    }

    return {
      ...(payload as Record<string, unknown>),
      z0: true,
      skipped: false,
      mode: config.mode,
      trace_id: traceId,
      parent_agent: parentAgent,
      reconcile_required: false,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return skipped(config.mode, isTimeout ? 'timeout' : 'transport_error', isTimeout
      ? `z0intelligence timed out after ${config.timeoutMs}ms`
      : 'z0intelligence transport failed', {
      trace_id: traceId,
      parent_agent: parentAgent,
      execution_status: config.mode === 'active' ? 'unknown' : 'not_executed',
      reconcile_required: config.mode === 'active',
      instruction:
        config.mode === 'active'
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
  const body = {
    harness: 'agentweb',
    trace_id: traceId,
    parent_agent: parentAgent,
    function: 'experimental_choice',
    decision_id: args.decision_id,
    state: args.state,
    instructions: args.instructions,
    options: args.options,
    allow_remote: true,
    experimental: true,
  };
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
      return {
        ok: false, skipped: true, executed: false, applied: false,
        mode: 'shadow', reason: 'http_error',
        message: `z0intelligence returned HTTP ${response.status}`,
        trace_id: traceId, parent_agent: parentAgent,
        execution_status: 'unknown', reconcile_required: true,
      };
    }
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        ok: false, skipped: true, executed: false, applied: false,
        mode: 'shadow', reason: 'invalid_response',
        message: 'z0intelligence returned a non-object experiment response',
        trace_id: traceId, parent_agent: parentAgent,
        execution_status: 'unknown', reconcile_required: true,
      };
    }
    return {
      ...(payload as Record<string, unknown>),
      z0: true,
      skipped: false,
      trace_id: traceId,
      parent_agent: parentAgent,
      reconcile_required: false,
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
      execution_status: 'unknown',
      reconcile_required: true,
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
  const body = {
    harness: 'agentweb',
    trace_id: traceId,
    parent_agent: parentAgent,
    function: 'experimental_noul',
    decision_id: args.decision_id,
    state: args.state,
    proposition: args.proposition,
    allow_remote: true,
    experimental: true,
  };
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
      return {
        ok: false, skipped: true, executed: false, applied: false,
        mode: 'shadow', reason: 'http_error',
        message: `z0intelligence returned HTTP ${response.status}`,
        trace_id: traceId, parent_agent: parentAgent,
        execution_status: 'unknown', reconcile_required: true,
      };
    }
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        ok: false, skipped: true, executed: false, applied: false,
        mode: 'shadow', reason: 'invalid_response',
        message: 'z0intelligence returned a non-object experiment response',
        trace_id: traceId, parent_agent: parentAgent,
        execution_status: 'unknown', reconcile_required: true,
      };
    }
    return {
      ...(payload as Record<string, unknown>),
      z0: true,
      skipped: false,
      trace_id: traceId,
      parent_agent: parentAgent,
      reconcile_required: false,
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
      execution_status: 'unknown',
      reconcile_required: true,
      instruction: 'Reconcile the identical decision_id + operation_id + request; never mint a new trace.',
    };
  } finally {
    clearTimeout(timer);
  }
}
