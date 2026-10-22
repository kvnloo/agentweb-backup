import { dispatchDuePosts, ScheduledPostRepository, ScheduledPostPublisher, PublishResult } from '../dispatchDuePosts';
import { ScheduledPostRecord } from '../scheduledPostLifecycle';

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
    expect(s.failed).toEqual(['b', 'c']);
    expect(s.errors).toEqual([{ id: 'b', error: 'rate limited' }, { id: 'c', error: 'network' }]);
    expect(store.get('a')!.status).toBe('fired');
    expect(store.get('b')!.status).toBe('pending');
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
