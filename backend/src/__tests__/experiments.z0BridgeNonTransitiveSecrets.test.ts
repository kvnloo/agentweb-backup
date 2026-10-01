import {
  validateZ0BridgePayloadIsolationV1,
  validateZ0BridgeRequestV1,
  type Z0BridgeRequestV1,
} from '../emma/z0BridgeProtocol';
import {
  runZ0ChoiceExperiment,
  runZ0Route,
  type Z0AgentWebConfig,
  type Z0FetchLike,
} from '../emma/z0Adapter';

const baseRequest: Z0BridgeRequestV1 = {
  schema: 'agentweb.z0.bridge.v1',
  operation_id: 'security-op-1',
  trace_id: 'a'.repeat(64),
  parent_agent: `agentweb:${'b'.repeat(24)}`,
  mode: 'shadow',
  kind: 'plan',
  capability: 'summarization',
  policy: {
    allow_remote: false,
    free_only: true,
    experimental: false,
    risk_class: 'read',
    approval_state: 'not_required',
  },
  payload: {
    function: 'summarization',
    task: 'summarize fixture',
  },
};

const shadowConfig: Z0AgentWebConfig = {
  mode: 'shadow',
  baseUrl: 'http://z0.test',
  timeoutMs: 1000,
};

describe('z0 bridge credential and identity non-transitivity', () => {
  it.each([
    ['apiKey', 'secret'],
    ['access_token', 'secret'],
    ['refresh-token', 'secret'],
    ['Authorization', 'Bearer secret'],
    ['clientSecret', 'secret'],
    ['private_key', 'secret'],
    ['userId', 'raw-user'],
    ['account_id', 'raw-account'],
    ['sessionId', 'raw-session'],
  ])('rejects nested sensitive key %s', (key, secret) => {
    const errors = validateZ0BridgeRequestV1({
      ...baseRequest,
      payload: {
        function: 'summarization',
        task: 'fixture',
        state: {
          nested: {
            [key]: secret,
          },
        },
      },
    });

    expect(errors.some(error => error.includes(`.${key}:`))).toBe(true);
  });

  it('rejects sensitive keys nested inside arrays', () => {
    expect(validateZ0BridgePayloadIsolationV1({
      records: [
        { safe: true },
        { metadata: { oauthToken: 'secret' } },
      ],
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('oauthToken'),
    ]));
  });

  it('allows prose values that discuss credentials without carrying structured credential fields', () => {
    expect(validateZ0BridgePayloadIsolationV1({
      excerpt: 'Documentation example: send an Authorization header with an API key.',
      note: 'Never paste passwords into production prompts.',
    })).toEqual([]);
  });

  it('fails closed on cyclic payloads', () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    expect(validateZ0BridgePayloadIsolationV1(payload))
      .toContain('payload must be acyclic');
  });

  it('fails closed when payload depth exceeds the traversal budget', () => {
    let payload: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 14; index += 1) {
      payload = { next: payload };
    }
    expect(validateZ0BridgePayloadIsolationV1(payload)).toEqual(expect.arrayContaining([
      expect.stringContaining('max depth'),
    ]));
  });

  it('fails closed when payload node count exceeds the traversal budget', () => {
    expect(validateZ0BridgePayloadIsolationV1({
      values: Array.from({ length: 4100 }, (_, index) => index),
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('max node count'),
    ]));
  });

  it('blocks nested raw identity before route transport', async () => {
    const fetchImpl = jest.fn() as unknown as Z0FetchLike;

    const result = await runZ0Route({
      operation_id: 'route-security-1',
      task: 'summarize',
      function: 'summarization',
      state: {
        evidence: {
          sessionId: 'raw-agentweb-session',
        },
      },
    }, {
      sessionId: 'adapter-scope',
      config: shadowConfig,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      executed: false,
      reason: 'bridge_policy_violation',
      execution_status: 'rejected',
      reconcile_required: false,
      bridge_retry: 'none',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks nested credentials before decision transport', async () => {
    const fetchImpl = jest.fn() as unknown as Z0FetchLike;

    const result = await runZ0ChoiceExperiment({
      operation_id: 'choice-security-1',
      decision_id: 'report_type_v1',
      state: {
        report: {
          headers: {
            authorization: 'Bearer secret',
          },
        },
      },
      instructions: 'Classify.',
      options: {
        creative: 'creative',
        performance: 'performance',
      },
      allow_remote: true,
    }, {
      scopeId: 'choice-security',
      config: shadowConfig,
      fetchImpl,
    });

    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      executed: false,
      applied: false,
      reason: 'bridge_policy_violation',
      execution_status: 'rejected',
      reconcile_required: false,
      bridge_retry: 'none',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
