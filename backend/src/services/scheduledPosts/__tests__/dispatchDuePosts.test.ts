import { dispatchDuePosts, ScheduledPostRepository, ScheduledPostPublisher, PublishResult } from '../dispatchDuePosts';
import { MAX_ATTEMPTS, retryBackoffMs, ScheduledPostRecord } from '../scheduledPostLifecycle';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const rec = (id: string, deltaMs: number, status: ScheduledPostRecord['status'] = 'pending'): ScheduledPostRecord => ({
  id, status, publishAt: new Date(NOW.getTime() + deltaMs), content: id, mediaUrls: [],
});

function fakeRepo(records: ScheduledPostRecord[], overrides: Record<string, ScheduledPostRecord> = {}) {
  const store = new Map(records.map((r) => [r.id, r]));
  const saves: ScheduledPostRecord[] = [];
  const repo: ScheduledPostRepository = {
    listPending: async () => [...store.values()],
    get: async (id) => overrides[id] ?? store.get(id),
    save: async (r) => { saves.push(r); store.set(r.id, r); },
  };
  return { repo, store, saves };
}

function fakePublisher(outcomes: Record<string, PublishResult | Error> = {}) {
  const calls: string[] = [];
  const keys: string[] = [];
  const publisher: ScheduledPostPublisher = {
    publish: async (r, opts) => {
      calls.push(r.id);
      keys.push(opts.idempotencyKey);
      const o = outcomes[r.id];
      if (o instanceof Error) throw o;
      return o ?? { ok: true };
    },
  };
  return { publisher, calls, keys };
}

