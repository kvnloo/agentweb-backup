/**
 * ENG-2542 (child of ENG-2167): pure drip-sequence health auto-pause decision.
 *
 * Given a sequence's send outcome counts, decide whether the sequence should keep
 * sending or be paused to protect sender reputation. No I/O, no clock reads, no wiring.
 */

export interface SequenceHealthCounts {
  sent: number;
  bounced: number;
  complained: number;
}

export interface SequenceHealthThresholds {
  /** Pause when bounced/sent is strictly greater than this fraction. */
  maxBounceRate: number;
  /** Pause when complained/sent is strictly greater than this fraction. */
  maxComplaintRate: number;
  /** No pause decision until at least this many sends. */
  minSample: number;
}

export type SequenceHealthReason = 'bounce_rate' | 'complaint_rate';

export type SequenceHealthDecision =
  | { action: 'continue'; bounceRate: number | null; complaintRate: number | null }
  | {
      action: 'pause';
      reasons: SequenceHealthReason[];
      bounceRate: number;
      complaintRate: number;
    };

export const DEFAULT_SEQUENCE_HEALTH_THRESHOLDS: SequenceHealthThresholds = {
  maxBounceRate: 0.05,
  maxComplaintRate: 0.003,
  minSample: 50,
};

function assertCount(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function assertRate(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${name} must be a fraction between 0 and 1`);
  }
}

export function decideSequenceHealth(
  counts: SequenceHealthCounts,
  overrides: Partial<SequenceHealthThresholds> = {},
): SequenceHealthDecision {
  const t: SequenceHealthThresholds = { ...DEFAULT_SEQUENCE_HEALTH_THRESHOLDS, ...overrides };
  assertCount('sent', counts.sent);
  assertCount('bounced', counts.bounced);
  assertCount('complained', counts.complained);
  if (counts.bounced > counts.sent) throw new RangeError('bounced cannot exceed sent');
  if (counts.complained > counts.sent) throw new RangeError('complained cannot exceed sent');
  assertRate('maxBounceRate', t.maxBounceRate);
  assertRate('maxComplaintRate', t.maxComplaintRate);
  assertCount('minSample', t.minSample);

  if (counts.sent === 0) return { action: 'continue', bounceRate: null, complaintRate: null };

  const bounceRate = counts.bounced / counts.sent;
  const complaintRate = counts.complained / counts.sent;
  if (counts.sent < t.minSample) return { action: 'continue', bounceRate, complaintRate };

  const reasons: SequenceHealthReason[] = [];
  if (bounceRate > t.maxBounceRate) reasons.push('bounce_rate');
  if (complaintRate > t.maxComplaintRate) reasons.push('complaint_rate');
  if (reasons.length === 0) return { action: 'continue', bounceRate, complaintRate };
  return { action: 'pause', reasons, bounceRate, complaintRate };
}
