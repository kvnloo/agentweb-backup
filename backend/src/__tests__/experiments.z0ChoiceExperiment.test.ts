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

function response(payload: unknown, status = 200): Z0FetchLike {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as Z0FetchLike;
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

  it('calls only the bounded z0 experiment endpoint and preserves shadow semantics', async () => {
    const fetchImpl = response({
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
    });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('http://z0.test/v1/experimental/choice');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      harness: 'agentweb',
      function: 'experimental_choice',
      decision_id: 'report_type_v1',
      allow_remote: true,
      experimental: true,
    });
    expect(body.parent_agent).toMatch(/^agentweb:[a-f0-9]{24}$/);
    expect(body.state).toEqual(args.state);
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

  it('marks ambiguous transport failure for same-trace reconciliation', async () => {
    const error = new Error('timeout');
    error.name = 'AbortError';
    const fetchImpl = jest.fn(async () => { throw error; }) as unknown as Z0FetchLike;

    const first = await runZ0ChoiceExperiment(args, { scopeId: 'report_type_v1', config, fetchImpl });
    const second = await runZ0ChoiceExperiment(args, { scopeId: 'report_type_v1', config, fetchImpl });

    expect(first).toMatchObject({
      reason: 'timeout',
      execution_status: 'unknown',
      reconcile_required: true,
      applied: false,
    });
    expect(first.trace_id).toBe(second.trace_id);
  });
});
