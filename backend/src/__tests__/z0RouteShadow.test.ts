import {
  buildZ0RouteShadowOperationId,
  readZ0RouteShadowMode,
  runZ0RouteShadow,
  type Z0BridgeFetchLike,
} from '../services/z0RouteShadow';
import { Z0_BRIDGE_PROTOCOL_VERSION } from '../services/z0BridgeContract';

function echoShadowResponse(): Z0BridgeFetchLike {
  return jest.fn(async (_url: string, init?: any) => {
    const body = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        protocol_version: Z0_BRIDGE_PROTOCOL_VERSION,
        mode: 'shadow',
        trace_id: body.trace_id,
        request_sha256: 'fixture',
        executed: false,
        reconcile_required: false,
        route: {
          kind: 'PARENT_ONLY',
          reason: 'fixture',
          executed: false,
        },
      }),
    };
  }) as unknown as Z0BridgeFetchLike;
}

describe('automatic z0 bridge-v1 route shadow observer', () => {
  it('is off by default', async () => {
    const fetchImpl = jest.fn() as unknown as Z0BridgeFetchLike;
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

  it('requires explicit boundary authorization and integration identity', async () => {
    const fetchImpl = jest.fn() as unknown as Z0BridgeFetchLike;
    const denied = await runZ0RouteShadow({
      sessionId: 'raw-session',
      task: 'summarize this',
      turnOrdinal: 1,
      env: { Z0_ROUTE_SHADOW: 'shadow' } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(denied).toMatchObject({
      reason: 'route_boundary_not_authorized',
      executed: false,
    });

    const missingInstance = await runZ0RouteShadow({
      sessionId: 'raw-session',
      task: 'summarize this',
      turnOrdinal: 1,
      env: {
        Z0_ROUTE_SHADOW: 'shadow',
        Z0INT_ROUTE_SHADOW_ALLOW: '1',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(missingInstance).toMatchObject({
      reason: 'integration_instance_missing',
      executed: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the canonical shadow envelope without raw session identity', async () => {
    const fetchImpl = echoShadowResponse();
    const result = await runZ0RouteShadow({
      sessionId: 'raw-session-secret',
      task: 'summarize this bounded turn',
      turnOrdinal: 7,
      nowUnixMs: 1_000,
      env: {
        Z0_ROUTE_SHADOW: 'shadow',
        Z0INT_ROUTE_SHADOW_ALLOW: '1',
        Z0INT_AGENTWEB_INSTANCE: 'workspace-secret',
        Z0INT_SERVICE_URL: 'http://z0.test/',
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
    expect(url).toBe('http://z0.test/v1/agentweb');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      protocol_version: Z0_BRIDGE_PROTOCOL_VERSION,
      mode: 'shadow',
      capability: {
        function: 'native_turn',
        task: 'summarize this bounded turn',
      },
      policy: {
        allow_remote_context: false,
        free_only: true,
        risk_class: 'read',
        approval_state: 'not_required',
      },
    });
    expect(body.deadline_unix_ms).toBe(2_000);
    expect(JSON.stringify(body)).not.toContain('raw-session-secret');
    expect(JSON.stringify(body)).not.toContain('workspace-secret');
  });

  it('fails closed if a shadow response claims physical execution', async () => {
    const fetchImpl = jest.fn(async (_url: string, init?: any) => {
      const body = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          protocol_version: Z0_BRIDGE_PROTOCOL_VERSION,
          mode: 'shadow',
          trace_id: body.trace_id,
          executed: true,
          reconcile_required: false,
        }),
      };
    }) as unknown as Z0BridgeFetchLike;

    const result = await runZ0RouteShadow({
      sessionId: 's',
      task: 't',
      turnOrdinal: 1,
      nowUnixMs: 1_000,
      env: {
        Z0_ROUTE_SHADOW: 'shadow',
        Z0INT_ROUTE_SHADOW_ALLOW: '1',
        Z0INT_AGENTWEB_INSTANCE: 'instance',
      } as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(result).toMatchObject({
      reason: 'shadow_execution_invariant_violation',
      executed: false,
    });
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
