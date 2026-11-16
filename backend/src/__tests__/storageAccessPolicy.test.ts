/**
 * ENG-2988: who may read or overwrite a file in the private bucket (services/storageAccessPolicy.ts).
 * Auth-sensitive, so every key shape the code writes is covered for: owner, teammate, other org, real admin, and a missing owner.
 */
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  taskDb: { getTaskById: jest.fn(), getTaskExecutionOwnerById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSessionRecord: jest.fn() },
}));

import { userDb, taskDb, orgDb } from '../services/db';
import { chatbotDb } from '../services/chatbotService';
import {
  canonicalStorageKey,
  decideStorageAccess,
  StorageAccessLookups,
  StorageCaller,
} from '../services/storageAccessPolicy';

const getUser = userDb.getUserById as jest.Mock;
const getTask = taskDb.getTaskById as jest.Mock;
const getExecution = taskDb.getTaskExecutionOwnerById as jest.Mock;
const getOrg = orgDb.getOrgById as jest.Mock;
const getSession = chatbotDb.getChatSessionRecord as jest.Mock;

const ME: StorageCaller = { userId: 'me', isRealAdmin: false };
const ADMIN: StorageCaller = { userId: 'root', isRealAdmin: true };

const users: Record<string, { userId: string; orgId?: string; orgRole?: string }> = {
  me: { userId: 'me', orgId: 'orgA', orgRole: 'member' },
  mate: { userId: 'mate', orgId: 'orgA', orgRole: 'member' },
  boss: { userId: 'boss', orgId: 'orgA', orgRole: 'owner' },
  solo: { userId: 'solo' },
  other: { userId: 'other', orgId: 'orgB', orgRole: 'member' },
  root: { userId: 'root' },
};
let kbShared = true;

beforeEach(() => {
  jest.resetAllMocks();
  kbShared = true;
  getUser.mockImplementation(async (id: string) => users[id]);
  getOrg.mockImplementation(async (orgId: string) => ({
    orgId,
    ownerUserId: 'boss',
    shareSettings: { knowledgeBase: { enabled: kbShared, editors: [] } },
  }));
  getTask.mockImplementation(async (id: string) => (id === 't-mate' ? { taskId: id, userId: 'mate' } : id === 't-me' ? { taskId: id, userId: 'me' } : id === 't-other' ? { taskId: id, userId: 'other' } : undefined));
  getExecution.mockImplementation(async (id: string) =>
    id === 'e-mate' ? { executionId: id, userId: 'mate', taskId: 't-mate' }
    : id === 'e-other' ? { executionId: id, userId: 'other', taskId: 't-other' }
    : id === 'e-old' ? { executionId: id, userId: 'mate' } // an old row without a task id
    : undefined);
  getSession.mockImplementation(async (id: string) => (id === 's-me' ? { sessionId: id, userId: 'me' } : id === 's-other' ? { sessionId: id, userId: 'other' } : null));
});

const read = (caller: StorageCaller, key: string) => decideStorageAccess(caller, key, 'read', new StorageAccessLookups()).then((d) => d.allow);
const write = (caller: StorageCaller, key: string) => decideStorageAccess(caller, key, 'write', new StorageAccessLookups()).then((d) => d.allow);

