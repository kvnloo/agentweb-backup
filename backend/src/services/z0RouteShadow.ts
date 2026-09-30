import { createHash } from 'crypto';
import {
  readZ0AgentWebConfig,
  runZ0Route,
  type Z0FetchLike,
} from '../emma/z0Adapter';

export interface Z0RouteShadowOptions {
  sessionId: string;
  task: string;
  turnOrdinal: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: Z0FetchLike;
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

export async function runZ0RouteShadow(
  options: Z0RouteShadowOptions,
): Promise<any> {
  const env = options.env ?? process.env;
  if (readZ0RouteShadowMode(env) === 'off') {
    return { ok: false, skipped: true, reason: 'disabled', executed: false };
  }
  if (env.Z0INT_ROUTE_SHADOW_ALLOW !== '1') {
    return {
      ok: false,
      skipped: true,
      reason: 'route_boundary_not_authorized',
      executed: false,
    };
  }
  if (!options.task?.trim()) {
    return {
      ok: false,
      skipped: true,
      reason: 'empty_task',
      executed: false,
    };
  }

  const base = readZ0AgentWebConfig(env);
  return runZ0Route(
    {
      operation_id: buildZ0RouteShadowOperationId(
        options.task,
        options.turnOrdinal,
      ),
      task: options.task.slice(0, 24000),
      function: 'native_turn',
      allow_remote: false,
      experimental: false,
    },
    {
      sessionId: options.sessionId,
      config: {
        ...base,
        mode: 'shadow',
        timeoutMs: Math.min(base.timeoutMs, 1000),
      },
      fetchImpl: options.fetchImpl,
    },
  );
}

export function logZ0RouteShadow(result: any): void {
  const route = result?.route ?? {};
  console.log(JSON.stringify({
    event: 'z0_route_shadow',
    ok: result?.ok === true,
    reason: result?.reason ?? null,
    traceId: result?.trace_id ?? null,
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
): void {
  if (readZ0RouteShadowMode() === 'off') return;
  void runZ0RouteShadow({ sessionId, task, turnOrdinal }).then(
    logZ0RouteShadow,
    () => logZ0RouteShadow({ ok: false, reason: 'shadow_exception' }),
  );
}
