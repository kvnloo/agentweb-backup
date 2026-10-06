import {
  clearZ0BridgeBackpressureStateForTests,
} from '../emma/z0BridgeBackpressure';
import {
  clearZ0SidecarStartupCacheForTests,
} from '../emma/z0SidecarDeployment';
import {
  readZ0AgentWebConfig,
  runZ0Route,
  type Z0AgentWebConfig,
  type Z0FetchLike,
} from '../emma/z0Adapter';

const request = {
  operation_id: 'sidecar-op-1',
  task: 'bounded sidecar gate fixture',
  function: 'summarization',
};

const capabilities = {
  schema: 'agentweb.z0.bridge.capabilities.v1',
  bridge_protocol_versions: ['agentweb.z0.bridge.v1'],
  transport: {
    max_request_bytes: 40000,
    max_active: 4,
    socket_backlog: 8,
    overload_status: 503,
    retry_after_seconds: 1,
    queue_policy: 'reject_excess',
    overload_execution: 'not_started',
    overload_execution_header: 'X-Z0-Execution',
  },
  active_dispatch_supported: true,
  receipt_schemas: ['z0int.decision_receipt.v1'],
  endpoints: [
    {
      path: '/v1/plan',
      kind: 'plan',
      modes: ['shadow'],
      capability_source: 'payload.function',
      physical_execution: false,
      free_only: 'caller_explicit',
    },
    {
      path: '/v1/intelligence',
      kind: 'dispatch',
      modes: ['active'],
      capability_source: 'payload.function',
      physical_execution: true,
      free_only: 'caller_explicit',
    },
  ],
};

const profile = {
  schema: 'agentweb.z0.sidecar_profile.v1',
  deployment_mode: 'local_sidecar',
  transport: 'http',
  default_bind: '127.0.0.1',
  default_port: 11501,
  loopback_hosts: ['127.0.0.1', 'localhost', '::1'],
  public_wildcard_supported: false,
  tls_mode: 'none_loopback',
  mtls_gateway_supported: false,
  graceful_drain_supported: true,
  paths: {
    health: '/healthz',
    ready: '/readyz',
    capabilities: '/v1/bridge/capabilities',
    deployment_profile: '/v1/bridge/deployment-profile',
  },
  process: {
    entrypoint: 'python -m z0int.intelligence_service',
    default_args: ['--bind', '127.0.0.1', '--port', '11501'],
  },
  limits: {
    max_active: 4,
    socket_backlog: 8,
    overload_status: 503,
    overload_execution: 'not_started',
    overload_execution_header: 'X-Z0-Execution',
  },
  credentials_required: false,
};

const ready = {
  ok: true,
  authority_protocol_version: 2,
  scope: 'dispatch ready; model availability checked on call',
  max_active: 4,
  socket_backlog: 8,
  queue_policy: 'reject_excess',
  overload_execution: 'not_started',
  overload_execution_header: 'X-Z0-Execution',
};

function sidecarConfig(baseUrl = 'http://127.0.0.1:11501'): Z0AgentWebConfig {
  return {
    mode: 'shadow',
    baseUrl,
    timeoutMs: 1000,
    deploymentMode: 'sidecar',
  };
}

function makeFetch(options: { draining?: boolean } = {}) {
  let gets = 0;
  let posts = 0;

  const fetchImpl = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    const method = init?.method ?? 'GET';

    if (method === 'GET') {
      gets += 1;
      if (target.endsWith('/v1/bridge/deployment-profile')) {
        return new Response(JSON.stringify(profile), { status: 200 });
      }
      if (target.endsWith('/healthz')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (target.endsWith('/readyz')) {
        return new Response(
          JSON.stringify(options.draining ? { ok: false, draining: true } : ready),
          { status: options.draining ? 503 : 200 },
        );
      }
      if (target.endsWith('/v1/bridge/capabilities')) {
        return new Response(JSON.stringify(capabilities), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    }

    posts += 1;
    const body = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({
      schema: 'agentweb.z0.bridge.v1',
      operation_id: body.operation_id,
      trace_id: body.trace_id,
      mode: body.mode,
      kind: body.kind,
      status: 'completed',
      applied: false,
      replayed: false,
      reconcile_required: false,
      retry: 'none',
      output: {
        ok: true,
        executed: false,
        applied: false,
        route: { kind: 'PARENT_ONLY' },
      },
    }), { status: 200 });
  }) as unknown as Z0FetchLike;

  return {
    fetchImpl,
    counts: () => ({ gets, posts }),
  };
}

describe('z0 sidecar routing gate', () => {
  beforeEach(() => {
    clearZ0SidecarStartupCacheForTests();
    clearZ0BridgeBackpressureStateForTests();
  });

  it('reads deployment mode from the explicit default-off env switch', () => {
    const configured = readZ0AgentWebConfig({
      Z0INT_AGENTWEB_MODE: 'shadow',
      Z0INT_AGENTWEB_DEPLOYMENT: 'sidecar',
      Z0INT_SERVICE_URL: 'http://127.0.0.1:11501',
    } as NodeJS.ProcessEnv);

    expect(configured.deploymentMode).toBe('sidecar');
    expect(readZ0AgentWebConfig({} as NodeJS.ProcessEnv).deploymentMode).toBe('off');
  });

  it('rejects a non-loopback sidecar before any transport', async () => {
    const fetchImpl = jest.fn() as unknown as Z0FetchLike;
    const result = await runZ0Route(request, {
      sessionId: 'raw-session-never-exported',
      config: sidecarConfig('http://10.0.0.8:11501'),
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      executed: false,
      reason: 'sidecar_unavailable',
      execution_status: 'not_executed',
      reconcile_required: false,
      bridge_retry: 'caller_may_fallback',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('handshakes once, then reuses cached startup state across turns', async () => {
    const fixture = makeFetch();

    const first = await runZ0Route(request, {
      sessionId: 'session-1',
      config: sidecarConfig(),
      fetchImpl: fixture.fetchImpl,
    });
    const second = await runZ0Route(
      { ...request, operation_id: 'sidecar-op-2' },
      {
        sessionId: 'session-1',
        config: sidecarConfig(),
        fetchImpl: fixture.fetchImpl,
      },
    );

    expect(first).toMatchObject({ ok: true, mode: 'shadow' });
    expect(second).toMatchObject({ ok: true, mode: 'shadow' });
    expect(fixture.counts()).toEqual({ gets: 4, posts: 2 });
  });

  it('fails closed while draining without attempting route transport', async () => {
    const fixture = makeFetch({ draining: true });
    const result = await runZ0Route(request, {
      sessionId: 'session-1',
      config: sidecarConfig(),
      fetchImpl: fixture.fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: 'sidecar_unavailable',
      execution_status: 'not_executed',
      bridge_retry: 'caller_may_fallback',
    });
    expect(fixture.counts()).toEqual({ gets: 4, posts: 0 });
  });
});
