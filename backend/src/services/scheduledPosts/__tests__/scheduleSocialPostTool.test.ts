import {
  cancelScheduledPost,
  createScheduledPost,
  editScheduledPost,
  listScheduledPosts,
  type OwnedScheduledPost,
  type ScheduledPostCommandRepository,
} from '../scheduledPostCommands';
import {
  handleScheduleSocialPost,
  isScheduleSocialPostToolEnabled,
  scheduleSocialPostToolDefinition,
  type PublishAtResolver,
  type ScheduleSocialPostDeps,
  type ScheduledPostCommandPort,
} from '../scheduleSocialPostTool';

const NOW = new Date('2026-11-01T12:00:00.000Z');

function makeRepo(): ScheduledPostCommandRepository & { rows: Map<string, OwnedScheduledPost> } {
  const rows = new Map<string, OwnedScheduledPost>();
  return {
    rows,
    async get(id: string) { return rows.get(id); },
    async save(r: OwnedScheduledPost) { rows.set(r.id, r); },
    async listByUser(userId: string) { return [...rows.values()].filter((r) => r.userId === userId); },
    async saveIfUnchanged(r: OwnedScheduledPost, expected: { status: OwnedScheduledPost['status']; updatedAt?: Date }) {
      const cur = rows.get(r.id);
      if (!cur || cur.status !== expected.status || cur.updatedAt?.getTime() !== expected.updatedAt?.getTime()) return false;
      rows.set(r.id, r);
      return true;
    },
    async listDue() { return []; },
  } as unknown as ScheduledPostCommandRepository & { rows: Map<string, OwnedScheduledPost> };
}

// Fake ENG-2748 resolver: fixed offsets for two zones, rejects wall-clocks carrying an offset.
const OFFSETS: Record<string, string> = { 'America/Los_Angeles': '-08:00', UTC: 'Z' };
const resolvePublishAt: PublishAtResolver = (wall, tz) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(wall)) return { ok: false, code: 'WALL_CLOCK_INVALID', message: 'bad wall clock' };
  const off = OFFSETS[tz];
  if (!off) return { ok: false, code: 'TIMEZONE_UNSUPPORTED', message: 'unsupported' };
  return { ok: true, iso: `${wall}:00${off}` };
};

function setup() {
  const repo = makeRepo();
  let n = 0;
  const cmdDeps = { repo, now: () => NOW, userId: 'u1', newId: () => `p${++n}` };
  const commands: ScheduledPostCommandPort = {
    create: (input) => createScheduledPost(cmdDeps, input),
    list: (opts) => listScheduledPosts(cmdDeps, opts),
    edit: (id, changes) => editScheduledPost(cmdDeps, id, changes),
    cancel: (id) => cancelScheduledPost(cmdDeps, id),
  };
  const deps: ScheduleSocialPostDeps = { commands, resolvePublishAt };
  return { repo, deps };
}

const createArgs = {
  action: 'create',
  platform: 'linkedin',
  content: 'Launching our new feature',
  publishAt: '2026-11-03T09:30',
  timeZone: 'America/Los_Angeles',
};