describe('dispatchDuePosts (ENG-2520)', () => {
  it('handles a mixed batch: one failure or throw does not stop the rest', async () => {
    const { repo, store } = fakeRepo([rec('a', -30), rec('b', -20), rec('c', -10), rec('future', 60_000)]);
    const { publisher, calls } = fakePublisher({ b: { ok: false, error: 'rate limited', retryable: true }, c: new Error('network') });
    const s = await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(s.fired).toEqual(['a']);
    expect(s.failed).toEqual([]);
    expect(s.retried).toEqual(['b', 'c']);
    expect(s.errors).toEqual([{ id: 'b', error: 'rate limited' }, { id: 'c', error: 'network' }]);
    expect(store.get('a')!.status).toBe('fired');
    expect(store.get('b')!.status).toBe('pending');
  });

  it('persists retry backoff and does not republish before the next attempt is due', async () => {
    const { repo, store, saves } = fakeRepo([rec('retry', -10)]);
    const { publisher, calls, keys } = fakePublisher({ retry: { ok: false, error: 'rate limited', retryable: true } });
    const first = await dispatchDuePosts({ repo, publisher, now: NOW });
    const retryAt = new Date(NOW.getTime() + retryBackoffMs(1));
    expect(first).toEqual({ fired: [], failed: [], retried: ['retry'], skipped: [], errors: [{ id: 'retry', error: 'rate limited' }] });
    expect(store.get('retry')).toMatchObject({ status: 'pending', attempts: 1, lastError: 'rate limited', updatedAt: NOW, publishAt: retryAt });
    expect(saves).toHaveLength(1);
    const early = await dispatchDuePosts({ repo, publisher, now: new Date(retryAt.getTime() - 1) });
    expect(early).toEqual({ fired: [], failed: [], retried: [], skipped: [], errors: [] });
    expect(calls).toEqual(['retry']);
    await dispatchDuePosts({ repo, publisher, now: retryAt });
    expect(store.get('retry')).toMatchObject({ attempts: 2, publishAt: new Date(retryAt.getTime() + retryBackoffMs(2)) });
    expect(keys).toEqual(['scheduled-post:retry', 'scheduled-post:retry']);
  });

  it('persists a terminal failure when the retry budget is exhausted', async () => {
    const { repo, store, saves } = fakeRepo([{ ...rec('exhausted', -10), attempts: MAX_ATTEMPTS - 1 }]);
    const { publisher, calls } = fakePublisher({ exhausted: { ok: false, error: 'still unavailable', retryable: true } });
    const summary = await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(summary.failed).toEqual(['exhausted']);
    expect(summary.retried).toEqual([]);
    expect(summary.errors).toEqual([{ id: 'exhausted', error: 'still unavailable' }]);
    expect(store.get('exhausted')).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, lastError: 'still unavailable', failedAt: NOW, updatedAt: NOW });
    expect(saves).toHaveLength(1);
    await dispatchDuePosts({ repo, publisher, now: new Date(NOW.getTime() + retryBackoffMs(MAX_ATTEMPTS)) });
    expect(calls).toEqual(['exhausted']);
  });

  it('persists nonretryable failures immediately without scheduling another attempt', async () => {
    const { repo, store, saves } = fakeRepo([rec('permanent', -10)]);
    const { publisher } = fakePublisher({ permanent: { ok: false, error: 'invalid post', retryable: false } });
    const summary = await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(summary.failed).toEqual(['permanent']);
    expect(summary.retried).toEqual([]);
    expect(summary.errors).toEqual([{ id: 'permanent', error: 'invalid post' }]);
    expect(store.get('permanent')).toMatchObject({ status: 'failed', attempts: 1, lastError: 'invalid post', failedAt: NOW, updatedAt: NOW });
    expect(saves).toHaveLength(1);
  });

  it('converts publisher throws into persisted retryable failures without stopping later posts', async () => {
    const { repo, store } = fakeRepo([rec('throw', -30), rec('permanent', -20), rec('success', -10)]);
    const { publisher, calls } = fakePublisher({ throw: new Error('network'), permanent: { ok: false, error: 'denied', retryable: false } });
    const summary = await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(calls).toEqual(['throw', 'permanent', 'success']);
    expect(summary).toEqual({ fired: ['success'], failed: ['permanent'], retried: ['throw'], skipped: [], errors: [{ id: 'throw', error: 'network' }, { id: 'permanent', error: 'denied' }] });
    expect(store.get('throw')).toMatchObject({ status: 'pending', attempts: 1, lastError: 'network', publishAt: new Date(NOW.getTime() + retryBackoffMs(1)) });
    expect(store.get('success')).toMatchObject({ status: 'fired', firedAt: NOW });
  });

  it('reports a failed retry save as failed, not as a persisted retry, and continues', async () => {
    const { repo } = fakeRepo([rec('retry', -20), rec('success', -10)]);
    const save = repo.save;
    repo.save = async (r) => { if (r.id === 'retry') throw new Error('save failed'); await save(r); };
    const { publisher } = fakePublisher({ retry: { ok: false, error: 'rate limited', retryable: true } });
    const summary = await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(summary.retried).toEqual([]);
    expect(summary.failed).toEqual(['retry']);
    expect(summary.fired).toEqual(['success']);
    expect(summary.errors).toEqual([{ id: 'retry', error: 'save failed' }]);
  });

  it('makes no publish calls when nothing is due', async () => {
    const { repo, saves } = fakeRepo([rec('future', 60_000), rec('done', -10, 'fired')]);
    const { publisher, calls } = fakePublisher();
    const s = await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(calls).toEqual([]);
    expect(saves).toEqual([]);
    expect(s).toEqual({ fired: [], failed: [], retried: [], skipped: [], errors: [] });
  });

  it('skips a post cancelled or fired between listing and publish', async () => {
    const { repo } = fakeRepo([rec('x', -20), rec('y', -10)], { x: rec('x', -20, 'cancelled'), y: rec('y', -10, 'fired') });
    const { publisher, calls } = fakePublisher();
    const s = await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(calls).toEqual([]);
    expect(s.skipped).toEqual(['x', 'y']);
  });

  it('skips a retry moved into the future between listing and the fresh read', async () => {
    const { repo, saves } = fakeRepo([rec('retry', -10)], { retry: rec('retry', retryBackoffMs(1)) });
    const { publisher, calls } = fakePublisher();
    const summary = await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(calls).toEqual([]);
    expect(saves).toEqual([]);
    expect(summary).toEqual({ fired: [], failed: [], retried: [], skipped: ['retry'], errors: [] });
  });

  it('publishes oldest-first, exactly once each', async () => {
    const { repo, saves } = fakeRepo([rec('late', -1), rec('early', -100), rec('mid', -50)]);
    const { publisher, calls } = fakePublisher();
    await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(calls).toEqual(['early', 'mid', 'late']);
    expect(saves.map((r) => [r.id, r.status])).toEqual([['early', 'fired'], ['mid', 'fired'], ['late', 'fired']]);
  });

  it('passes a stable post-ID idempotency key so a retry after a failed save is dedupable', async () => {
    const { repo } = fakeRepo([rec('p', -10)]);
    let failSave = true;
    const origSave = repo.save;
    repo.save = async (r) => { if (failSave) { failSave = false; throw new Error('save failed'); } return origSave(r); };
    const { publisher, keys } = fakePublisher();
    const first = await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(first.failed).toEqual(['p']);
    await dispatchDuePosts({ repo, publisher, now: NOW });
    expect(keys).toEqual(['scheduled-post:p', 'scheduled-post:p']);
  });
});
