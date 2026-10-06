import {
  assignZ0ActiveCanary,
  readZ0ActiveCanaryConfig,
  runZ0CanaryRoute,
  type Z0ActiveCanaryConfig,
} from '../emma/z0ActiveCanary';
import type { Z0AgentWebConfig, Z0FetchLike } from '../emma/z0Adapter';
import { pseudonymousAgentWebParent } from '../emma/z0Adapter';
import { clearZ0BridgeBackpressureStateForTests } from '../emma/z0BridgeBackpressure';
import { clearZ0SidecarStartupCacheForTests } from '../emma/z0SidecarDeployment';

const request = {
  operation_id: 'canary-op-1',
  task: 'bounded canary fixture',
  function: 'summarization',
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

const ready = {
  ok: true,
  authority_protocol_version: 2,
  scope: 'fixture',
  max_active: 4,
  socket_backlog: 8,
  queue_policy: 'reject_excess',
  overload_execution: 'not_started',
  overload_execution_header: 'X-Z0-Execution',
};

function canary(
  overrides: Partial<Z0ActiveCanaryConfig> = {},
): Z0ActiveCanaryConfig {
  return {
    enabled: true,
    fraction: 1,
    killSwitch: false,
    ...overrides,
  };
}

function config(overrides: Partial<Z0AgentWebConfig> = {}): Z0AgentWebConfig {
  return {
    mode: 'shadow',
    baseUrl: 'http://127.0.0.1:11501',
    timeoutMs: 1000,
    deploymentMode: 'sidecar',
    backpressureMode: 'enforce',
    ...overrides,
  };
}

function fixture(options: { activeStatus?: number; activeProof?: boolean } = {}) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  const fetchImpl = jest.fn(async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });

    if (method === 'GET') {
      if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith('/readyz')) return new Response(JSON.stringify(ready), { status: 200 });
      if (url.endsWith('/v1/bridge/deployment-profile')) {
        return new Response(JSON.stringify(profile), { status: 200 });
      }
      if (url.endsWith('/v1/bridge/capabilities')) {
        return new Response(JSON.stringify(capabilities), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }

    if (options.activeStatus && url.endsWith('/v1/intelligence')) {
      return new Response('', {
        status: options.activeStatus,
        headers: options.activeProof
          ? { 'Retry-After': '1', 'X-Z0-Execution': 'not_started' }
          : { 'Retry-After': '1' },
      });
    }

    const active = body.mode === 'active';
    return new Response(JSON.stringify({
      schema: 'agentweb.z0.bridge.v1',
      operation_id: body.operation_id,
      trace_id: body.trace_id,
      mode: body.mode,
      kind: body.kind,
      status: 'completed',
      applied: active,
      replayed: false,
      reconcile_required: false,
      retry: 'none',
      output: {
        ok: true,
        executed: active,
        applied: active,
        route: { kind: 'PARENT_ONLY' },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as Z0FetchLike;

  return { fetchImpl, calls };
}

describe('bounded z0 active canary', () => {
  beforeEach(() => {
    clearZ0SidecarStartupCacheForTests();
    clearZ0BridgeBackpressureStateForTests();
  });

  it('is disabled with zero fraction by default', () => {
    expect(readZ0ActiveCanaryConfig({} as NodeJS.ProcessEnv)).toEqual({
      enabled: false,
      fraction: 0,
      killSwitch: false,
    });
    expect(readZ0ActiveCanaryConfig({
      Z0INT_AGENTWEB_CANARY: 'enabled',
      Z0INT_AGENTWEB_CANARY_FRACTION: 'bogus',
    } as NodeJS.ProcessEnv).fraction).toBe(0);
  });

  it('assigns the same pseudonymous cohort deterministically', () => {
    const parent = pseudonymousAgentWebParent('raw-session-never-exported');
    const first = assignZ0ActiveCanary(parent, canary({ fraction: 0.5 }));
    const second = assignZ0ActiveCanary(parent, canary({ fraction: 0.5 }));
    expect(second).toEqual(first);
    expect(first.cohortId).toMatch(/^agentweb-canary:[a-f0-9]{24}$/);
    expect(JSON.stringify(first)).not.toContain('raw-session-never-exported');
  });

  it('keeps the default/reference path shadow-only', async () => {
    const f = fixture();
    const result = await runZ0CanaryRoute(request, {
      sessionId: 'session-reference',
      riskClass: 'generate',
      agentConfig: config({ deploymentMode: 'off', backpressureMode: 'off' }),
      canaryConfig: canary({ enabled: false, fraction: 0 }),
      fetchImpl: f.fetchImpl,
    });

    expect(result.canary).toMatchObject({
      arm: 'reference',
      active_requested: false,
      block_reason: 'canary_disabled',
    });
    expect(f.calls.filter(call => call.method === 'POST').map(call => call.url))
      .toEqual(['http://127.0.0.1:11501/v1/plan']);
  });

  it('activates a selected generate candidate only through sidecar + enforced backpressure', async () => {
    const f = fixture();
    const result = await runZ0CanaryRoute(request, {
      sessionId: 'raw-session-never-exported',
      riskClass: 'generate',
      agentConfig: config(),
      canaryConfig: canary(),
      fetchImpl: f.fetchImpl,
    });

    expect(result.canary).toMatchObject({
      arm: 'candidate',
      selected: true,
      active_requested: true,
      active_applied: true,
      risk_class: 'generate',
    });
    const posts = f.calls.filter(call => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('http://127.0.0.1:11501/v1/intelligence');
    expect(posts[0].body.policy.risk_class).toBe('generate');
    expect(JSON.stringify(f.calls)).not.toContain('raw-session-never-exported');
    expect(JSON.stringify(result.canary)).not.toContain('raw-session-never-exported');
  });

  it('hard kill preserves candidate assignment but immediately returns future work to shadow', async () => {
    const firstFixture = fixture();
    const first = await runZ0CanaryRoute(request, {
      sessionId: 'kill-session',
      riskClass: 'read',
      agentConfig: config(),
      canaryConfig: canary({ killSwitch: false }),
      fetchImpl: firstFixture.fetchImpl,
    });
    expect(first.canary).toMatchObject({ arm: 'candidate', active_requested: true });

    clearZ0SidecarStartupCacheForTests();
    clearZ0BridgeBackpressureStateForTests();

    const killedFixture = fixture();
    const killed = await runZ0CanaryRoute(
      { ...request, operation_id: 'canary-op-killed' },
      {
        sessionId: 'kill-session',
        riskClass: 'read',
        agentConfig: config(),
        canaryConfig: canary({ killSwitch: true }),
        fetchImpl: killedFixture.fetchImpl,
      },
    );

    expect(killed.canary.cohort_id).toBe(first.canary.cohort_id);
    expect(killed.canary).toMatchObject({
      arm: 'candidate',
      active_requested: false,
      active_applied: false,
      block_reason: 'kill_switch',
    });
    expect(killedFixture.calls.filter(call => call.method === 'POST').map(call => call.url))
      .toEqual(['http://127.0.0.1:11501/v1/plan']);
  });

  it.each(['mutate', 'external_side_effect'] as const)(
    'never activates forbidden risk class %s',
    async riskClass => {
      const f = fixture();
      const result = await runZ0CanaryRoute(request, {
        sessionId: 'risk-session',
        riskClass,
        agentConfig: config(),
        canaryConfig: canary(),
        fetchImpl: f.fetchImpl,
      });

      expect(result.canary).toMatchObject({
        arm: 'candidate',
        active_requested: false,
        block_reason: 'forbidden_risk_class',
      });
      expect(f.calls.some(call => call.url.endsWith('/v1/intelligence'))).toBe(false);
      const post = f.calls.find(call => call.method === 'POST');
      expect(post?.url).toBe('http://127.0.0.1:11501/v1/plan');
      expect(post?.body.policy.risk_class).toBe(riskClass);
    },
  );

  it('does not enter active canary without the loopback-sidecar deployment gate', async () => {
    const f = fixture();
    const result = await runZ0CanaryRoute(request, {
      sessionId: 'no-sidecar-session',
      riskClass: 'generate',
      agentConfig: config({ deploymentMode: 'off' }),
      canaryConfig: canary(),
      fetchImpl: f.fetchImpl,
    });

    expect(result.canary).toMatchObject({
      arm: 'candidate',
      active_requested: false,
      block_reason: 'sidecar_required',
    });
    expect(f.calls.filter(call => call.method === 'GET')).toHaveLength(0);
    expect(f.calls.filter(call => call.method === 'POST').map(call => call.url))
      .toEqual(['http://127.0.0.1:11501/v1/plan']);
  });

  it('does not enter active canary when backpressure enforcement is absent', async () => {
    const f = fixture();
    const result = await runZ0CanaryRoute(request, {
      sessionId: 'no-backpressure-session',
      riskClass: 'generate',
      agentConfig: config({ backpressureMode: 'off' }),
      canaryConfig: canary(),
      fetchImpl: f.fetchImpl,
    });

    expect(result.canary).toMatchObject({
      arm: 'candidate',
      active_requested: false,
      block_reason: 'backpressure_required',
    });
    expect(f.calls.some(call => call.url.endsWith('/v1/intelligence'))).toBe(false);
  });

  it('preserves ambiguous active execution and never falls through to shadow', async () => {
    const f = fixture({ activeStatus: 503, activeProof: false });
    const result = await runZ0CanaryRoute(request, {
      sessionId: 'ambiguous-session',
      riskClass: 'generate',
      agentConfig: config(),
      canaryConfig: canary(),
      fetchImpl: f.fetchImpl,
    });

    expect(result).toMatchObject({
      reason: 'http_error',
      execution_status: 'unknown',
      reconcile_required: true,
      bridge_retry: 'same_identity_only',
    });
    expect(result.canary).toMatchObject({
      arm: 'candidate',
      active_requested: true,
      active_applied: false,
    });
    const posts = f.calls.filter(call => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('http://127.0.0.1:11501/v1/intelligence');
  });

  it('keeps proven pre-execution overload non-ambiguous without a second z0 call', async () => {
    const f = fixture({ activeStatus: 503, activeProof: true });
    const result = await runZ0CanaryRoute(request, {
      sessionId: 'overload-session',
      riskClass: 'generate',
      agentConfig: config(),
      canaryConfig: canary(),
      fetchImpl: f.fetchImpl,
    });

    expect(result).toMatchObject({
      reason: 'overloaded_pre_execution',
      execution_status: 'not_executed',
      reconcile_required: false,
      bridge_retry: 'caller_may_fallback',
    });
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });
});