describe('schedule_social_post tool (ENG-2751)', () => {
  it('flag is off by default and only "true" enables it', () => {
    expect(isScheduleSocialPostToolEnabled({})).toBe(false);
    expect(isScheduleSocialPostToolEnabled({ SCHEDULE_SOCIAL_POST_TOOL_ENABLED: '1' })).toBe(false);
    expect(isScheduleSocialPostToolEnabled({ SCHEDULE_SOCIAL_POST_TOOL_ENABLED: 'true' })).toBe(true);
  });

  it('schema exposes platform, content, media, wall-clock publishAt + timeZone', () => {
    const p = scheduleSocialPostToolDefinition.function.parameters.properties;
    expect(Object.keys(p)).toEqual(expect.arrayContaining(['action', 'platform', 'content', 'mediaUrls', 'publishAt', 'timeZone', 'postId']));
    expect(p.action.enum).toEqual(['create', 'list', 'edit', 'cancel']);
  });

  it('create resolves wall-clock + timezone and persists via the port', async () => {
    const { repo, deps } = setup();
    const r = await handleScheduleSocialPost(deps, createArgs);
    expect(r).toMatchObject({ success: true, action: 'create', post: { id: 'p1', status: 'pending', publishAt: '2026-11-03T17:30:00.000Z' } });
    expect(repo.rows.get('p1')?.platform).toBe('linkedin');
  });

  it('create without timeZone returns TIMEZONE_REQUIRED and writes nothing', async () => {
    const { repo, deps } = setup();
    const { timeZone: _tz, ...noTz } = createArgs;
    const r = await handleScheduleSocialPost(deps, noTz);
    expect(r).toMatchObject({ success: false, code: 'TIMEZONE_REQUIRED' });
    expect(r.message).toMatch(/IANA/);
    expect(repo.rows.size).toBe(0);
  });

  it('invalid IANA timezone is a structured error', async () => {
    const { deps } = setup();
    const r = await handleScheduleSocialPost(deps, { ...createArgs, timeZone: 'Mars/Olympus' });
    expect(r).toMatchObject({ success: false, code: 'TIMEZONE_INVALID' });
  });

  it('resolver errors surface without throwing', async () => {
    const { deps } = setup();
    const r = await handleScheduleSocialPost(deps, { ...createArgs, publishAt: '2026-11-03T09:30Z' });
    expect(r).toMatchObject({ success: false, code: 'WALL_CLOCK_INVALID' });
  });

  it('past datetime surfaces the port validation errors', async () => {
    const { deps } = setup();
    const r = await handleScheduleSocialPost(deps, { ...createArgs, publishAt: '2026-10-01T09:30' });
    expect(r).toMatchObject({ success: false, action: 'create', code: 'VALIDATION_FAILED' });
    if (!r.success) expect(r.errors?.[0].code).toBe('PUBLISH_AT_NOT_FUTURE');
  });

  it('list uses the ENG-2511 formatter, including failed posts', async () => {
    const { repo, deps } = setup();
    await handleScheduleSocialPost(deps, createArgs);
    repo.rows.set('pf', {
      id: 'pf', userId: 'u1', platform: 'x', status: 'failed', publishAt: new Date('2026-10-31T10:00:00Z'),
      content: 'broken', mediaUrls: [], lastError: 'token expired', updatedAt: NOW,
    } as OwnedScheduledPost);
    const r = await handleScheduleSocialPost(deps, { action: 'list', timeZone: 'America/Los_Angeles' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.list?.groups.map((g) => g.label)).toEqual(['LinkedIn', 'Failed']);
      expect(r.message).toContain('FAILED');
      expect(r.message).toContain('token expired');
    }
  });

  it('list requires a timezone', async () => {
    const { deps } = setup();
    expect(await handleScheduleSocialPost(deps, { action: 'list' })).toMatchObject({ success: false, code: 'TIMEZONE_REQUIRED' });
  });

  it('edit changes content and time via the port', async () => {
    const { deps } = setup();
    await handleScheduleSocialPost(deps, createArgs);
    const r = await handleScheduleSocialPost(deps, {
      action: 'edit', postId: 'p1', content: 'Updated', publishAt: '2026-11-04T08:00', timeZone: 'UTC',
    });
    expect(r).toMatchObject({ success: true, post: { content: 'Updated', publishAt: '2026-11-04T08:00:00.000Z' } });
  });

  it('edit with publishAt but no timezone is rejected', async () => {
    const { deps } = setup();
    await handleScheduleSocialPost(deps, createArgs);
    const r = await handleScheduleSocialPost(deps, { action: 'edit', postId: 'p1', publishAt: '2026-11-04T08:00' });
    expect(r).toMatchObject({ success: false, code: 'TIMEZONE_REQUIRED' });
  });

  it('edit/cancel of an unknown post id return NOT_FOUND', async () => {
    const { deps } = setup();
    expect(await handleScheduleSocialPost(deps, { action: 'edit', postId: 'nope', content: 'x' })).toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(await handleScheduleSocialPost(deps, { action: 'cancel', postId: 'nope' })).toMatchObject({ success: false, code: 'NOT_FOUND' });
  });

  it('cancel transitions the post to cancelled', async () => {
    const { repo, deps } = setup();
    await handleScheduleSocialPost(deps, createArgs);
    const r = await handleScheduleSocialPost(deps, { action: 'cancel', postId: 'p1' });
    expect(r).toMatchObject({ success: true, post: { status: 'cancelled' } });
    expect(repo.rows.get('p1')?.status).toBe('cancelled');
  });

  it('bad action / non-object args / port exceptions never throw', async () => {
    const { deps } = setup();
    expect(await handleScheduleSocialPost(deps, null)).toMatchObject({ success: false, code: 'INVALID_ARGUMENTS' });
    expect(await handleScheduleSocialPost(deps, { action: 'publish' })).toMatchObject({ success: false, code: 'INVALID_ARGUMENTS' });
    expect(await handleScheduleSocialPost(deps, { action: 'cancel' })).toMatchObject({ success: false, code: 'INVALID_ARGUMENTS' });
    const throwing: ScheduleSocialPostDeps = {
      ...deps,
      commands: { ...deps.commands, cancel: async () => { throw new Error('boom'); } },
    };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await handleScheduleSocialPost(throwing, { action: 'cancel', postId: 'p1' });
    expect(res).toMatchObject({ success: false, code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(res)).not.toMatch(/boom|SQL|table/i);
    errSpy.mockRestore();
  });
});
