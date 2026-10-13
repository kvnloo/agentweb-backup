/**
 * ENG-112 follow-up: branches created before `branchedFrom` existed (only the row-0 `branchOrigin` marker)
 * heal themselves when their OWNER opens them. Real agentModeController.getSession + real ChatbotDB over an
 * in-memory DocumentClient that applies writes and enforces ConditionExpressions.
 */
import { BranchFakeDynamo } from './helpers/branchFakeDynamo';

const mockFake = new BranchFakeDynamo();
const mockGetSetting = jest.fn();

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => mockFake.client()) },
  S3: jest.fn(() => ({})),
  SecretsManager: jest.fn(() => ({})),
  config: { update: jest.fn() },
}));
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...a: unknown[]) => mockGetSetting(...a) },
}));
jest.mock('../services/skillService', () => ({
  skillService: { getPublishedSkills: jest.fn().mockResolvedValue([]), getSkillsByIds: jest.fn().mockResolvedValue([]), getSkillsAvailableToUser: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../services/db', () => ({
  userDb: { updateUser: jest.fn().mockResolvedValue(undefined), getUserById: jest.fn().mockResolvedValue(null) },
  taskDb: {},
}));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn().mockResolvedValue('k') }));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));

import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import {
  healLegacyBranchedFrom,
  listBranchFamily,
  LEGACY_HEAL_MAX_HOPS,
  __resetLegacyHealCacheForTests,
  __legacyHealCacheSizeForTests,
  LegacyBranchHealDeps,
} from '../services/agentMode/chatBranching';

const OWNER = 'user-owner';
const OTHER = 'user-other';
const BRANCHED_AT = '2026-10-10T08:00:00.000Z';

const marker = (sourceSessionId: string, sourceMessageIndex = 3, branchedAt = BRANCHED_AT) => ({
  sourceSessionId, sourceTitle: 'src', sourceMessageIndex, branchedAt,
});
const rows = (origin?: unknown) => [
  { role: 'system', content: 'sys', ...(origin ? { metadata: { branchOrigin: origin } } : {}) },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
];
const session = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId, userId: OWNER, title: sessionId, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  messageCount: 3, ...extra,
});
const seedLegacyBranch = (id: string, sourceId: string, extra: Record<string, unknown> = {}, idx = 3) => {
  mockFake.seedSession(session(id, extra));
  mockFake.seedMessages(id, rows(marker(sourceId, idx)));
};
const seedPlain = (id: string, extra: Record<string, unknown> = {}) => {
  mockFake.seedSession(session(id, extra));
  mockFake.seedMessages(id, rows());
};

const open = async (user: any, sessionId: string, extraReq: Record<string, unknown> = {}) => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  await agentModeController.getSession({ user, params: { sessionId }, ...extraReq } as any, res);
  return res;
};
const owner = { userId: OWNER, email: 'o@x.test' };
const sessionWrites = () => mockFake.writeLog.filter((w) => w.table.endsWith('AW-ChatSessions') && w.op === 'update');
const flagReads = () => mockGetSetting.mock.calls.filter((c) => c[0] === 'chat_branching_enabled').length;
const stored = (id: string) => mockFake.session(id)?.branchedFrom;