describe('canonicalStorageKey', () => {
  it('accepts an ordinary key unchanged', () => {
    expect(canonicalStorageKey('users/me/files/1/abc/a.png', 'key')).toBe('users/me/files/1/abc/a.png');
  });

  it('decodes a URL path exactly once, and a key as given', () => {
    expect(canonicalStorageKey('users/me/files/1/abc/my%20file.png', 'url-path')).toBe('users/me/files/1/abc/my file.png');
    expect(canonicalStorageKey('users/me/files/1/abc/my%20file.png', 'key')).toBe('users/me/files/1/abc/my%20file.png');
    // double-encoded dots decode once to literal text, never to a traversal segment
    expect(canonicalStorageKey('users/me/%252e%252e/victim/f.png', 'url-path')).toBe('users/me/%2e%2e/victim/f.png');
  });

  it('strips at most one leading s3: prefix', () => {
    expect(canonicalStorageKey('s3:tasks/t1/attachments/a.txt', 'key')).toBe('tasks/t1/attachments/a.txt');
    expect(canonicalStorageKey('s3:s3:tasks/t1/a.txt', 'key')).toBe('s3:tasks/t1/a.txt');
  });

  it.each([
    ['empty', ''],
    ['leading slash', '/users/me/files/a.png'],
    ['empty segment', 'users//me/files/a.png'],
    ['dot segment', 'users/me/./files/a.png'],
    ['parent segment', 'users/me/../victim/files/a.png'],
    ['backslash', 'users\\victim\\files\\a.png'],
    ['query (a client-sent key is not a URL)', 'users/me/files/a.png?x=1'],
    ['fragment (a client-sent key is not a URL)', 'users/me/files/a.png#x'],
    ['newline', 'users/me/files/a\n.png'],
    ['NUL', 'users/me/files/a\u0000.png'],
    ['DEL', 'users/me/files/a\u007f.png'],
    ['too long', 'users/me/files/' + 'a'.repeat(1100)],
    ['only s3:', 's3:'],
  ])('rejects %s', (_name, raw) => {
    expect(canonicalStorageKey(raw, 'key')).toBeNull();
  });

  it('rejects an encoded traversal in a URL path', () => {
    expect(canonicalStorageKey('users/me/%2e%2e/victim/files/a.png', 'url-path')).toBeNull();
    expect(canonicalStorageKey('users/me/%2E%2E/victim/files/a.png', 'url-path')).toBeNull();
    expect(canonicalStorageKey('users/me/files/a%5Cb.png', 'url-path')).toBeNull(); // encoded backslash
    expect(canonicalStorageKey('users%2Fme%2F..%2Fvictim%2Ff.png', 'url-path')).toBeNull(); // encoded slashes hiding a traversal
    expect(canonicalStorageKey('users/me/files/a%00b.png', 'url-path')).toBeNull(); // encoded NUL
  });

  it('accepts ? and # that were escaped in a URL path: they are legal in an object name and the key is signed as a whole', () => {
    expect(canonicalStorageKey('task_results/e/ab/Report%20%232.pdf', 'url-path')).toBe('task_results/e/ab/Report #2.pdf');
    expect(canonicalStorageKey('users/me/files/1/abc/what%3F.png', 'url-path')).toBe('users/me/files/1/abc/what?.png');
  });

  it('takes a raw path with a stray % as it is (a key built without encoding), and still decodes valid escapes', () => {
    expect(canonicalStorageKey('users/me/files/1/abc/100%.pdf', 'url-path')).toBe('users/me/files/1/abc/100%.pdf');
    expect(canonicalStorageKey('users/me/files/%E0%A4%A', 'url-path')).toBe('users/me/files/%E0%A4%A');
    expect(canonicalStorageKey('users/me/files/50%25.pdf', 'url-path')).toBe('users/me/files/50%.pdf');
  });

  it('a key that is already canonical is only validated again: never decoded or stripped a second time', () => {
    expect(canonicalStorageKey('s3:users/me/files/a.png', 'decoded')).toBe('s3:users/me/files/a.png');
    expect(canonicalStorageKey('users/me/files/100%25.png', 'decoded')).toBe('users/me/files/100%25.png');
    expect(canonicalStorageKey('users/me/../victim/a.png', 'decoded')).toBeNull();
    expect(canonicalStorageKey('users/me/files/a#b.png', 'decoded')).toBe('users/me/files/a#b.png');
  });

  it('rejects non-strings', () => {
    expect(canonicalStorageKey(undefined, 'key')).toBeNull();
    expect(canonicalStorageKey(['users/me/a'], 'key')).toBeNull();
  });
});

