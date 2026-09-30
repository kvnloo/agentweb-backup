import {
  buildZ0RouteShadowOperationId,
  readZ0RouteShadowMode,
  runZ0RouteShadow,
} from '../services/z0RouteShadow';
import type { Z0FetchLike } from '../emma/z0Adapter';

function response(payload: unknown): Z0FetchLike {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as unknown as Z0FetchLike;
}

describe('automatic z0 route-plan shadow observer', () => {
  it('is off by default', async () => {
    const fetchImpl = jest.fn() as unknown as Z0FetchLike;
    expect(readZ0RouteShadowMode({} as NodeJS.ProcessEnv)).toBe('off');
    const result = await runZ0RouteShadow({
      sessionId: 'raw-session',
      task: 'summarize this',
      turnOrdinal: 1,
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(result).toMatchObject({ reason: 'disabled', executed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a dedicated cross-process boundary authorization', async () => {
    const fetchImpl = jest.fn() as unknown as Z0FetchLike;
    const result = await runZ0RouteShadow({
      sessionId: 'raw-session',
      task: 'summarize this',
      turnOrdinal: 1,
      env: { Z0_ROUTE_SHADOW: 'shadow' } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(result).toMatchObject({
      reason: 'route_boundary_not_authorized',
      executed: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forces pure /v1/plan even when the generic z0 mode is active', async () => {
    const fetchImpl = response({
      ok: true,
      mode: 'shadow',
      executed: false,
      route: { kind: 'PARENT_ONLY', reason: 'fixture', executed: false },
    });
    const result = await runZ0RouteShadow({
      sessionId: 'raw-session-secret',
      task: 'summarize this bounded turn',
      turnOrdinal: 7,
      env: {
        Z0_ROUTE_SHADOW: 'shadow',
        Z0INT_ROUTE_SHADOW_ALLOW: '1',
        Z0INT_AGENTWEB_MODE: 'active',
        Z0INT_SERVICE_URL: 'http://z0.test',
        Z0INT_AGENTWEB_TIMEOUT_MS: '9999',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'shadow',
      executed: false,
      reconcile_required: false,
    });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('http://z0.test/v1/plan');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      harness: 'agentweb',
      function: 'native_turn',
      allow_remote: false,
      free_only: true,
    });
    expect(JSON.stringify(body)).not.toContain('raw-session-secret');
  });

  it('keeps operation identity deterministic per task + turn ordinal', () => {
    expect(buildZ0RouteShadowOperationId('task', 4)).toBe(
      buildZ0RouteShadowOperationId('task', 4),
    );
    expect(buildZ0RouteShadowOperationId('task', 4)).not.toBe(
      buildZ0RouteShadowOperationId('task', 5),
    );
  });
});
