import { normalizeReliabilityReceipt } from '../experiments/reliabilityReceiptExperiment';
import type { ReliabilityEvent, ReliabilityOutcome } from '../services/reliabilityEvent';

function event(outcome: ReliabilityOutcome): ReliabilityEvent {
  return {
    at: '2026-09-29T18:00:00.000Z',
    tool: 'demo_tool',
    outcome,
    latencyMs: 12,
  };
}

describe('A3 reliability receipt experiment', () => {
  it.each([
    ['success', 'succeeded'],
    ['error', 'failed'],
    ['timeout', 'failed'],
    ['blocked', 'blocked'],
    ['user_refused', 'blocked'],
    ['pending_confirmation', 'deferred'],
    ['skipped', 'not_attempted'],
  ] as const)('maps %s without inventing evidence', (outcome, status) => {
    expect(normalizeReliabilityReceipt(event(outcome))).toMatchObject({
      status,
      evidence: 'event',
    });
  });

  it('keeps missing evidence unknown', () => {
    expect(normalizeReliabilityReceipt(null)).toEqual({
      status: 'unknown',
      evidence: 'unknown',
    });
  });
});
