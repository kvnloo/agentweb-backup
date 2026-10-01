import { createHash } from 'crypto';
import {
  Z0_BRIDGE_PROTOCOL_VERSION,
  buildAgentWebZ0BridgeRequestV1,
  type AgentWebZ0BridgeRequestV1,
} from './z0BridgeContract';

export type Z0BridgeFetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}>;

export interface Z0RouteShadowOptions {
  sessionId: string;
  task: string;
  turnOrdinal: number;
  observationId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Z0BridgeFetchLike;
  nowUnixMs?: number;
}

export function readZ0RouteShadowMode(
  env: NodeJS.ProcessEnv = process.env,
): 'off' | 'shadow' {
  return (env.Z0_ROUTE_SHADOW ?? '').trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'off';
}

export function buildZ0RouteShadowOperationId(
  task: string,
  turnOrdinal: number,
): string {
  return createHash('sha256')
    .update(`${turnOrdinal}\0${task}`)
    .digest('hex');
}

function readTimeoutMs(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.Z0INT_AGENTWEB_TIMEOUT_MS ?? 800);
  if (!Number.isFinite(configured)) return 800;
  return Math.max(100, Math.min(1000, Math.floor(configured)));
}

function readServiceUrl(env: NodeJS.ProcessEnv): string {
  return (env.Z0INT_SERVICE_URL ?? 'http://127.0.0.1:11501').replace(/\/+$/, '');
}

function skipped(reason: string) {
  return { ok: false, skipped: true, reason, executed: false };
}

function buildShadowRequest(
  options: Z0RouteShadowOptions,
  env: NodeJS.ProcessEnv,
  nowUnixMs: number,
): AgentWebZ0BridgeRequestV1 {
  const integrationInstanceId = (env.Z0INT_AGENTWEB_INSTANCE ?? '').trim();
  if (!integrationInstanceId) {
    throw new Error('integration_instance_missing');
  }
  const timeoutMs = readTimeoutMs(env);
  return buildAgentWebZ0BridgeRequestV1({
    mode: 'shadow',
    operationId: buildZ0RouteShadowOperationId(
      options.task,
      options.turnOrdinal,
    ),
    sessionId: options.sessionId,
    integrationInstanceId,
    deadlineUnixMs: nowUnixMs + timeoutMs,
    capability: {
      function: 'native_turn',
      task: options.task.slice(0, 24000),
      experimental: false,
      automatic: false,
      max_tokens: 256,
    },
    policy: {
      allow_remote_context: false,
      free_only: true,
      risk_class: 'read',
      approval_state: 'not_required',
    },
    correlation: options.observationId
      ? { observation_id: options.observationId }
      : undefined,
  });
}

export async function runZ0RouteShadow(
  options: Z0RouteShadowOptions,
): Promise<any> {
  const env = options.env ?? process.env;
  if (readZ0RouteShadowMode(env) === 'off') {
    return skipped('disabled');
  }
  if (env.Z0INT_ROUTE_SHADOW_ALLOW !== '1') {
    return skipped('route_boundary_not_authorized');
  }
  if (!options.task?.trim()) {
    return skipped('empty_task');
  }
  if (!(env.Z0INT_AGENTWEB_INSTANCE ?? '').trim()) {
    return skipped('integration_instance_missing');
  }

  const nowUnixMs = options.nowUnixMs ?? Date.now();
  const timeoutMs = readTimeoutMs(env);
  const request = buildShadowRequest(options, env, nowUnixMs);
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as Z0BridgeFetchLike);
  if (typeof fetchImpl !== 'function') {
    return skipped('fetch_unavailable');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${readServiceUrl(env)}/v1/agentweb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `bridge_http_${response.status}`,
        executed: false,
      };
    }

    const result = await response.json();
    if (
      result?.protocol_version !== Z0_BRIDGE_PROTOCOL_VERSION ||
      result?.mode !== 'shadow' ||
      result?.trace_id !== request.trace_id
    ) {
      return {
        ok: false,
        reason: 'invalid_bridge_response',
        executed: false,
      };
    }
    if (result?.executed !== false || result?.reconcile_required !== false) {
      return {
        ok: false,
        reason: 'shadow_execution_invariant_violation',
        executed: false,
      };
    }
    return {
      ...result,
      observation_id: request.correlation?.observation_id ?? null,
    };
  } catch (error: any) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'shadow_timeout' : 'bridge_unavailable',
      executed: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function logZ0RouteShadow(result: any): void {
  const route = result?.route ?? {};
  console.log(JSON.stringify({
    event: 'z0_route_shadow',
    ok: result?.ok === true,
    reason: result?.reason ?? null,
    traceId: result?.trace_id ?? null,
    requestSha256: result?.request_sha256 ?? null,
    observationId: result?.observation_id ?? null,
    routeKind: route?.kind ?? null,
    routeReason: route?.reason ?? null,
    executed: result?.executed === true || route?.executed === true,
    reconcileRequired: result?.reconcile_required === true,
  }));
}

export function observeZ0RouteShadow(
  sessionId: string,
  task: string,
  turnOrdinal: number,
  observationId?: string,
): void {
  if (readZ0RouteShadowMode() === 'off') return;
  void runZ0RouteShadow({ sessionId, task, turnOrdinal, observationId }).then(
    logZ0RouteShadow,
    () => logZ0RouteShadow({ ok: false, reason: 'shadow_exception' }),
  );
}