describe('decideStorageAccess: users/<id>/...', () => {
  it('lets the owner read and write their own files without any lookup', async () => {
    expect(await read(ME, 'users/me/files/1/abc/a.png')).toBe(true);
    expect(await write(ME, 'users/me/files/1/abc/a.png')).toBe(true);
    expect(await read(ME, 'users/me/books/b1/pdf/x.pdf')).toBe(true);
    expect(getUser).not.toHaveBeenCalled();
  });

  it('keeps a short legacy key readable by its owner', async () => {
    expect(await read(ME, 'users/me/legacy.png')).toBe(true);
  });

  it('lets a teammate in the same organisation read files and brand assets, never write them', async () => {
    expect(await read(ME, 'users/mate/files/1/abc/a.png')).toBe(true);
    expect(await read(ME, 'users/mate/brand/logo/1-x-logo.png')).toBe(true);
    expect(await write(ME, 'users/mate/files/1/abc/a.png')).toBe(false);
    expect(await write(ME, 'users/mate/brand/logo/1-x-logo.png')).toBe(false);
  });

  it('keeps books, zoma-uploads and unknown kinds owner-only, even for a teammate', async () => {
    for (const kind of ['books/b1/pdf/x.pdf', 'zoma-uploads/u.png', 'secrets/x.txt']) {
      expect(await read(ME, `users/mate/${kind}`)).toBe(false);
    }
  });

  it('lets a teammate read a branded video (they appear in the shared creative library), never change it', async () => {
    expect(await read(ME, 'users/mate/remotion/1_v.mp4')).toBe(true);
    expect(await write(ME, 'users/mate/remotion/1_v.mp4')).toBe(false);
    expect(await read({ userId: 'other', isRealAdmin: false }, 'users/mate/remotion/1_v.mp4')).toBe(false);
  });

  it('refuses another organisation, a user with no organisation, and a missing owner', async () => {
    expect(await read(ME, 'users/other/files/1/abc/a.png')).toBe(false);
    expect(await read({ userId: 'solo', isRealAdmin: false }, 'users/mate/files/1/abc/a.png')).toBe(false);
    expect(await read({ userId: 'solo', isRealAdmin: false }, 'users/solo2/files/1/abc/a.png')).toBe(false);
    expect(await read(ME, 'users/ghost/files/1/abc/a.png')).toBe(false);
  });

  it('refuses two people who both have no organisation', async () => {
    users.solo2 = { userId: 'solo2' };
    expect(await read({ userId: 'solo', isRealAdmin: false }, 'users/solo2/files/1/abc/a.png')).toBe(false);
    delete users.solo2;
  });

  it('lets a real admin read and write anything, including a missing owner', async () => {
    expect(await read(ADMIN, 'users/other/files/1/abc/a.png')).toBe(true);
    expect(await write(ADMIN, 'users/other/files/1/abc/a.png')).toBe(true);
    expect(await read(ADMIN, 'users/ghost/files/1/abc/a.png')).toBe(true);
  });

  it('refuses everything when the owner lookup fails (fail closed)', async () => {
    getUser.mockRejectedValue(new Error('dynamo down'));
    expect(await read(ME, 'users/mate/files/1/abc/a.png')).toBe(false);
    expect(await read(ME, 'users/me/files/1/abc/a.png')).toBe(true); // own key needs no lookup
  });

  it('has no owner for the pseudo users, so only an admin may reach them', async () => {
    for (const id of ['anonymous', 'human-eval', 'workplans']) {
      expect(await read(ME, `users/${id}/files/1/abc/a.png`)).toBe(false);
      expect(await read(ADMIN, `users/${id}/files/1/abc/a.png`)).toBe(true);
    }
  });

  it('refuses a bare users/<id> prefix', async () => {
    expect(await read(ME, 'users/me')).toBe(false);
    expect(await read(ME, 'users')).toBe(false);
  });
});

describe('decideStorageAccess: guest uploads to a shared chat', () => {
  it('belongs to the chat session owner and nobody else', async () => {
    expect(await read(ME, 'users/ishare-sessions/s-me/1/a.png')).toBe(true);
    expect(await write(ME, 'users/ishare-sessions/s-me/1/a.png')).toBe(true);
    expect(await read(ME, 'users/ishare-sessions/s-other/1/a.png')).toBe(false);
    expect(await read(ME, 'users/ishare-sessions/gone/1/a.png')).toBe(false);
    expect(await read(ADMIN, 'users/ishare-sessions/s-other/1/a.png')).toBe(true);
  });
});

