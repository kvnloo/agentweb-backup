import { selectDuePosts, transition, ScheduledPostRecord, MAX_ATTEMPTS, retryBackoffMs } from '../scheduledPostLifecycle';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const base = (over: Partial<ScheduledPostRecord> = {}): ScheduledPostRecord => ({
  id: 'p', status: 'pending', publishAt: new Date(NOW.getTime() - 1000), content: 'hi', mediaUrls: [], ...over,
});
const fail = (retryable: boolean) => ({ type: 'markAttemptFailed' as const, now: NOW, error: 'boom', retryable });

describe('markAttemptFailed (ENG-2519)', () => {
  it('reschedules a retryable failure within budget with exponential backoff', () => {
    expect(MAX_ATTEMPTS).toBe(3);
    const r1 = transition(base(), fail(true));
    expect(r1).toMatchObject({ ok: true, changed: true, record: { status: 'pending', attempts: 1, lastError: 'boom' } });
    if (!r1.ok) throw new Error();
    expect(r1.record.publishAt.getTime()).toBe(NOW.getTime() + 60_000);
    const r2 = transition(r1.record, fail(true));
    if (!r2.ok) throw new Error();
    expect(r2.record).toMatchObject({ status: 'pending', attempts: 2 });
    expect(r2.record.publishAt.getTime()).toBe(NOW.getTime() + 5 * 60_000);
    expect(retryBackoffMs(3)).toBe(25 * 60_000);
  });

  it('moves to failed once the attempt budget is exhausted', () => {
    const r = transition(base({ attempts: 2 }), fail(true));
    expect(r).toMatchObject({ ok: true, record: { status: 'failed', attempts: 3, lastError: 'boom', failedAt: NOW } });
  });

  it('moves to failed immediately on a non-retryable error', () => {
    expect(transition(base(), fail(false))).toMatchObject({ ok: true, record: { status: 'failed', attempts: 1 } });
  });

  it('rejects markAttemptFailed on non-pending records', () => {
    expect(transition(base({ status: 'fired' }), fail(true))).toMatchObject({ ok: false, code: 'NOT_PENDING' });
  });

  it('does not mutate the input record', () => {
    const input = base();
    const snap = { ...input, publishAt: new Date(input.publishAt) };
    transition(input, fail(true));
    expect(input).toEqual(snap);
  });

  it('excludes failed records from due selection and blocks edit/cancel', () => {
    const failed = base({ status: 'failed', attempts: 3 });
    expect(selectDuePosts([failed, base({ id: 'q' })], NOW).map((r) => r.id)).toEqual(['q']);
    expect(transition(failed, { type: 'cancel', now: NOW })).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    expect(transition(failed, { type: 'edit', now: NOW, changes: { content: 'x' } })).toMatchObject({ ok: false, code: 'NOT_PENDING' });
  });
});
