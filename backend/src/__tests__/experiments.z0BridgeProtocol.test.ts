import {
  Z0_BRIDGE_SCHEMA_V1,
  bridgeFailureDisposition,
  validateZ0BridgeRequestV1,
  validateZ0BridgeResponseV1,
  type Z0BridgeRequestV1,
} from '../emma/z0BridgeProtocol';

const validRequest: Z0BridgeRequestV1 = {
  schema: Z0_BRIDGE_SCHEMA_V1,
  operation_id: 'turn-17:report-type',
  trace_id: 'a'.repeat(64),
  parent_agent: `agentweb:${'b'.repeat(24)}`,
  mode: 'shadow',
  kind: 'decide',
  capability: 'experiment.report_type_v1',
  policy: {
    allow_remote: false,
    free_only: true,
    experimental: true,
    risk_class: 'read',
    approval_state: 'not_required',
  },
  payload: {
    filename: 'report.html',
    excerpt: 'CTR ROAS spend',
  },
};

describe('agentweb.z0.bridge.v1', () => {
  it('accepts the minimal bounded shadow envelope', () => {
    expect(validateZ0BridgeRequestV1(validRequest)).toEqual([]);
  });

  it.each(['userId', 'session_id', 'apiKey', 'authorization', 'cookie'])(
    'rejects forbidden identity/credential field %s',
    field => {
      expect(validateZ0BridgeRequestV1({ ...validRequest, [field]: 'secret' }))
        .toContain(`forbidden top-level field: ${field}`);
    },
  );

  it('requires confirmed AgentWeb approval before active external side effects', () => {
    const request = {
      ...validRequest,
      mode: 'active',
      kind: 'dispatch',
      policy: {
        ...validRequest.policy,
        risk_class: 'external_side_effect',
        approval_state: 'required',
      },
    };
    expect(validateZ0BridgeRequestV1(request))
      .toContain('active external_side_effect dispatch requires confirmed AgentWeb approval');
  });

  it('fails open for side-effect-free shadow planning failures', () => {
    expect(bridgeFailureDisposition('shadow', 'timeout', 'plan')).toEqual({
      status: 'not_executed',
      reconcile_required: false,
      retry: 'caller_may_fallback',
    });
  });

  it('preserves ambiguity for shadow decisions that may already have called a model', () => {
    expect(bridgeFailureDisposition('shadow', 'timeout', 'decide')).toEqual({
      status: 'unknown',
      reconcile_required: true,
      retry: 'same_identity_only',
    });
  });

  it('preserves ambiguity for active timeout/transport failures', () => {
    expect(bridgeFailureDisposition('active', 'timeout')).toEqual({
      status: 'unknown',
      reconcile_required: true,
      retry: 'same_identity_only',
    });
    expect(bridgeFailureDisposition('active', 'invalid_response')).toEqual({
      status: 'unknown',
      reconcile_required: true,
      retry: 'same_identity_only',
    });
  });

  it('treats trace conflict as rejection rather than a second execution', () => {
    expect(bridgeFailureDisposition('active', 'trace_conflict')).toEqual({
      status: 'rejected',
      reconcile_required: false,
      retry: 'none',
    });
  });

  it('rejects impossible side-effect-free shadow response semantics', () => {
    const errors = validateZ0BridgeResponseV1({
      schema: Z0_BRIDGE_SCHEMA_V1,
      operation_id: 'op-1',
      trace_id: 'c'.repeat(64),
      mode: 'shadow',
      kind: 'plan',
      status: 'unknown',
      applied: true,
      replayed: false,
      reconcile_required: true,
      retry: 'same_identity_only',
    });

    expect(errors).toEqual(expect.arrayContaining([
      'shadow response cannot be applied',
      'side-effect-free shadow response cannot have unknown execution status',
      'side-effect-free shadow response cannot require reconciliation',
    ]));
  });

  it('allows shadow decision ambiguity while keeping the result unapplied', () => {
    expect(validateZ0BridgeResponseV1({
      schema: Z0_BRIDGE_SCHEMA_V1,
      operation_id: 'op-2',
      trace_id: 'd'.repeat(64),
      mode: 'shadow',
      kind: 'decide',
      status: 'unknown',
      applied: false,
      replayed: false,
      reconcile_required: true,
      retry: 'same_identity_only',
    })).toEqual([]);
  });
});
