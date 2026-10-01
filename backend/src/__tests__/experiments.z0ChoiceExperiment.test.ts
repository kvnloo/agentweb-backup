import {
  agentWebChoiceExperimentTraceId,
  pseudonymousAgentWebParent,
  runZ0ChoiceExperiment,
  type Z0AgentWebConfig,
  type Z0FetchLike,
  type Z0ChoiceExperimentArgs,
} from '../emma/z0Adapter';

const args: Z0ChoiceExperimentArgs = {
  operation_id: 'fixture-op-1',
  decision_id: 'report_type_v1',
  state: { filename: 'report.html', excerpt: 'CTR ROAS spend' },
  instructions: 'Classify the report.',
  options: {
    creative: 'Marketing creative',
    performance: 'Paid media metrics',
    research: 'General research',
  },
  allow_remote: true,
};

const config: Z0AgentWebConfig = {
  mode: 'shadow',
  baseUrl: 'http://z0.test',
  timeoutMs: 1000,
};

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

describe('z0 choice experiment adapter', () => {
  it('refuses to export state without explicit remote authorization', async () => {
    const fetchImpl = jest.fn() as unknown as Z0FetchLike;
    const result = await runZ0ChoiceExperiment(
      { ...args, allow_remote: false },
      { scopeId: 'report_type_v1', config, fetchImpl },
    );
    expect(result).toMatchObject({
      ok: false,
      executed: false,
      applied: false,
      reason: 'remote_context_not_authorized',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('carries a paid observational decision in the v1 envelope and preserves shadow semantics', async () => {
    const fetchImpl = bridgeResponse({
      ok: true,
      executed: true,
      applied: false,
      mode: 'shadow',
      output: {
        model: 'jev-1.13.0',
        label: 'performance',
        probabilities: { creative: 0.01, performance: 0.98, research: 0.01 },
        confidence: 0.98,
      },
      dispatch_receipt_id: 'dispatch-fixture',
    });

    const result = await runZ0ChoiceExperiment(
      args,
      { scopeId: 'report_type_v1', config, fetchImpl },
    );

    expect(result).toMatchObject({
      ok: true,
      executed: true,
      applied: false,
      z0: true,
      reconcile_required: false,
      bridge_schema: 'agentweb.z0.bridge.v1',
      bridge_status: 'completed',
    });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('http://z0.test/v1/experimental/choice');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      schema: 'agentweb.z0.bridge.v1',
      operation_id: 'fixture-op-1',
      mode: 'shadow',
      kind: 'decide',
      capability: 'experiment.report_type_v1',
      policy: {
        allow_remote: true,
        free_only: false,
        experimental: true,
        risk_class: 'read',
        approval_state: 'not_required',
      },
      payload: {
        function: 'experimental_choice',
        decision_id: 'report_type_v1',
        state: args.state,
        instructions: args.instructions,
        options: args.options,
      },
    });
    expect(body.parent_agent).toMatch(/^agentweb:[a-f0-9]{24}$/);
  });

  it('keeps the same authority trace when state mutates under one logical operation', () => {
    const parent = pseudonymousAgentWebParent('report_type_v1');
    const first = agentWebChoiceExperimentTraceId(parent, args);
    const changed = agentWebChoiceExperimentTraceId(parent, {
      ...args,
      state: { filename: 'different.html' },
    });
    expect(changed).toBe(first);
  });

  it('uses decision_id as the schema/version namespace', () => {
    const parent = pseudonymousAgentWebParent('report_type_v1');
    expect(agentWebChoiceExperimentTraceId(parent, args)).not.toBe(
      agentWebChoiceExperimentTraceId(parent, { ...args, decision_id: 'report_type_v2' }),
    );
  });

  it('preserves ambiguous shadow-model execution for same-trace reconciliation', async () => {
    const error = new Error('timeout');
    error.name = 'AbortError';
    const fetchImpl = jest.fn(async () => { throw error; }) as unknown as Z0FetchLike;

    const first = await runZ0ChoiceExperiment(args, { scopeId: 'report_type_v1', config, fetchImpl });
    const second = await runZ0ChoiceExperiment(args, { scopeId: 'report_type_v1', config, fetchImpl });

    expect(first).toMatchObject({
      reason: 'timeout',
      execution_status: 'unknown',
      reconcile_required: true,
      bridge_retry: 'same_identity_only',
      applied: false,
    });
    expect(first.trace_id).toBe(second.trace_id);
  });

  it('treats a 4xx authority conflict as a known rejection, not ambiguous execution', async () => {
    const fetchImpl = bridgeResponse({ error: 'conflict' }, 400);
    const result = await runZ0ChoiceExperiment(args, { scopeId: 'report_type_v1', config, fetchImpl });
    expect(result).toMatchObject({
      reason: 'http_error',
      execution_status: 'rejected',
      reconcile_required: false,
      bridge_retry: 'none',
    });
  });
});
