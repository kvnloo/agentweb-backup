import {
  cancelScheduledPost,
  createScheduledPost,
  editScheduledPost,
  listScheduledPosts,
  OwnedScheduledPost,
  ScheduledPostCommandDeps,
  ScheduledPostCommandRepository,
} from '../scheduledPostCommands';

const NOW = new Date('2026-11-01T12:00:00Z');

function fakeRepo(): ScheduledPostCommandRepository & { rows: Map<string, OwnedScheduledPost> } {
  const rows = new Map<string, OwnedScheduledPost>();
  return {
    rows,
    async listPending(now: Date) {
      return [...rows.values()].filter((r) => r.status === 'pending' && r.publishAt <= now);
    },
    async get(id: string) {
      return rows.get(id);
    },
    async save(record: OwnedScheduledPost) {
      rows.set(record.id, record);
    },
    async saveIfUnchanged(record: OwnedScheduledPost, expected: { status: OwnedScheduledPost['status']; updatedAt?: Date }) {
      const cur = rows.get(record.id);
      if (!cur || cur.status !== expected.status || cur.updatedAt?.getTime() !== expected.updatedAt?.getTime()) return false;
      rows.set(record.id, record);
      return true;
    },
    async listByUser(userId: string) {
      return [...rows.values()].filter((r) => r.userId === userId);
    },
  };
}

function depsFor(repo: ScheduledPostCommandRepository, userId: string, now = NOW): ScheduledPostCommandDeps {
  let n = 0;
  return { repo, userId, now: () => now, newId: () => `${userId}-post-${++n}` };
}

const validInput = {
  platform: 'linkedin',
  publishAt: '2026-11-02T09:00:00Z',
  content: 'Launch day post',
  mediaUrls: [],
};

describe('scheduledPostCommands', () => {
  it('create stores a pending owned record; list shows it; edit and cancel apply', async () => {
    const repo = fakeRepo();
    const deps = depsFor(repo, 'u1');
    const created = await createScheduledPost(deps, validInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toMatchObject({ status: 'pending', userId: 'u1', platform: 'linkedin' });
    expect(repo.rows.get(created.value.id)).toEqual(created.value);

    const list = await listScheduledPosts(deps, { timeZone: 'UTC' });
    expect(list.empty).toBe(false);
    expect(list.text).toContain('Launch day post');

    const edited = await editScheduledPost(deps, created.value.id, { content: 'Edited' });
    expect(edited.ok && edited.value.content).toBe('Edited');
    expect(repo.rows.get(created.value.id)?.content).toBe('Edited');

    const cancelled = await cancelScheduledPost(deps, created.value.id);
    expect(cancelled.ok && cancelled.value.status).toBe('cancelled');
    expect(repo.rows.get(created.value.id)?.status).toBe('cancelled');
  });

  it('create returns a typed validation error and stores nothing', async () => {
    const repo = fakeRepo();
    const result = await createScheduledPost(depsFor(repo, 'u1'), { ...validInput, publishAt: '2020-01-01T00:00:00Z' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('VALIDATION_FAILED');
    expect(result.errors?.[0].code).toBe('PUBLISH_AT_NOT_FUTURE');
    expect(repo.rows.size).toBe(0);
    await expect(createScheduledPost(depsFor(repo, 'u1'), null)).resolves.toMatchObject({ ok: false });
  });

  it('denies cross-user edit/cancel as NOT_FOUND and scopes list to the caller', async () => {
    const repo = fakeRepo();
    const owner = await createScheduledPost(depsFor(repo, 'u1'), validInput);
    if (!owner.ok) throw new Error('setup');
    const other = depsFor(repo, 'u2');
    expect(await editScheduledPost(other, owner.value.id, { content: 'hijack' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await cancelScheduledPost(other, owner.value.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(repo.rows.get(owner.value.id)).toMatchObject({ status: 'pending', content: 'Launch day post' });
    expect((await listScheduledPosts(other, { timeZone: 'UTC' })).empty).toBe(true);
  });

  it('cancel after fired returns NOT_PENDING without mutating', async () => {
    const repo = fakeRepo();
    const deps = depsFor(repo, 'u1');
    const created = await createScheduledPost(deps, validInput);
    if (!created.ok) throw new Error('setup');
    const fired = { ...created.value, status: 'fired' as const, firedAt: NOW };
    repo.rows.set(fired.id, fired);
    expect(await cancelScheduledPost(deps, fired.id)).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    expect(await editScheduledPost(deps, fired.id, { content: 'x' })).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    expect(repo.rows.get(fired.id)).toBe(fired);
  });

  it('returns NOT_FOUND for an unknown id', async () => {
    expect(await cancelScheduledPost(depsFor(fakeRepo(), 'u1'), 'missing')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('edit rejects invalid values with VALIDATION_FAILED and does not save', async () => {
    const repo = fakeRepo();
    const deps = depsFor(repo, 'u1');
    const created = await createScheduledPost(deps, validInput);
    if (!created.ok) throw new Error('setup');
    for (const bad of [{ content: '   ' }, { publishAt: new Date('nope') }, { publishAt: new Date('2020-01-01T00:00:00Z') }]) {
      expect(await editScheduledPost(deps, created.value.id, bad)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    const ig = await createScheduledPost(deps, { ...validInput, platform: 'instagram', mediaUrls: ['https://x.test/a.png'] });
    if (!ig.ok) throw new Error('setup');
    expect(await editScheduledPost(deps, ig.value.id, { mediaUrls: [] })).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(repo.rows.get(created.value.id)).toEqual(created.value);
  });

  it('edit ignores non-editable fields such as status', async () => {
    const repo = fakeRepo();
    const deps = depsFor(repo, 'u1');
    const created = await createScheduledPost(deps, validInput);
    if (!created.ok) throw new Error('setup');
    const sneaky = { content: 'updated', status: 'fired' } as unknown as { content: string };
    const edited = await editScheduledPost(deps, created.value.id, sneaky);
    expect(edited).toMatchObject({ ok: true, value: { content: 'updated', status: 'pending' } });
    expect(repo.rows.get(created.value.id)?.status).toBe('pending');
  });

  it('a stale edit cannot overwrite a concurrent cancel (CONFLICT)', async () => {
    const repo = fakeRepo();
    const deps = depsFor(repo, 'u1');
    const created = await createScheduledPost(deps, validInput);
    if (!created.ok) throw new Error('setup');
    const realGet = repo.get.bind(repo);
    // Edit reads the pending row, then a cancel lands before the edit writes.
    let raced = false;
    repo.get = async (id: string) => {
      const row = await realGet(id);
      if (!raced) {
        raced = true;
        repo.rows.set(id, { ...row!, status: 'cancelled', cancelledAt: NOW, updatedAt: new Date(NOW.getTime() + 1) });
      }
      return row;
    };
    expect(await editScheduledPost(deps, created.value.id, { content: 'late edit' })).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(repo.rows.get(created.value.id)?.status).toBe('cancelled');
  });
});