describe('decideStorageAccess: tasks/<id>/...', () => {
  it('lets the task owner read and write their task files', async () => {
    expect(await read(ME, 'tasks/t-me/attachments/1-a.txt')).toBe(true);
    expect(await write(ME, 'tasks/t-me/attachments/1-a.txt')).toBe(true);
  });

  it('lets a teammate read them when the organisation shares knowledge bases, not when it does not', async () => {
    expect(await read(ME, 'tasks/t-mate/attachments/1-a.txt')).toBe(true);
    kbShared = false;
    expect(await read(ME, 'tasks/t-mate/attachments/1-a.txt')).toBe(false);
  });

  it('does not let a plain member overwrite a teammate\'s task files', async () => {
    expect(await write(ME, 'tasks/t-mate/attachments/1-a.txt')).toBe(false);
  });

  it('lets an organisation owner manage a teammate\'s task files (same rule as the task routes)', async () => {
    expect(await write({ userId: 'boss', isRealAdmin: false }, 'tasks/t-mate/attachments/1-a.txt')).toBe(true);
  });

  it('refuses another organisation, a missing task, and allows an admin', async () => {
    expect(await read(ME, 'tasks/t-other/attachments/1-a.txt')).toBe(false);
    expect(await read(ME, 'tasks/gone/attachments/1-a.txt')).toBe(false);
    expect(await read(ADMIN, 'tasks/t-other/attachments/1-a.txt')).toBe(true);
    expect(await read(ADMIN, 'tasks/gone/attachments/1-a.txt')).toBe(true);
  });

  it('handles the s3: prefix the knowledge-base entries are stored with (after canonicalisation)', async () => {
    const key = canonicalStorageKey('s3:tasks/t-other/knowledge-base.txt', 'key')!;
    expect(await read(ME, key)).toBe(false);
  });
});

describe('decideStorageAccess: execution files', () => {
  it('uses the execution\'s owner, and falls back to the task when the execution is gone', async () => {
    expect(await read(ME, 'tasks/t-mate/executions/e-mate/1-a.png')).toBe(true); // teammate, same org
    expect(await write(ME, 'tasks/t-mate/executions/e-mate/1-a.png')).toBe(false);
    expect(await read(ME, 'tasks/t-other/executions/e-other/1-a.png')).toBe(false);
    expect(await read(ME, 'tasks/t-me/executions/e-gone/1-a.png')).toBe(true); // task owner
    expect(await read(ME, 'tasks/t-other/executions/e-gone/1-a.png')).toBe(false);
    expect(await read(ME, 'tasks/gone/executions/e-gone/1-a.png')).toBe(false);
  });

  it('reads task_results and screenshots through the execution row', async () => {
    expect(await read(ME, 'task_results/e-mate/result.json')).toBe(true);
    expect(await read(ME, 'screenshots/e-other/1.png')).toBe(false);
    expect(await read(ME, 'screenshots/e-gone/1.png')).toBe(false);
    expect(await read(ADMIN, 'screenshots/e-other/1.png')).toBe(true);
  });

  it('keeps execution_logs with the user in the key, owner only', async () => {
    expect(await read(ME, 'execution_logs/me/1.log')).toBe(true);
    expect(await read(ME, 'execution_logs/mate/1.log')).toBe(false);
  });
});

describe('decideStorageAccess: platform and session shapes', () => {
  it('limits tool-responses to the chat session owner', async () => {
    expect(await read(ME, 'tool-responses/s-me/1.json')).toBe(true);
    expect(await read(ME, 'tool-responses/s-other/1.json')).toBe(false);
    expect(await read(ME, 'tool-responses/gone/1.json')).toBe(false);
  });

  it('lets any signed-in user read platform plan thumbnails but only an admin change them', async () => {
    expect(await read(ME, 'workplans/p1/thumbnails/a.png')).toBe(true);
    expect(await write(ME, 'workplans/p1/thumbnails/a.png')).toBe(false);
    expect(await write(ADMIN, 'workplans/p1/thumbnails/a.png')).toBe(true);
  });

  it('keeps sandbox files with their user, and sandbox datasets for evaluation users and admins', async () => {
    expect(await read(ME, 'sandbox/me/x.csv')).toBe(true);
    expect(await read(ME, 'sandbox/other/x.csv')).toBe(false);
    expect(await read(ME, 'sandbox-datasets/d/x.csv')).toBe(false);
    expect(await read({ userId: 'eval_1', isRealAdmin: false }, 'sandbox-datasets/d/x.csv')).toBe(true);
    expect(await write({ userId: 'eval_1', isRealAdmin: false }, 'sandbox-datasets/d/x.csv')).toBe(false);
    expect(await read(ADMIN, 'sandbox-datasets/d/x.csv')).toBe(true);
  });

  it('refuses any shape it does not know, for everyone except a real admin', async () => {
    for (const key of ['test.html', 'video_inputs/x.mp4', 'random/prefix/file.png', 'a/b']) {
      expect(await read(ME, key)).toBe(false);
      expect(await write(ME, key)).toBe(false);
      expect(await read(ADMIN, key)).toBe(true);
    }
  });
});

