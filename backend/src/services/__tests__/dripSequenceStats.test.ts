import { aggregateSequenceStats, SequenceStatsEvent } from '../dripSequenceStats';

const def = { steps: [{ delayMs: 0 }, { delayMs: 86_400_000 }] };
const ev = (
  enrollmentId: string,
  stepIndex: number,
  type: SequenceStatsEvent['type'],
  isHuman?: boolean,
): SequenceStatsEvent => ({ enrollmentId, stepIndex, type, at: '2026-10-18T10:00:00Z', isHuman });

describe('aggregateSequenceStats (ENG-2540)', () => {
  it('dedupes opens/clicks per (enrollment, step): 5 opens by one lead count as 1', () => {
    const events = [
      ev('a', 0, 'sent'),
      ev('a', 0, 'delivered'),
      ...Array.from({ length: 5 }, () => ev('a', 0, 'opened')),
      ev('a', 0, 'clicked'),
      ev('a', 0, 'clicked'),
      ev('a', 1, 'opened'),
    ];
    const s = aggregateSequenceStats(def, events);
    expect(s.steps[0].counts.opened).toBe(1);
    expect(s.steps[0].counts.clicked).toBe(1);
    expect(s.steps[1].counts.opened).toBe(1);
    expect(s.total.counts.opened).toBe(2);
    expect(s.steps[0].rates.openRate).toBe(1);
  });

  it('excludes bot opens/clicks (isHuman === false) and keeps undefined as human', () => {
    const s = aggregateSequenceStats(def, [
      ev('a', 0, 'delivered'),
      ev('b', 0, 'delivered'),
      ev('a', 0, 'opened', false),
      ev('a', 0, 'clicked', false),
      ev('b', 0, 'opened'),
    ]);
    expect(s.steps[0].counts.opened).toBe(1);
    expect(s.steps[0].counts.clicked).toBe(0);
    expect(s.steps[0].rates.openRate).toBe(0.5);
  });

  it('a bot open does not consume the dedupe slot for a later human open', () => {
    const s = aggregateSequenceStats(def, [ev('a', 0, 'opened', false), ev('a', 0, 'opened', true)]);
    expect(s.steps[0].counts.opened).toBe(1);
  });

  it('returns null rates (not NaN/Infinity) on zero denominators; falls back to sent', () => {
    const empty = aggregateSequenceStats(def, []);
    expect(Object.values(empty.steps[1].rates).every((r) => r === null)).toBe(true);
    expect(Object.values(empty.total.rates).every((r) => r === null)).toBe(true);

    const sentOnly = aggregateSequenceStats(def, [ev('a', 0, 'sent'), ev('b', 0, 'sent'), ev('a', 0, 'replied')]);
    expect(sentOnly.steps[0].rates.replyRate).toBe(0.5);
    expect(sentOnly.steps[0].rates.deliveryRate).toBe(0);
  });

  it('counts events for unknown steps as orphanEvents', () => {
    const s = aggregateSequenceStats(def, [ev('a', 2, 'sent'), ev('a', -1, 'opened'), ev('a', 0.5, 'sent'), ev('a', 0, 'sent')]);
    expect(s.orphanEvents).toBe(3);
    expect(s.total.counts.sent).toBe(1);
  });

  it('counts every type per step and in total', () => {
    const types: SequenceStatsEvent['type'][] = ['sent', 'delivered', 'opened', 'clicked', 'replied', 'unsubscribed', 'bounced', 'complained'];
    const s = aggregateSequenceStats(def, [...types.map((t) => ev('a', 0, t)), ...types.map((t) => ev('b', 1, t))]);
    for (const t of types) {
      expect(s.steps[0].counts[t]).toBe(1);
      expect(s.steps[1].counts[t]).toBe(1);
      expect(s.total.counts[t]).toBe(2);
    }
  });

  it('is independent of input order', () => {
    const events = [
      ev('a', 0, 'sent'), ev('a', 0, 'delivered'), ev('a', 0, 'opened', false), ev('a', 0, 'opened'),
      ev('b', 0, 'sent'), ev('b', 0, 'bounced'), ev('a', 1, 'sent'), ev('a', 1, 'clicked'),
      ev('a', 1, 'clicked'), ev('c', 7, 'sent'), ev('a', 1, 'replied'),
    ];
    const base = aggregateSequenceStats(def, events);
    expect(aggregateSequenceStats(def, [...events].reverse())).toEqual(base);
    const rotated = [...events.slice(5), ...events.slice(0, 5)];
    expect(aggregateSequenceStats(def, rotated)).toEqual(base);
  });
});
