import '../emma/jevTools';
import { emmaToolRegistry } from '../emma/registry';
import {
  agentWebTraceId,
  pseudonymousAgentWebParent,
  runZ0Route,
  type Z0AgentWebConfig,
  type Z0FetchLike,
  type Z0RouteArgs,
} from '../emma/z0Adapter';

const request: Z0RouteArgs = {
  operation_id: 'op-42',
  task: 'summarize this bounded fixture',
  function: 'summarization',
  expected_parent_tokens: 9000,
  expected_parent_ms: 40000,
};

function config(mode: 'off' | 'shadow' | 'active'): Z0AgentWebConfig {
  return { mode, baseUrl: 'http://z0.test', timeoutMs: 1000 };
}

function bridgeResponse(legacy: Record<string, any>, status = 200): Z0FetchLike {
  return jest.fn(async (_url: unknown, init?: RequestInit) => {
    const requestBody = JSON.parse(String(init?.body ?? '{}'));
    const payload = status >= 200 && status < 300
      ? {
          schema: 'agentweb.z0.bridge.v1',
          operation_id: requestBody.operation_id,
          trace_id: requestBody.trace_id,
          mode: requestBody.mode,
          kind: requestBody.kind,
          status: legacy.ok === true ? 'completed' : 'failed',
          applied: Boolean(legacy.applied),
          replayed: Boolean(legacy.replayed),
          reconcile_required: false,
          retry: 'none',
          output: legacy,
        }
      : legacy;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  }) as unknown as Z0FetchLike;
}

describe('z0 AgentWeb adapter', () => {
  it('defaults to an internal-only read-only Emma tool', () => {
    const tool = emmaToolRegistry.getTool('z0_route');
    expect(tool).toBeDefined();
    expect(tool?.readOnly).toBe(true);
    expect(tool?.internal).toBe(true);
    expect(tool?.internalOnly).toBe(true);
  });

  it('refuses the tool to an external MCP caller even when the caller knows its name', async () => {
    await expect(
      emmaToolRegistry.execute('z0_route', request, {
        externalMcp: true,
        sessionId: 'external-session',
      }),
    ).rejects.toThrow(/not available to external clients/i);
  });

  it('off mode makes no transport call', async () => {
    const fetchImpl = jest.fn() as unknown as Z0FetchLike;
    const result = await runZ0Route(request, {
      sessionId: 'raw-session',
      config: config('off'),
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, skipped: true, reason: 'disabled', executed: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('shadow mode carries v1 policy, forces free-only, and exports no raw session id', async () => {
    const fetchImpl = bridgeResponse({
      ok: true,
      mode: 'shadow',
      executed: false,
      route: { kind: 'PARENT_ONLY' },
    });
    const result = await runZ0Route(request, {
      sessionId: 'raw-session-secret',
      config: config('shadow'),
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'shadow',
      executed: false,
      reconcile_required: false,
      bridge_schema: 'agentweb.z0.bridge.v1',
      bridge_status: 'completed',
    });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('http://z0.test/v1/plan');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      schema: 'agentweb.z0.bridge.v1',
      operation_id: 'op-42',
      mode: 'shadow',
      kind: 'plan',
      capability: 'summarization',
      policy: {
        allow_remote: false,
        free_only: true,
        experimental: false,
        risk_class: 'generate',
        approval_state: 'not_required',
      },
      payload: {
        function: 'summarization',
        task: 'summarize this bounded fixture',
        expected_parent_tokens: 9000,
        expected_parent_ms: 40000,
      },
    });
    expect(JSON.stringify(body)).not.toContain('raw-session-secret');
    expect(body.parent_agent).toMatch(/^agentweb:[a-f0-9]{24}$/);
  });

  it('active ambiguity requires reconciliation with the same deterministic trace', async () => {
    const abort = new Error('timeout');
    abort.name = 'AbortError';
    const fetchImpl = jest.fn(async () => {
      throw abort;
    }) as unknown as Z0FetchLike;

    const first = await runZ0Route(request, {
      sessionId: 'raw-session-secret',
      config: config('active'),
      fetchImpl,
    });
    const second = await runZ0Route(request, {
      sessionId: 'raw-session-secret',
      config: config('active'),
      fetchImpl,
    });

    expect(first).toMatchObject({
      ok: false,
      reason: 'timeout',
      execution_status: 'unknown',
      reconcile_required: true,
      bridge_retry: 'same_identity_only',
    });
    expect(first.trace_id).toBe(second.trace_id);
    expect(first.trace_id).toBe(
      agentWebTraceId(pseudonymousAgentWebParent('raw-session-secret'), request),
    );

    const changedFunction = await runZ0Route(
      { ...request, function: 'research' },
      {
        sessionId: 'raw-session-secret',
        config: config('active'),
        fetchImpl,
      },
    );
    expect(changedFunction.trace_id).toBe(first.trace_id);
  });

  it('changed function under the same operation preserves the authority trace for conflict detection', () => {
    const parent = pseudonymousAgentWebParent('raw-session-secret');
    const changed: Z0RouteArgs = { ...request, function: 'research' };
    expect(agentWebTraceId(parent, request)).toBe(
      agentWebTraceId(parent, changed),
    );
  });

  it('the registered tool supplies Emma session identity to the adapter boundary', async () => {
    const previous = process.env.Z0INT_AGENTWEB_MODE;
    process.env.Z0INT_AGENTWEB_MODE = 'off';
    try {
      const result = await emmaToolRegistry.execute('z0_route', request, {
        sessionId: 'session-1',
        userId: 'user-never-exported',
      });
      expect(result).toMatchObject({ type: 'z0_route', reason: 'disabled' });
      expect(JSON.stringify(result)).not.toContain('user-never-exported');
    } finally {
      if (previous === undefined) delete process.env.Z0INT_AGENTWEB_MODE;
      else process.env.Z0INT_AGENTWEB_MODE = previous;
    }
  });
});
