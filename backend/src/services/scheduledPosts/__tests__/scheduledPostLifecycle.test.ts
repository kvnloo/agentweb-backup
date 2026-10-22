import { selectDuePosts, transition, ScheduledPostRecord } from '../scheduledPostLifecycle';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const at = (deltaMs: number) => new Date(NOW.getTime() + deltaMs);
const rec = (id: string, deltaMs: number, status: ScheduledPostRecord['status'] = 'pending'): ScheduledPostRecord => ({
  id, status, publishAt: at(deltaMs), content: 'hi', mediaUrls: [],
});

describe('selectDuePosts (ENG-2508)', () => {
  it('includes exactly-now and 1ms-before, excludes 1ms-after', () => {
    const due = selectDuePosts([rec('after', 1), rec('now', 0), rec('before', -1)], NOW);
    expect(due.map((r) => r.id)).toEqual(['before', 'now']);
  });

  it('excludes cancelled and fired, orders by publishAt, does not mutate input', () => {
    const input = [rec('c', -10), rec('x', -50, 'fired'), rec('a', -30), rec('y', -40, 'cancelled'), rec('b', -20)];
    const snapshot = input.map((r) => r.id);
    expect(selectDuePosts(input, NOW).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(input.map((r) => r.id)).toEqual(snapshot);
  });
});

describe('transition (ENG-2508)', () => {
  it('edits a pending, not-yet-due post', () => {
    const r = transition(rec('a', 60_000), { type: 'edit', now: NOW, changes: { content: 'new' } });
    expect(r).toMatchObject({ ok: true, changed: true, record: { content: 'new', status: 'pending' } });
  });

  it('rejects edits on due posts at the boundary (exactly now) and 1ms before now', () => {
    expect(transition(rec('a', 0), { type: 'edit', now: NOW, changes: { content: 'x' } })).toMatchObject({ ok: false, code: 'ALREADY_DUE' });
    expect(transition(rec('a', -1), { type: 'edit', now: NOW, changes: { content: 'x' } })).toMatchObject({ ok: false, code: 'ALREADY_DUE' });
    expect(transition(rec('a', 1), { type: 'edit', now: NOW, changes: { content: 'x' } })).toMatchObject({ ok: true });
  });

  it('rejects an edit that moves publishAt into the past', () => {
    expect(transition(rec('a', 60_000), { type: 'edit', now: NOW, changes: { publishAt: at(0) } }))
      .toMatchObject({ ok: false, code: 'EDIT_PUBLISH_AT_NOT_FUTURE' });
  });

  it.each(['fired', 'cancelled'] as const)('rejects edit and cancel on a %s post', (status) => {
    expect(transition(rec('a', 60_000, status), { type: 'edit', now: NOW, changes: {} })).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    expect(transition(rec('a', 60_000, status), { type: 'cancel', now: NOW })).toMatchObject({ ok: false, code: 'NOT_PENDING' });
  });

  it('cancels a pending post', () => {
    expect(transition(rec('a', -5), { type: 'cancel', now: NOW })).toMatchObject({ ok: true, changed: true, record: { status: 'cancelled', cancelledAt: NOW } });
  });

  it('markFired is idempotent; second call is a no-op', () => {
    const first = transition(rec('a', 0), { type: 'markFired', now: NOW });
    expect(first).toMatchObject({ ok: true, changed: true, record: { status: 'fired', firedAt: NOW } });
    if (!first.ok) throw new Error('unreachable');
    const second = transition(first.record, { type: 'markFired', now: at(1000) });
    expect(second).toEqual({ ok: true, changed: false, record: first.record });
  });

  it('refuses to fire a cancelled post', () => {
    expect(transition(rec('a', 0, 'cancelled'), { type: 'markFired', now: NOW })).toMatchObject({ ok: false, code: 'NOT_PENDING' });
  });
});
