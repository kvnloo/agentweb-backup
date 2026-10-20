import { previewSequenceSchedule } from '../dripSequenceSchedulePreview';

const weekdays9to17 = { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] };

describe('previewSequenceSchedule (ENG-2562)', () => {
  it('returns an empty schedule for no steps', () => {
    const r = previewSequenceSchedule({ enrolledAt: new Date('2026-10-19T12:00:00Z'), steps: [], fallbackTimezone: 'UTC' });
    expect(r).toEqual({ ok: true, steps: [], timezone: null, usedFallback: false });
  });

  it('chains delays cumulatively without a window', () => {
    const r = previewSequenceSchedule({
      enrolledAt: new Date('2026-10-19T12:00:00Z'),
      steps: [{ delayMinutes: 0 }, { delayMinutes: 60 }, { delayMinutes: 1440 }],
      fallbackTimezone: 'UTC',
    });
    if (!r.ok) throw new Error('expected ok');
    expect(r.steps.map((s) => s.sendAt.toISOString())).toEqual([
      '2026-10-19T12:00:00.000Z',
      '2026-10-19T13:00:00.000Z',
      '2026-10-20T13:00:00.000Z',
    ]);
    expect(r.steps.every((s) => s.deferredMinutes === 0)).toBe(true);
  });

  it('snaps into the window and chains from the actual send time', () => {
    // Fri 2026-10-23 18:00 UTC is after hours -> Mon 09:00; next step +60m from Mon 09:00.
    const r = previewSequenceSchedule({
      enrolledAt: new Date('2026-10-23T18:00:00Z'),
      steps: [{ delayMinutes: 0 }, { delayMinutes: 60 }],
      window: weekdays9to17,
      recipientTimezone: 'UTC',
      fallbackTimezone: 'UTC',
    });
    if (!r.ok) throw new Error('expected ok');
    expect(r.steps[0].sendAt.toISOString()).toBe('2026-10-26T09:00:00.000Z');
    expect(r.steps[0].deferredMinutes).toBe(63 * 60);
    expect(r.steps[1].dueAt.toISOString()).toBe('2026-10-26T10:00:00.000Z');
    expect(r.steps[1].deferredMinutes).toBe(0);
    expect(r).toMatchObject({ timezone: 'UTC', usedFallback: false });
  });

  it('reports fallback timezone use', () => {
    const r = previewSequenceSchedule({
      enrolledAt: new Date('2026-10-19T16:00:00Z'),
      steps: [{ delayMinutes: 0 }],
      window: weekdays9to17,
      recipientTimezone: 'Not/AZone',
      fallbackTimezone: 'America/Los_Angeles',
    });
    expect(r).toMatchObject({ ok: true, timezone: 'America/Los_Angeles', usedFallback: true });
  });

  it.each([[-1], [1.5], [Number.NaN]])('rejects invalid delay %p with stepIndex', (d) => {
    const r = previewSequenceSchedule({
      enrolledAt: new Date('2026-10-19T12:00:00Z'),
      steps: [{ delayMinutes: 0 }, { delayMinutes: d }],
      fallbackTimezone: 'UTC',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_delay', stepIndex: 1 } });
  });

  it('rejects an invalid enrolledAt', () => {
    const r = previewSequenceSchedule({ enrolledAt: new Date('nope'), steps: [{ delayMinutes: 0 }], fallbackTimezone: 'UTC' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_enrolled_at' } });
  });

  it('surfaces window errors with stepIndex instead of throwing', () => {
    const r = previewSequenceSchedule({
      enrolledAt: new Date('2026-10-19T12:00:00Z'),
      steps: [{ delayMinutes: 0 }],
      window: { startHour: 9, endHour: 17, days: [] },
      fallbackTimezone: 'UTC',
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'empty_days', stepIndex: 0 } });
  });
});
