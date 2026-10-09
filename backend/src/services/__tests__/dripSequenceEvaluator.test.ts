import { nextSequenceAction, SequenceDefinition, SequenceEvent } from '../dripSequenceEvaluator';

const H = 3_600_000;
const def: SequenceDefinition = {
  steps: [{ delayMs: 0 }, { delayMs: 24 * H }, { delayMs: 48 * H }],
  quietWindowMs: 72 * H,
};
const T0 = 1_000_000;
const enr = { enrolledAt: T0 };

describe('nextSequenceAction (ENG-2368)', () => {
  describe('AC1: ordered steps and delays', () => {
    it('step 0 is due at enrollment + its delay', () => {
      const d = { ...def, steps: [{ delayMs: 2 * H }, ...def.steps.slice(1)] };
      expect(nextSequenceAction(d, enr, [], T0 + H)).toEqual({ type: 'wait', until: T0 + 2 * H });
      expect(nextSequenceAction(d, enr, [], T0 + 2 * H)).toEqual({ type: 'send', stepIndex: 0, dueAt: T0 + 2 * H });
    });

    it('step N+1 is not due before lastSentAt(N) + delay(N+1)', () => {
      const events: SequenceEvent[] = [{ type: 'sent', stepIndex: 0, at: T0 + 5 }];
      expect(nextSequenceAction(def, enr, events, T0 + 24 * H)).toEqual({ type: 'wait', until: T0 + 5 + 24 * H });
    });

    it('exactly-at-due boundary yields send', () => {
      const events: SequenceEvent[] = [{ type: 'sent', stepIndex: 0, at: T0 }];
      expect(nextSequenceAction(def, enr, events, T0 + 24 * H)).toEqual({ type: 'send', stepIndex: 1, dueAt: T0 + 24 * H });
      expect(nextSequenceAction(def, enr, events, T0 + 24 * H - 1)).toEqual({ type: 'wait', until: T0 + 24 * H });
    });

    it('never skips an unsent earlier step', () => {
      const events: SequenceEvent[] = [{ type: 'sent', stepIndex: 1, at: T0 }];
      expect(nextSequenceAction(def, enr, events, T0 + 100 * H)).toMatchObject({ type: 'send', stepIndex: 0 });
    });
  });

  describe('AC2: stop conditions', () => {
    it.each(['replied', 'booked', 'unsubscribed', 'bounced'] as const)('%s stops and beats a due send', (reason) => {
      const events: SequenceEvent[] = [{ type: 'sent', stepIndex: 0, at: T0 }, { type: reason, at: T0 + H }];
      expect(nextSequenceAction(def, enr, events, T0 + 30 * H)).toEqual({ type: 'stop', reason });
    });

    it('stop event exactly at now counts; a future one does not', () => {
      const events: SequenceEvent[] = [{ type: 'replied', at: T0 + 10 }];
      expect(nextSequenceAction(def, enr, events, T0 + 10)).toEqual({ type: 'stop', reason: 'replied' });
      expect(nextSequenceAction(def, enr, events, T0 + 9)).toEqual({ type: 'send', stepIndex: 0, dueAt: T0 });
    });

    it('out-of-order events: earliest stop wins regardless of array order', () => {
      const events: SequenceEvent[] = [
        { type: 'unsubscribed', at: T0 + 5 * H },
        { type: 'sent', stepIndex: 0, at: T0 },
        { type: 'booked', at: T0 + 2 * H },
      ];
      expect(nextSequenceAction(def, enr, events, T0 + 6 * H)).toEqual({ type: 'stop', reason: 'booked' });
    });
  });

  describe('AC3: completion after quiet window', () => {
    const allSent: SequenceEvent[] = [
      { type: 'sent', stepIndex: 2, at: T0 + 72 * H },
      { type: 'sent', stepIndex: 0, at: T0 },
      { type: 'sent', stepIndex: 1, at: T0 + 24 * H },
    ];
    it('waits until last send + quiet window', () => {
      expect(nextSequenceAction(def, enr, allSent, T0 + 100 * H)).toEqual({ type: 'wait', until: T0 + 144 * H });
    });
    it('completes exactly at the quiet-window boundary', () => {
      expect(nextSequenceAction(def, enr, allSent, T0 + 144 * H)).toEqual({ type: 'complete', outcome: 'no_response' });
    });
    it('a stop inside the quiet window prevents completion', () => {
      const ev = [...allSent, { type: 'replied' as const, at: T0 + 140 * H }];
      expect(nextSequenceAction(def, enr, ev, T0 + 200 * H)).toEqual({ type: 'stop', reason: 'replied' });
    });
  });

  describe('AC4: idempotency', () => {
    it('a send stamped after `now` (clock skew) still dedups its step', () => {
      const now = T0 + 10;
      const events: SequenceEvent[] = [{ type: 'sent', stepIndex: 0, at: now + 1 }];
      expect(nextSequenceAction(def, enr, events, now)).toEqual({ type: 'wait', until: now + 1 + 24 * H });
    });

    it('a recorded send for step N never yields send for N again', () => {
      const events: SequenceEvent[] = [
        { type: 'sent', stepIndex: 0, at: T0 },
        { type: 'sent', stepIndex: 0, at: T0 + 30 * H },
      ];
      const action = nextSequenceAction(def, enr, events, T0 + 30 * H);
      expect(action).toEqual({ type: 'send', stepIndex: 1, dueAt: T0 + 24 * H });
    });
  });
});