let warn: jest.SpyInstance;
beforeEach(() => {
  __resetLegacyHealCacheForTests();
  mockFake.tables.clear();
  mockFake.writeLog.length = 0;
  mockFake.getLog.length = 0;
  mockFake.messageQueries.length = 0;
  mockFake.conditionalFailures = 0;
  mockFake.failUpdates = undefined;
  mockGetSetting.mockReset().mockResolvedValue({ settingValue: 'true' });
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('ENG-112 legacy branch heal on open', () => {
  it('derives, persists once and returns branchedFrom for a legacy branch of a root chat', async () => {
    seedPlain('root');
    seedLegacyBranch('legacy', 'root');
    const res = await open(owner, 'legacy');
    const expected = { sessionId: 'root', rootSessionId: 'root', messageIndex: 3, branchedAt: BRANCHED_AT };
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].branchedFrom).toEqual(expected);
    expect(stored('legacy')).toEqual(expected);
    expect(sessionWrites()).toHaveLength(1);
    expect(mockFake.session('legacy')?.updatedAt).toBe('2026-10-01T00:00:00.000Z'); // sidebar order untouched
  });

  it('is identical to what branching writes: branchedAt/messageIndex copied from the marker, root = source root', async () => {
    seedPlain('mid', { branchedFrom: { sessionId: 'top', rootSessionId: 'top', messageIndex: 1, branchedAt: 'x' } });
    seedLegacyBranch('legacy', 'mid', {}, 7);
    const res = await open(owner, 'legacy');
    expect(res.json.mock.calls[0][0].branchedFrom).toEqual({ sessionId: 'mid', rootSessionId: 'top', messageIndex: 7, branchedAt: BRANCHED_AT });
  });

  it('second open: already healed, so no further reads of other sessions and no writes', async () => {
    seedPlain('root');
    seedLegacyBranch('legacy', 'root');
    await open(owner, 'legacy');
    mockFake.writeLog.length = 0;
    mockFake.getLog.length = 0;
    const res = await open(owner, 'legacy');
    expect(res.json.mock.calls[0][0].branchedFrom).toEqual(stored('legacy'));
    expect(mockFake.writeLog).toHaveLength(0);
    expect(mockFake.getLog.filter((g) => !g.endsWith(':legacy'))).toEqual([]);
    expect(flagReads()).toBe(1);
  });

  it('a session that is not a branch costs nothing extra (no flag read, no record reads, no write)', async () => {
    seedPlain('plain');
    await open(owner, 'plain');
    expect(flagReads()).toBe(0);
    expect(mockFake.getLog.filter((g) => !g.endsWith(':plain'))).toEqual([]);
    expect(sessionWrites()).toHaveLength(0);
  });

  it('a branch of a legacy branch: the healed middle branch gives the new branch the same family root', async () => {
    seedPlain('root');
    seedLegacyBranch('legacyB', 'root');
    await open(owner, 'legacyB');
    // a NEW (post-#3463) branch of legacyB is written with familyRootOf(legacyB) = 'root'
    expect(stored('legacyB')?.rootSessionId).toBe('root');
    seedLegacyBranch('legacyC', 'legacyB');
    const res = await open(owner, 'legacyC');
    expect(res.json.mock.calls[0][0].branchedFrom).toEqual({ sessionId: 'legacyB', rootSessionId: 'root', messageIndex: 3, branchedAt: BRANCHED_AT });
  });

  it('two unhealed legacy hops: the immediate (record-only) source is the root, never a message-row read', async () => {
    seedPlain('root');
    seedLegacyBranch('legacyB', 'root');
    seedLegacyBranch('legacyC', 'legacyB');
    mockFake.messageQueries.length = 0;
    const res = await open(owner, 'legacyC');
    expect(res.json.mock.calls[0][0].branchedFrom.rootSessionId).toBe('legacyB');
    // only the opened session's own history was queried
    expect(mockFake.messageQueries.every((q) => q.ExpressionAttributeValues[':sessionId'] === 'legacyC')).toBe(true);
  });

  it('archived source still derives', async () => {
    seedPlain('root', { archived: true });
    seedLegacyBranch('legacy', 'root');
    const res = await open(owner, 'legacy');
    expect(res.json.mock.calls[0][0].branchedFrom.sessionId).toBe('root');
  });

  it('source owned by another user: skipped silently, nothing written, GET still 200', async () => {
    mockFake.seedSession(session('foreign', { userId: OTHER }));
    seedLegacyBranch('legacy', 'foreign');
    const res = await open(owner, 'legacy');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].branchedFrom).toBeUndefined();
    expect(sessionWrites()).toHaveLength(0);
    expect(stored('legacy')).toBeUndefined();
  });

  it('missing (deleted) source: skipped silently', async () => {
    seedLegacyBranch('legacy', 'gone');
    const res = await open(owner, 'legacy');
    expect(res.json.mock.calls[0][0].branchedFrom).toBeUndefined();
    expect(sessionWrites()).toHaveLength(0);
  });

  it.each([
    ['non-string source id', { sourceSessionId: 5, sourceMessageIndex: 1, branchedAt: BRANCHED_AT }],
    ['unsafe source id', { sourceSessionId: '../x', sourceMessageIndex: 1, branchedAt: BRANCHED_AT }],
    ['negative index', { sourceSessionId: 'root', sourceMessageIndex: -1, branchedAt: BRANCHED_AT }],
    ['fractional index', { sourceSessionId: 'root', sourceMessageIndex: 1.5, branchedAt: BRANCHED_AT }],
    ['missing branchedAt', { sourceSessionId: 'root', sourceMessageIndex: 1 }],
    ['self reference', { sourceSessionId: 'legacy', sourceMessageIndex: 1, branchedAt: BRANCHED_AT }],
  ])('malformed marker (%s) is ignored', async (_n, bad) => {
    seedPlain('root');
    mockFake.seedSession(session('legacy'));
    mockFake.seedMessages('legacy', rows(bad));
    const res = await open(owner, 'legacy');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].branchedFrom).toBeUndefined();
    expect(sessionWrites()).toHaveLength(0);
  });

  it('flag off (or unreadable): untouched, no source read', async () => {
    seedPlain('root');
    seedLegacyBranch('legacy', 'root');
    for (const impl of [async () => ({ settingValue: 'false' }), async () => ({ settingValue: 'TRUE' }), async () => undefined, async () => { throw new Error('down'); }]) {
      mockGetSetting.mockReset().mockImplementation(impl);
      const res = await open(owner, 'legacy');
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json.mock.calls[0][0].branchedFrom).toBeUndefined();
    }
    expect(sessionWrites()).toHaveLength(0);
    expect(mockFake.getLog.filter((g) => g.endsWith(':root'))).toEqual([]);
  });

  it('admin viewing someone else\'s session, and delegated views: untouched', async () => {
    seedPlain('root');
    seedLegacyBranch('legacy', 'root');
    const admin = await open({ userId: 'admin-1', isAdmin: true }, 'legacy');
    expect(admin.json.mock.calls[0][0].branchedFrom).toBeUndefined();
    const delegated = await open(owner, 'legacy', { delegateInfo: { isDelegated: true } });
    expect(delegated.json.mock.calls[0][0].branchedFrom).toBeUndefined();
    expect(sessionWrites()).toHaveLength(0);
    expect(flagReads()).toBe(0);
  });

  it('non-owner non-admin gets 403 and nothing is written', async () => {
    seedPlain('root');
    seedLegacyBranch('legacy', 'root');
    const res = await open({ userId: OTHER }, 'legacy');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(sessionWrites()).toHaveLength(0);
  });

  it('never overwrites an existing branchedFrom, even one that appears after the session was loaded', async () => {
    seedPlain('root');
    seedLegacyBranch('legacy', 'root');
    const existing = { sessionId: 'other', rootSessionId: 'other-root', messageIndex: 9, branchedAt: 'later' };
    const real = chatbotDb.getChatSession.bind(chatbotDb);
    // the winner writes between our load and our conditional update
    const spy = jest.spyOn(chatbotDb, 'getChatSession').mockImplementation(async (...a: any[]) => {
      const s = await real(...(a as [string]));
      mockFake.sessions().get('legacy')!.branchedFrom = existing;
      return s;
    });
    const res = await open(owner, 'legacy');
    spy.mockRestore();
    expect(stored('legacy')).toEqual(existing);
    expect(mockFake.conditionalFailures).toBe(1);
    expect(res.json.mock.calls[0][0].branchedFrom).toEqual(existing); // reports what is stored
  });

  it('concurrent double open: exactly one write lands, both responses carry the same value', async () => {
    seedPlain('root');
    seedLegacyBranch('legacy', 'root');
    const [a, b] = await Promise.all([open(owner, 'legacy'), open(owner, 'legacy')]);
    expect(sessionWrites()).toHaveLength(2); // two attempts...
    expect(mockFake.conditionalFailures).toBe(1); // ...one refused by the condition
    expect(a.json.mock.calls[0][0].branchedFrom).toEqual(stored('legacy'));
    expect(b.json.mock.calls[0][0].branchedFrom).toEqual(stored('legacy'));
  });

  it('the store write is conditional on owner, existence and absence', async () => {
    seedPlain('root');
    seedLegacyBranch('legacy', 'root');
    const bf = { sessionId: 'root', rootSessionId: 'root', messageIndex: 1, branchedAt: BRANCHED_AT };
    expect(await chatbotDb.setBranchedFromIfAbsent('legacy', OTHER, bf)).toBe(false);
    expect(stored('legacy')).toBeUndefined();
    expect(await chatbotDb.setBranchedFromIfAbsent('ghost', OWNER, bf)).toBe(false);
    expect(mockFake.session('ghost')).toBeUndefined();
    expect(await chatbotDb.setBranchedFromIfAbsent('legacy', OWNER, bf)).toBe(true);
    expect(await chatbotDb.setBranchedFromIfAbsent('legacy', OWNER, { ...bf, rootSessionId: 'z' })).toBe(false);
    expect(stored('legacy')).toEqual(bf);
  });

  it('failure is swallowed: a throwing write still answers 200 (without branchedFrom)', async () => {
    seedPlain('root');
    seedLegacyBranch('legacy', 'root');
    mockFake.failUpdates = new Error('ProvisionedThroughputExceeded');
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await open(owner, 'legacy');
    err.mockRestore();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].branchedFrom).toBeUndefined();
    expect(res.json.mock.calls[0][0].sessionId).toBe('legacy');
    mockFake.failUpdates = undefined;
    await open(owner, 'legacy'); // retried on the next open
    expect(stored('legacy')).toBeDefined();
  });

  it('family endpoint lists the healed branch (and its family) afterwards', async () => {
    seedPlain('root');
    seedLegacyBranch('legacy', 'root');
    const familyDeps = {
      isAcceptingWork: () => true,
      isFeatureEnabled: async () => true,
      getSession: (id: string) => chatbotDb.getChatSessionRecord(id),
      listBranches: (u: string, r: string, o: { maxBranches: number; maxPages: number }) => chatbotDb.getBranchFamilySessions(u, r, o),
      getMaxLookupsPerMinute: async () => 0,
    };
    const before = await listBranchFamily(familyDeps, { user: { userId: OWNER }, sessionId: 'root' });
    expect((before.body as any).sessions.map((s: any) => s.sessionId)).toEqual(['root']);
    await open(owner, 'legacy');
    const after = await listBranchFamily(familyDeps, { user: { userId: OWNER }, sessionId: 'root' });
    expect((after.body as any).sessions.map((s: any) => s.sessionId).sort()).toEqual(['legacy', 'root']);
  });
});

