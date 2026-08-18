/**
 * ENG-1312 criterion 4: the reliability-trend snapshot must surface the new
 * judge dimensions (concision, instructionCompliance, unnecessaryPermissionRequest)
 * so a fleet-wide regression is visible in the daily trend, not just per-session.
 *
 * `computeReliabilitySnapshot` gains an optional `satisfactionSamples` input —
 * pure, same as every other metric in this file — computed from ChatSession
 * satisfaction/judge dimension scores by the caller (the cron). Omitting the
 * input keeps every existing snapshot consumer unaffected (new fields simply
 * default to zero-with-zero-count, mirroring toolSuccessRate/runCount's
 * existing "0 when no denominator" convention in this same file).
 */
import { computeReliabilitySnapshot } from '../cron/agentReliabilitySnapshot';

const NOW = new Date('2026-06-14T18:00:00Z');
const start = new Date('2026-06-13T18:00:00Z');

describe('computeReliabilitySnapshot — satisfaction dimension aggregation (ENG-1312)', () => {
  // FAIL tests ---------------------------------------------------------------

  it('defaults to zero-with-zero-count when no satisfactionSamples are provided (backward compatible)', () => {
    const snap = computeReliabilitySnapshot({
      events: [],
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
    });
    expect(snap.satisfactionDimensionSampleCount).toBe(0);
    expect(snap.concisionAvg).toBe(0);
    expect(snap.instructionComplianceAvg).toBe(0);
    expect(snap.unnecessaryPermissionRequestRate).toBe(0);
  });

  it('ignores samples outside the window', () => {
    const snap = computeReliabilitySnapshot({
      events: [],
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
      satisfactionSamples: [
        { ts: new Date('2026-06-10T00:00:00Z'), concision: 1 }, // before window
      ],
    });
    expect(snap.satisfactionDimensionSampleCount).toBe(0);
    expect(snap.concisionAvg).toBe(0);
  });

  it('a sample missing instructionCompliance does not drag the average down (excluded from that average, not treated as 0)', () => {
    const snap = computeReliabilitySnapshot({
      events: [],
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
      satisfactionSamples: [
        { ts: new Date('2026-06-14T01:00:00Z'), concision: 5, instructionCompliance: 5 },
        { ts: new Date('2026-06-14T02:00:00Z'), concision: 5 }, // no instructionCompliance
      ],
    });
    expect(snap.instructionComplianceAvg).toBe(5); // only the one real sample counted
    expect(snap.concisionAvg).toBe(5);
  });

  // SUCCESS tests --------------------------------------------------------------

  it('averages concision and instructionCompliance over in-window samples', () => {
    const snap = computeReliabilitySnapshot({
      events: [],
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
      satisfactionSamples: [
        { ts: new Date('2026-06-14T01:00:00Z'), concision: 2, instructionCompliance: 1 },
        { ts: new Date('2026-06-14T02:00:00Z'), concision: 4, instructionCompliance: 5 },
      ],
    });
    expect(snap.concisionAvg).toBeCloseTo(3, 6); // (2+4)/2
    expect(snap.instructionComplianceAvg).toBeCloseTo(3, 6); // (1+5)/2
    expect(snap.satisfactionDimensionSampleCount).toBe(2);
  });

  it('computes unnecessaryPermissionRequestRate as a fraction of samples that carry the field', () => {
    const snap = computeReliabilitySnapshot({
      events: [],
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
      satisfactionSamples: [
        { ts: new Date('2026-06-14T01:00:00Z'), unnecessaryPermissionRequest: true },
        { ts: new Date('2026-06-14T02:00:00Z'), unnecessaryPermissionRequest: true },
        { ts: new Date('2026-06-14T03:00:00Z'), unnecessaryPermissionRequest: false },
        { ts: new Date('2026-06-14T04:00:00Z') }, // unknown — excluded from the denominator
      ],
    });
    expect(snap.unnecessaryPermissionRequestRate).toBeCloseTo(2 / 3, 6);
    expect(snap.satisfactionDimensionSampleCount).toBe(4); // still counted as a sample in-window
  });

  it('a fleet-wide 2x verbosity regression (concision cratering) is visible in one snapshot', () => {
    const goodDay = computeReliabilitySnapshot({
      events: [],
      date: '2026-06-13',
      windowStart: new Date('2026-06-12T18:00:00Z'),
      windowEnd: new Date('2026-06-13T18:00:00Z'),
      windowLabel: '24h',
      now: NOW,
      satisfactionSamples: Array.from({ length: 10 }, (_, i) => ({
        ts: new Date(`2026-06-13T0${i % 9}:00:00Z`),
        concision: 5,
      })),
    });
    const regressedDay = computeReliabilitySnapshot({
      events: [],
      date: '2026-06-14',
      windowStart: start,
      windowEnd: NOW,
      windowLabel: '24h',
      now: NOW,
      satisfactionSamples: Array.from({ length: 10 }, (_, i) => ({
        ts: new Date(`2026-06-14T0${i % 9}:00:00Z`),
        concision: 1,
      })),
    });
    expect(goodDay.concisionAvg).toBe(5);
    expect(regressedDay.concisionAvg).toBe(1);
    expect(goodDay.concisionAvg).toBeGreaterThan(regressedDay.concisionAvg);
  });
});