describe('decideStorageAccess: bypass attempts after canonicalisation', () => {
  it('cannot reach a victim\'s key by dressing it up as one of the caller\'s own', async () => {
    const attempts = [
      'users/me/../mate/files/1/abc/a.png',
      'users/me/%2e%2e/mate/files/1/abc/a.png',
      'users/me\\..\\mate/files/1/abc/a.png',
      'users/me/files/a.png/%2e%2e/%2e%2e/mate/files/1/abc/a.png',
    ];
    for (const raw of attempts) {
      const key = canonicalStorageKey(raw, 'url-path');
      expect(key).toBeNull();
    }
  });

  it('treats a lookalike owner id as a different user', async () => {
    expect(await read(ME, 'users/me2/files/1/abc/a.png')).toBe(false);
    expect(await read(ME, 'users/ME/files/1/abc/a.png')).toBe(false);
    expect(await read(ME, 'users/me /files/1/abc/a.png')).toBe(false);
  });
});

describe('decideStorageAccess: files of an anonymous visitor\'s plan session', () => {
  it('can be read by any signed-in user (the session moves to the visitor\'s new account but the keys keep the anon_ id) and changed only by an admin', async () => {
    const key = 'users/anon_3f2a9c/files/1/abc/plan.html';
    expect(await read(ME, key)).toBe(true);
    expect(await read({ userId: 'solo', isRealAdmin: false }, key)).toBe(true);
    expect(await write(ME, key)).toBe(false);
    expect(await write(ADMIN, key)).toBe(true);
    expect(getUser).not.toHaveBeenCalled();
  });
});

describe('decideStorageAccess: an execution must belong to the task named in the key', () => {
  it('refuses my own task\'s folder holding someone else\'s execution, and a victim task\'s folder holding my execution', async () => {
    expect(await read(ME, 'tasks/t-me/executions/e-mate/1-a.png')).toBe(false); // e-mate belongs to t-mate
    expect(await read({ userId: 'mate', isRealAdmin: false }, 'tasks/t-other/executions/e-mate/1-a.png')).toBe(false); // my execution under a victim's task
    expect(await write({ userId: 'mate', isRealAdmin: false }, 'tasks/t-other/executions/e-mate/1-a.png')).toBe(false);
    expect(await read(ADMIN, 'tasks/t-me/executions/e-mate/1-a.png')).toBe(true);
    expect(await read(ME, 'tasks/t-mate/executions/e-mate/1-a.png')).toBe(true); // the matching pair still works
  });

  it('still works for an old execution row that has no task id', async () => {
    expect(await read(ME, 'tasks/t-mate/executions/e-old/1-a.png')).toBe(true);
  });
});

describe('decideStorageAccess: when a lookup fails', () => {
  it('refuses, says it was the lookup (so the route can answer "try again"), and logs it without any key', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    getUser.mockRejectedValue(new Error('dynamo down'));
    const lookups = new StorageAccessLookups();
    const decision = await decideStorageAccess(ME, 'users/mate/files/1/abc/secret-name.png', 'read', lookups);
    expect(decision).toEqual({ allow: false, reason: 'lookup_failed', shape: 'users/*/files' });
    expect(lookups.failed).toBe(true);
    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('storage_access_lookup_failed');
    expect(logged).not.toContain('secret-name');
    expect(logged).not.toContain('mate');
    errors.mockRestore();
  });

  it('does not report a normal refusal as a lookup failure', async () => {
    const decision = await decideStorageAccess(ME, 'users/other/files/1/abc/a.png', 'read', new StorageAccessLookups());
    expect(decision).toMatchObject({ allow: false, reason: 'not_teammate' });
  });
});