describe('healLegacyBranchedFrom: bounds (store-less)', () => {
  const makeDeps = (records: Record<string, any>): LegacyBranchHealDeps & { reads: string[]; sets: any[] } => {
    const reads: string[] = [];
    const sets: any[] = [];
    return {
      reads, sets,
      isFeatureEnabled: async () => true,
      getSessionRecord: async (id) => { reads.push(id); return records[id] ?? null; },
      setBranchedFromIfAbsent: async (id, uid, v) => { sets.push([id, uid, v]); return true; },
      log: () => undefined,
    };
  };
  const rec = (id: string, originTo?: string) => ({
    sessionId: id, userId: OWNER, messages: rows(originTo ? marker(originTo) : undefined),
  });
  const target = { sessionId: 'x0', userId: OWNER, messages: rows(marker('c1')) } as any;

  it('follows inline-marker hops (very old sessions) to the real root', async () => {
    const deps = makeDeps({ c1: rec('c1', 'c2'), c2: rec('c2') });
    const healed = await healLegacyBranchedFrom(deps, target);
    expect(healed?.rootSessionId).toBe('c2');
    expect(deps.reads).toEqual(['c1', 'c2']);
  });

  it('stops after LEGACY_HEAL_MAX_HOPS record reads and uses the last session reached as root', async () => {
    const records: Record<string, any> = {};
    for (let i = 1; i <= 30; i++) records[`c${i}`] = rec(`c${i}`, `c${i + 1}`);
    const deps = makeDeps(records);
    const healed = await healLegacyBranchedFrom(deps, target);
    expect(deps.reads).toHaveLength(LEGACY_HEAL_MAX_HOPS);
    expect(healed?.rootSessionId).toBe(`c${LEGACY_HEAL_MAX_HOPS}`);
  });

  it('a cycle (also back to the opened session) is corrupt data: skipped, bounded', async () => {
    const deps = makeDeps({ c1: rec('c1', 'c2'), c2: rec('c2', 'c1') });
    expect(await healLegacyBranchedFrom(deps, target)).toBeNull();
    const back = makeDeps({ c1: rec('c1', 'x0') });
    expect(await healLegacyBranchedFrom(back, target)).toBeNull();
    expect(deps.sets).toHaveLength(0);
    expect(back.sets).toHaveLength(0);
  });

  it('a hop whose record belongs to someone else, or is missing, aborts the heal', async () => {
    expect(await healLegacyBranchedFrom(makeDeps({ c1: rec('c1', 'c2'), c2: { ...rec('c2'), userId: OTHER } }), target)).toBeNull();
    expect(await healLegacyBranchedFrom(makeDeps({ c1: rec('c1', 'c2') }), target)).toBeNull();
  });

  it('a record read that throws is swallowed', async () => {
    const deps = { ...makeDeps({}), getSessionRecord: async () => { throw new Error('boom'); } };
    expect(await healLegacyBranchedFrom(deps, target)).toBeNull();
  });

  it('a session with branchedFrom triggers no flag read or store call', async () => {
    const deps = makeDeps({});
    const flag = jest.fn(async () => true);
    expect(await healLegacyBranchedFrom({ ...deps, isFeatureEnabled: flag }, { ...target, branchedFrom: { sessionId: 'a', rootSessionId: 'a', messageIndex: 0, branchedAt: 'z' } })).toBeNull();
    expect(flag).not.toHaveBeenCalled();
    expect(deps.reads).toHaveLength(0);
  });

  it('an unhealable session is remembered per process: later opens do no flag read and no source read, and nothing is written', async () => {
    const deps = makeDeps({});
    const flag = jest.fn(async () => true);
    for (let i = 0; i < 3; i++) expect(await healLegacyBranchedFrom({ ...deps, isFeatureEnabled: flag }, target)).toBeNull();
    expect(flag).toHaveBeenCalledTimes(1);
    expect(deps.reads).toEqual(['c1']);
    expect(deps.sets).toHaveLength(0);
  });

  it('failures and a disabled flag are not remembered (retried on the next open)', async () => {
    let fail = true;
    const deps: LegacyBranchHealDeps = { ...makeDeps({ c1: rec('c1') }), getSessionRecord: async (id: string) => { if (fail) throw new Error('boom'); return rec(id) as any; } };
    expect(await healLegacyBranchedFrom(deps, target)).toBeNull();
    fail = false;
    expect((await healLegacyBranchedFrom(deps, target))?.rootSessionId).toBe('c1');
    __resetLegacyHealCacheForTests();
    expect(await healLegacyBranchedFrom({ ...makeDeps({ c1: rec('c1') }), isFeatureEnabled: async () => false }, target)).toBeNull();
    expect(__legacyHealCacheSizeForTests()).toBe(0);
  });

  it('the remembered set is capped (oldest evicted)', async () => {
    const deps = makeDeps({});
    for (let i = 0; i < 600; i++) await healLegacyBranchedFrom(deps, { ...target, sessionId: `s${i}` });
    expect(__legacyHealCacheSizeForTests()).toBe(500);
    deps.reads.length = 0;
    await healLegacyBranchedFrom(deps, { ...target, sessionId: 's0' }); // evicted: reads again
    await healLegacyBranchedFrom(deps, { ...target, sessionId: 's599' }); // still remembered
    expect(deps.reads).toEqual(['c1']);
  });
});
