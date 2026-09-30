import { buildReliabilityEvent } from '../services/reliabilityEvent';
import { projectReliabilityEventToZ0 } from '../services/z0ReliabilityProjection';

describe('AgentWeb reliability -> z0 observational receipts', () => {
  it('drops user identity, raw session identity, and free-form error text', () => {
    const event = buildReliabilityEvent({
      tool: 'dangerous_tool',
      outcome: 'error',
      latencyMs: 12,
      sessionId: 'raw-session-secret',
      userId: 'raw-user-secret',
      errorSummary: 'sensitive downstream error detail',
      platform: 'test',
    });

    const receipt = projectReliabilityEventToZ0(event);
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('raw-session-secret');
    expect(serialized).not.toContain('raw-user-secret');
    expect(serialized).not.toContain('sensitive downstream error detail');
    expect(receipt.session_id).toMatch(/^agentweb:[a-f0-9]{24}$/);
  });

  it('success is execution evidence, never verified-quality gold', () => {
    const receipt = projectReliabilityEventToZ0(
      buildReliabilityEvent({ tool: 'jev_decide', outcome: 'success', latencyMs: 20 }),
    ) as any;

    expect(receipt.measurement_state).toBe('partial');
    expect(receipt.outcome).toMatchObject({
      execution_completed: true,
      tool_ok: true,
      success: true,
      source: 'agentweb_reliability_event',
    });
    expect(receipt.outcome.verified_success).toBeUndefined();
    expect(receipt.outcome.verification_source).toBeUndefined();
  });

  it('pending confirmation is not represented as completed execution', () => {
    const receipt = projectReliabilityEventToZ0(
      buildReliabilityEvent({ tool: 'publish', outcome: 'pending_confirmation', latencyMs: 3 }),
    ) as any;
    expect(receipt.outcome.execution_completed).toBe(false);
    expect(receipt.outcome.tool_ok).toBe(false);
  });

  it('projection is deterministic for the same observation', () => {
    const event = buildReliabilityEvent({
      tool: 'ask_crm',
      outcome: 'success',
      latencyMs: 7,
      sessionId: 'session-a',
      at: '2026-09-29T00:00:00.000Z',
    });
    expect(projectReliabilityEventToZ0(event).trace_id).toBe(
      projectReliabilityEventToZ0(event).trace_id,
    );
  });
});