describe('StorageAccessLookups: how many missing records one request may look up', () => {
  beforeEach(() => {
    getUser.mockReset();
    getUser.mockImplementation(async (id: string) => users[id]);
    getTask.mockReset();
    getExecution.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads at most 10 records that turn out not to exist; later ones are not read, count as not found, mark the request failed, and are logged once', async () => {
    const lookups = new StorageAccessLookups();
    const found: unknown[] = [];
    for (let i = 0; i < 30; i++) found.push(await lookups.user(`ghost-${i}`));
    expect(getUser).toHaveBeenCalledTimes(StorageAccessLookups.MAX_MISSES);
    expect(found.every((u) => u === null)).toBe(true);
    expect(lookups.failed).toBe(true);
    expect((console.warn as jest.Mock).mock.calls.filter((c) => String(c[0]).includes('storage_access_lookup_limit'))).toHaveLength(1);
  });

  it('records that exist do not count, so a long legitimate batch is not cut', async () => {
    const many: Record<string, any> = {};
    for (let i = 0; i < 60; i++) many[`u${i}`] = { userId: `u${i}`, orgId: 'orgA', orgRole: 'member' };
    getUser.mockImplementation(async (id: string) => many[id]);
    const lookups = new StorageAccessLookups();
    for (let i = 0; i < 60; i++) expect(await lookups.user(`u${i}`)).toMatchObject({ userId: `u${i}` });
    expect(getUser).toHaveBeenCalledTimes(60);
    expect(lookups.failed).toBe(false);
  });

  it('asking again for a record already looked up costs nothing, and the first ten misses keep their answer', async () => {
    const lookups = new StorageAccessLookups();
    for (let round = 0; round < 5; round++) for (let i = 0; i < 10; i++) await lookups.user(`ghost-${i}`);
    expect(getUser).toHaveBeenCalledTimes(10);
    expect(lookups.failed).toBe(false); // the limit is reached, not exceeded
  });

  it('a batch naming 50 made-up owners refuses them all without 50 reads, and still allows the caller\'s own files', async () => {
    const lookups = new StorageAccessLookups();
    const decisions = [];
    for (let i = 0; i < 50; i++) decisions.push(await decideStorageAccess(ME, `users/ghost${i}/files/1/abc/a.png`, 'read', lookups));
    expect(decisions.every((d) => !d.allow)).toBe(true);
    expect(getUser.mock.calls.length).toBeLessThanOrEqual(StorageAccessLookups.MAX_MISSES + 1); // the caller's own record may be read once too
    expect((await decideStorageAccess(ME, 'users/me/files/1/abc/mine.png', 'read', lookups)).allow).toBe(true); // no lookup needed for one's own key
  });

  it('once the limit is reached an execution file is refused, not decided by falling back to its task (that would skip the check that the execution belongs to the task), even when the task was read earlier in the same request', async () => {
    getTask.mockResolvedValue({ taskId: 't-me', userId: 'me' });
    getExecution.mockResolvedValue({ userId: 'mate', taskId: 'someone-elses-task' }); // a victim's execution, named under my own task
    // without the limit the check is real: the execution does not belong to the task in the key
    expect((await decideStorageAccess(ME, 'tasks/t-me/executions/e-victim/1-a.png', 'read', new StorageAccessLookups())).allow).toBe(false);
    // a batch: my own task's attachment first (so the task is already known), then a run of made-up owners, then the execution file
    const lookups = new StorageAccessLookups();
    expect((await decideStorageAccess(ME, 'tasks/t-me/attachments/a.png', 'read', lookups)).allow).toBe(true);
    for (let i = 0; i < 12; i++) await decideStorageAccess(ME, `users/ghost${i}/files/1/abc/a.png`, 'read', lookups);
    getExecution.mockClear();
    const decision = await decideStorageAccess(ME, 'tasks/t-me/executions/e-victim/1-a.png', 'read', lookups);
    expect(decision).toMatchObject({ allow: false, reason: 'lookup_failed' });
    expect(getExecution).not.toHaveBeenCalled();
  });

  it('lookups that throw count toward the limit too (a database slowdown must not queue one slow read per URL)', async () => {
    getUser.mockImplementation(async () => { throw new Error('throttled'); });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const lookups = new StorageAccessLookups();
    for (let i = 0; i < 30; i++) await lookups.user(`u-${i}`);
    expect(getUser).toHaveBeenCalledTimes(StorageAccessLookups.MAX_MISSES);
    expect(lookups.failed).toBe(true);
  });
});

