import { createHash } from 'crypto';
import {
  Z0_BRIDGE_PROTOCOL_VERSION,
  buildAgentWebZ0BridgeRequestV1,
  canonicalAgentWebZ0RequestFingerprint,
  deriveAgentWebZ0TraceId,
  pseudonymousAgentWebIntegrationInstance,
  pseudonymousAgentWebParent,
  validateAgentWebZ0BridgeRequestV1,
} from '../services/z0BridgeContract';

const farFuture = 4_102_444_800_000;

function baseRequest() {
  const content = 'source-backed evidence';
  return buildAgentWebZ0BridgeRequestV1({
    mode: 'shadow',
    operationId: 'op-1',
    sessionId: 'session-123',
    integrationInstanceId: 'workspace-456',
    deadlineUnixMs: farFuture,
    capability: {
      function: 'evidence_sufficiency',
      task: 'Check whether the evidence supports the claim.',
      state: { question: 'Is the claim supported?', evidence: content },
      expected_parent_tokens: 800,
      expected_parent_ms: 1500,
      automatic: false,
      experimental: false,
      max_tokens: 256,
    },
    policy: {
      allow_remote_context: false,
      free_only: true,
      risk_class: 'read',
      approval_state: 'not_required',
    },
    evidence: [{
      source_id: 'agentweb:research:1',
      retrieved_at: '2026-10-01T06:00:00Z',
      sha256: createHash('sha256').update(content).digest('hex'),
      content,
    }],
    correlation: {
      reliability_event_id: 'rel-1',
      observation_id: 'obs-1',
    },
  });
}

describe('AgentWeb/z0 bridge v1', () => {
  it('matches the cross-language identity vector', () => {
    expect(pseudonymousAgentWebParent('session-123'))
      .toBe('agentweb:b9c84322f82434cb46e239d2');
    expect(pseudonymousAgentWebIntegrationInstance('workspace-456'))
      .toBe('agentweb-instance:e759e9548f57a639a875c728');
    expect(deriveAgentWebZ0TraceId('agentweb:b9c84322f82434cb46e239d2', 'op-1'))
      .toBe('7a5d9269c1dd2d24b217e178c7e4484ff2d74d8f56b2c75402ef5cb5d5ba0bae');
  });

  it('matches the cross-language semantic fingerprint vector', () => {
    expect(canonicalAgentWebZ0RequestFingerprint(baseRequest()))
      .toBe('9ca1481d7b9494c7b5ae2d75148722be73f1e99a899e7a1815cd17c5805d269d');
  });

  it('does not let a later observation join id mutate dispatch fingerprint', () => {
    const first = baseRequest();
    const second = baseRequest();
    second.correlation!.observation_id = 'later-observation';
    expect(canonicalAgentWebZ0RequestFingerprint(second))
      .toBe(canonicalAgentWebZ0RequestFingerprint(first));
  });

  it('builds a valid versioned request without crossing raw identity', () => {
    const request = baseRequest();
    expect(request.protocol_version).toBe(Z0_BRIDGE_PROTOCOL_VERSION);
    expect(request.parent_agent).not.toContain('session-123');
    expect(request.integration_instance).not.toContain('workspace-456');
    expect(validateAgentWebZ0BridgeRequestV1(request, 1_000)).toBeNull();
  });

  it('rejects unknown schema fields rather than silently forwarding them', () => {
    const request = baseRequest() as unknown as Record<string, unknown>;
    request.userId = 'raw-user';
    expect(validateAgentWebZ0BridgeRequestV1(request, 1_000))
      .toBe('unknown top-level fields: userId');

    const nested = baseRequest() as any;
    nested.capability.surprise = true;
    expect(validateAgentWebZ0BridgeRequestV1(nested, 1_000))
      .toBe('unknown capability fields: surprise');
  });

  it('rejects trace mutation', () => {
    const request = baseRequest();
    request.trace_id = '0'.repeat(64);
    expect(validateAgentWebZ0BridgeRequestV1(request, 1_000))
      .toBe('trace_id does not match parent_agent + operation_id');
  });

  it('rejects expired requests before any bridge call', () => {
    const request = baseRequest();
    request.deadline_unix_ms = 999;
    expect(validateAgentWebZ0BridgeRequestV1(request, 1_000)).toBe('deadline_expired');
  });

  it('rejects raw identity or credentials nested in state', () => {
    for (const key of ['userId', 'session_id', 'api_key', 'accessToken', 'credentials']) {
      const request = baseRequest();
      request.capability.state = { nested: { [key]: 'must-not-cross' } };
      expect(validateAgentWebZ0BridgeRequestV1(request, 1_000)).toMatch(/^forbidden /);
    }
  });

  it('requires prior approval for active side effects', () => {
    const request = baseRequest();
    request.mode = 'active';
    request.policy.risk_class = 'external_side_effect';
    request.policy.approval_state = 'unknown';
    expect(validateAgentWebZ0BridgeRequestV1(request, 1_000))
      .toBe('active mutation/external side effect requires approval_state=granted');

    request.policy.approval_state = 'granted';
    expect(validateAgentWebZ0BridgeRequestV1(request, 1_000)).toBeNull();
  });

  it('checks provenance digests', () => {
    const request = baseRequest();
    request.evidence![0].sha256 = '0'.repeat(64);
    expect(validateAgentWebZ0BridgeRequestV1(request, 1_000))
      .toBe('evidence sha256 does not match content');
  });

  it('requires timezone-qualified evidence timestamps', () => {
    const request = baseRequest();
    request.evidence![0].retrieved_at = '2026-10-01T06:00:00';
    expect(validateAgentWebZ0BridgeRequestV1(request, 1_000))
      .toBe('invalid evidence retrieved_at');
  });
});
