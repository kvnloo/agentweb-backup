import { resolveScheduledPublishAt } from '../resolveScheduledPublishAt';
import { validateScheduledPostRequest } from '../validateScheduledPostRequest';

const LA = 'America/Los_Angeles';

function at(localDateTime: string, timeZone: string) {
  return resolveScheduledPublishAt({ localDateTime, timeZone });
}

describe('resolveScheduledPublishAt (ENG-2748)', () => {
  it.each([
    ['2026-03-07T09:00', LA, '2026-03-07T09:00:00-08:00'], // before spring-forward (PST)
    ['2026-03-09T09:00', LA, '2026-03-09T09:00:00-07:00'], // after spring-forward (PDT)
    ['2026-10-31T09:00', LA, '2026-10-31T09:00:00-07:00'], // before fall-back (PDT)
    ['2026-11-03T09:00:30', LA, '2026-11-03T09:00:30-08:00'], // after fall-back (PST)
    ['2026-07-04T18:15', 'Asia/Kolkata', '2026-07-04T18:15:00+05:30'],
    ['2026-01-04T18:15', 'Asia/Kolkata', '2026-01-04T18:15:00+05:30'],
    ['2026-01-04T18:15', 'UTC', '2026-01-04T18:15:00+00:00'],
  ])('%s in %s -> %s', (local, zone, expected) => {
    expect(at(local, zone)).toEqual({ ok: true, publishAt: expected });
  });

  it('rejects a nonexistent spring-forward local time', () => {
    expect(at('2026-03-08T02:30', LA)).toEqual({ ok: false, code: 'LOCAL_TIME_NONEXISTENT' });
  });

  it('resolves an ambiguous fall-back local time to the earlier instant (PDT)', () => {
    expect(at('2026-11-01T01:30', LA)).toEqual({ ok: true, publishAt: '2026-11-01T01:30:00-07:00' });
  });

  it.each(['Mars/Olympus', '', 'not a zone'])('rejects invalid zone %p', (zone) => {
    expect(at('2026-11-03T09:00', zone)).toEqual({ ok: false, code: 'TIMEZONE_INVALID' });
  });

  it.each(['2026-11-03', '2026-13-03T09:00', '2026-02-30T09:00', '2026-11-03T24:00', 'tomorrow 9am', ''])(
    'rejects malformed local datetime %p',
    (local) => {
      expect(at(local, LA)).toEqual({ ok: false, code: 'LOCAL_DATETIME_INVALID' });
    },
  );

  it.each(['2026-11-03T09:00:00Z', '2026-11-03T09:00:00+05:30'])('passes through %p unchanged', (iso) => {
    expect(at(iso, LA)).toEqual({ ok: true, publishAt: iso });
  });

  it('never throws on non-string input', () => {
    expect(resolveScheduledPublishAt({ localDateTime: 42 as unknown as string, timeZone: LA })).toEqual({
      ok: false,
      code: 'LOCAL_DATETIME_INVALID',
    });
    expect(resolveScheduledPublishAt(undefined as unknown as { localDateTime: string; timeZone: string })).toEqual({
      ok: false,
      code: 'LOCAL_DATETIME_INVALID',
    });
  });

  it('output round-trips through validateScheduledPostRequest', () => {
    const r = at('2026-11-03T09:00', LA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = validateScheduledPostRequest(
      { platform: 'x', content: 'hello', publishAt: r.publishAt },
      () => new Date('2026-10-29T12:00:00Z'),
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value.publishAt.toISOString()).toBe('2026-11-03T17:00:00.000Z');
  });
});