describe('decideStorageAccess: ids that cannot name a record are never looked up', () => {
  it('refuses them without asking the database (a long or odd id cannot exist, and a 600-character one would even make the lookup throw)', async () => {
    const long = 'x'.repeat(600);
    const keys = [
      `users/${long}/files/1/abc/a.png`,
      'users/a b/files/1/abc/a.png',
      'users/%20/files/1/abc/a.png',
      `tasks/${long}/attachments/x.txt`,
      'tasks/a.b/attachments/x.txt',
      `tasks/t-me/executions/${long}/x.png`,
      `tool-responses/${long}/x.json`,
      `task_results/${long}/x.json`,
      `screenshots/a b/1.jpeg`,
      `users/ishare-sessions/${long}/1/x.png`,
      'execution_logs/a b/1.log',
    ];
    for (const key of keys) expect(await read(ME, key)).toBe(false);
    expect(getUser).not.toHaveBeenCalled();
    expect(getTask).not.toHaveBeenCalled();
    expect(getExecution).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    for (const key of keys) expect(await read(ADMIN, key)).toBe(true); // an admin is still not blocked by it
  });

  it('accepts the id shapes the system really produces (uuid, timestamp, anon_ uuid, eval_ id)', async () => {
    const uuid = '3f2a9c10-52de-4b52-9f6a-0a1b2c3d4e5f';
    getUser.mockImplementation(async (id: string) => ({ userId: id, orgId: 'orgA', orgRole: 'member' }));
    expect(await read({ userId: uuid, isRealAdmin: false }, `users/${uuid}/files/1/abc/a.png`)).toBe(true);
    expect(await read({ userId: '1738251317419', isRealAdmin: false }, 'users/1738251317419/files/1/abc/a.png')).toBe(true);
    expect(await read({ userId: 'eval_abc123', isRealAdmin: false }, 'users/eval_abc123/files/1/abc/a.png')).toBe(true);
  });
});

describe('decideStorageAccess: a failed execution lookup does not fall back to the task', () => {
  it('refuses (and says "lookup failed") instead of trusting the task in the key, which would skip the execution/task check', async () => {
    getExecution.mockRejectedValue(new Error('dynamo down'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const decision = await decideStorageAccess(ME, 'tasks/t-me/executions/e-mate/1-a.png', 'read', new StorageAccessLookups());
    expect(decision).toMatchObject({ allow: false, reason: 'lookup_failed' });
    (console.error as jest.Mock).mockRestore();
  });

  it('still works from the task when the execution row is simply gone', async () => {
    expect(await read(ME, 'tasks/t-me/executions/e-gone/1-a.png')).toBe(true);
  });
});

describe('decideStorageAccess: what a refusal reports about the key', () => {
  it('names only the kind of file, never ids, file names or caller-chosen text', async () => {
    const cases: Array<[string, string]> = [
      ['users/other/files/1/abc/secret-name.png', 'users/*/files'],
      ['users/other/some-file-name.png', 'users/*/other'],
      ['users/anonymous/files/1/abc/x.png', 'users/pseudo'],
      ['users/ishare-sessions/s-other/1/x.png', 'users/*/ishare-sessions'],
      ['tasks/t-other/attachments/secret-name.txt', 'tasks/*/attachments'],
      ['tasks/t-other/executions/e-other/x.png', 'tasks/*/executions'],
      ['tasks/t-other/anything-here/x.png', 'tasks/*/other'],
      ['attacker-chosen-first-segment/x', 'other'],
      ['screenshots/e-other/1.jpeg', 'screenshots/*'],
    ];
    for (const [key, expected] of cases) {
      const decision = await decideStorageAccess(ME, key, 'read', new StorageAccessLookups());
      expect(decision.allow).toBe(false);
      expect((decision as any).shape).toBe(expected);
    }
  });
});

describe('StorageAccessLookups', () => {
  it('asks the database once per user, task and session even for a batch of keys', async () => {
    const lookups = new StorageAccessLookups();
    for (let i = 0; i < 10; i++) {
      await decideStorageAccess(ME, `users/mate/files/${i}/abc/a.png`, 'read', lookups);
      await decideStorageAccess(ME, `tasks/t-mate/attachments/${i}.txt`, 'read', lookups);
    }
    const asked = (m: jest.Mock, id: string) => m.mock.calls.filter((c) => c[0] === id).length;
    expect(asked(getUser, 'me')).toBe(1);
    expect(asked(getUser, 'mate')).toBe(1);
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(getOrg).toHaveBeenCalledTimes(1);
  });
});
