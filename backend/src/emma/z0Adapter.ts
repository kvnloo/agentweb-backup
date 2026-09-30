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

export function agentWebTraceId(parentAgent: string, args: Pick<Z0RouteArgs, 'operation_id' | 'function'>): string {
  if (!args.operation_id?.trim()) throw new Error('operation_id is required');
  if (!args.function?.trim()) throw new Error('function is required');
  return sha256(`${parentAgent}\0${args.operation_id}\0${args.function}`);
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
