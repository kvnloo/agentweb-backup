/**
 * ENG-2110 (B3): connecting a Claude login, and holding its single live copy.
 * In-memory store + KMS; the CLI is a stand-in script, so no real login happens in CI.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openSecret, sealSecret } from '../llmConnectionCrypto';
import { LocalClaudeLoginRunner, TMP_ROOT_PREFIX, type LoginHandle, type LoginRunner } from '../claudeLoginRunner';
import {
  ClaudeSubscriptionError, ClaudeSubscriptionService, recoverClaudeSubscriptionOrphansAtBoot, HEARTBEAT_MS, HOME_DIR_PREFIX, LEASE_MS, LOGIN_TTL_MS, MAX_PENDING_LOGINS, parseCredentials, SAVE_DEBOUNCE_MS,
} from '../claudeSubscriptionService';
import { FakeKms, makeDb } from './llmConnectionTestKit';

const FAKE = join(__dirname, 'fixtures', 'fakeClaudeLogin.js');
const GOOD = 'GOODCODE1#GOODSTATE1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e) => (e instanceof ClaudeSubscriptionError ? e.code : `unexpected:${e?.message}`));

function credsText(over: Record<string, unknown> = {}, nowMs = Date.now()) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'SENTINEL-ACCESS-0', refreshToken: 'SENTINEL-REFRESH-0', expiresAt: nowMs + 8 * 3600e3, refreshTokenExpiresAt: nowMs + 30 * 86400e3,
      subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', ...over,
    },
  });
}

function setup(opts: { enabled?: Set<string>; runner?: LoginRunner; deps?: Record<string, unknown> } = {}) {
  const { db } = makeDb();
  const kms = new FakeKms();
  const enabled = opts.enabled ?? new Set(['user-1', 'user-2']);
  const tmpRoot = mkdtempSync(join(tmpdir(), 'aw-sub-test-'));
  let ids = 0;
  let tokens = 0;
  const runner = opts.runner ?? new LocalClaudeLoginRunner({ command: process.execPath, args: [FAKE, 'ok'], tmpRoot });
  const service = new ClaudeSubscriptionService({
    db, kms, runner, tmpRoot,
    isEnabledFor: async (u: string) => enabled.has(u),
    now: () => Date.now(),
    newId: () => `sub-${++ids}`,
    newToken: () => `tok-${++tokens}`,
    ...(opts.deps ?? {}),
  } as any);
  return { db, kms, service, enabled, tmpRoot };
}
const homeDirs = (root: string) => readdirSync(root).filter((n) => n.startsWith(HOME_DIR_PREFIX));
const loginDirs = (root: string) => readdirSync(root).filter((n) => n.startsWith(TMP_ROOT_PREFIX));

async function connect(ctx: ReturnType<typeof setup>, userId = 'user-1') {
  const { loginId } = await ctx.service.startLogin({ userId });
  return ctx.service.completeLogin({ userId }, loginId, GOOD);
}
async function seedLogin(ctx: ReturnType<typeof setup>, over: Record<string, unknown> = {}, text = credsText()) {
  const sealed = await sealSecret(ctx.kms, text, { connectionId: 'sub-x', ownerUserId: 'user-1', provider: 'anthropic', purpose: 'claude_login' });
  const now = new Date().toISOString();
  await ctx.db.create({
    connectionId: 'sub-x', ownerUserId: 'user-1', kind: 'claude_subscription', provider: 'anthropic', status: 'active', keyLast4: '', createdAt: now, updatedAt: now, sealed,
    subVersion: 1, subNeedsReconnect: false, subType: 'max', subRefreshExpiresAtMs: Date.now() + 30 * 86400e3, ...over,
  } as any);
  return text;
}

describe('parseCredentials', () => {
  it('reads plan and expiries only', () => {
    const { health } = parseCredentials(credsText(), Date.now());
    expect(health).toMatchObject({ type: 'max', tier: 'default_claude_max_20x' });
    expect(JSON.stringify(health)).not.toContain('SENTINEL');
  });
  it.each([
    ['not json', 'nope'], ['no oauth block', '{}'], ['no refresh token', credsText({ refreshToken: undefined })], ['no access token', credsText({ accessToken: '' })],
    ['refresh already expired', credsText({ refreshTokenExpiresAt: 1000 })], ['expiry not a number', credsText({ expiresAt: 'soon' })],
  ])('rejects %s', (_l, text) => {
    expect(() => parseCredentials(text, Date.now())).toThrow(ClaudeSubscriptionError);
  });
});

describe('the sign-in ceremony', () => {
  it('connects: stores the login sealed under the login context, returns a masked view, leaves no temp dir', async () => {
    const ctx = setup();
    const view = await connect(ctx);
    expect(view).toMatchObject({ connectionId: 'sub-1', kind: 'claude_subscription', provider: 'anthropic', status: 'active', keyLast4: '', ownedByCaller: true, subscription: { plan: 'max', needsReconnect: false } });
    expect(JSON.stringify(view)).not.toMatch(/SENTINEL|ciphertext|wrappedDataKey/);
    const row = (await ctx.db.get('sub-1'))!;
    expect(row).toMatchObject({ kind: 'claude_subscription', subVersion: 1, subNeedsReconnect: false, subType: 'max' });
    const opened = await openSecret(ctx.kms, row.sealed!, { connectionId: 'sub-1', ownerUserId: 'user-1', provider: 'anthropic', purpose: 'claude_login' });
    expect(JSON.parse(opened).claudeAiOauth.subscriptionType).toBe('max');
    await expect(openSecret(ctx.kms, row.sealed!, { connectionId: 'sub-1', ownerUserId: 'user-1', provider: 'anthropic' })).rejects.toBeTruthy();
    expect(loginDirs(ctx.tmpRoot)).toEqual([]);
    expect(ctx.service.pendingCount()).toBe(0);
  });

  it('is refused unless the user is individually enabled (the flag helper never honours *)', async () => {
    const ctx = setup({ enabled: new Set(['someone-else']) });
    expect(await codeOf(ctx.service.startLogin({ userId: 'user-1' }))).toBe('disabled');
    expect(await codeOf(ctx.service.completeLogin({ userId: 'user-1' }, 'x', GOOD))).toBe('disabled');
  });

  it('refuses a delegated admin session', async () => {
    const ctx = setup();
    expect(await codeOf(ctx.service.startLogin({ userId: 'user-1', adminId: 'admin-1' }))).toBe('forbidden');
    expect(await codeOf(ctx.service.completeLogin({ userId: 'user-1', adminId: 'admin-1' }, 'x', GOOD))).toBe('forbidden');
    expect(loginDirs(ctx.tmpRoot)).toEqual([]);
  });

  it('keeps one pending login per user: a new start cancels the old one', async () => {
    const ctx = setup();
    const a = await ctx.service.startLogin({ userId: 'user-1' });
    const b = await ctx.service.startLogin({ userId: 'user-1' });
    expect(ctx.service.pendingCount()).toBe(1);
    expect(loginDirs(ctx.tmpRoot)).toHaveLength(1);
    expect(await codeOf(ctx.service.completeLogin({ userId: 'user-1' }, a.loginId, GOOD))).toBe('login_not_found');
    await ctx.service.completeLogin({ userId: 'user-1' }, b.loginId, GOOD);
  });

  it('caps pending logins across users', async () => {
    const ctx = setup({ enabled: new Set(Array.from({ length: MAX_PENDING_LOGINS + 1 }, (_, i) => `u${i}`)) });
    for (let i = 0; i < MAX_PENDING_LOGINS; i++) await ctx.service.startLogin({ userId: `u${i}` });
    expect(await codeOf(ctx.service.startLogin({ userId: `u${MAX_PENDING_LOGINS}` }))).toBe('too_many_logins');
    await ctx.service.shutdown();
    expect(loginDirs(ctx.tmpRoot)).toEqual([]);
  });

  it('answers a wrong user like an unknown login and does NOT cancel the real one', async () => {
    const ctx = setup();
    const { loginId } = await ctx.service.startLogin({ userId: 'user-1' });
    expect(await codeOf(ctx.service.completeLogin({ userId: 'user-2' }, loginId, GOOD))).toBe('login_not_found');
    await ctx.service.cancelLogin({ userId: 'user-2' }, loginId);
    expect(ctx.service.pendingCount()).toBe(1);
    expect((await ctx.service.completeLogin({ userId: 'user-1' }, loginId, GOOD)).connectionId).toBe('sub-1');
  });

  it('keeps the login pending after a malformed code, but a wrong code ends it', async () => {
    const ctx = setup();
    const { loginId } = await ctx.service.startLogin({ userId: 'user-1' });
    expect(await codeOf(ctx.service.completeLogin({ userId: 'user-1' }, loginId, 'bad'))).toBe('bad_code_format');
    expect(ctx.service.pendingCount()).toBe(1);
    expect(await codeOf(ctx.service.completeLogin({ userId: 'user-1' }, loginId, 'WRONGCODE1#WRONGSTATE1'))).toBe('code_rejected');
    expect(ctx.service.pendingCount()).toBe(0);
    expect(loginDirs(ctx.tmpRoot)).toEqual([]);
    expect(await ctx.db.get('sub-1')).toBeNull();
  });

  it('a login can be completed only once', async () => {
    const ctx = setup();
    const { loginId } = await ctx.service.startLogin({ userId: 'user-1' });
    await ctx.service.completeLogin({ userId: 'user-1' }, loginId, GOOD);
    expect(await codeOf(ctx.service.completeLogin({ userId: 'user-1' }, loginId, GOOD))).toBe('login_not_found');
  });

  it('expires a pending login after its TTL and cancels it', async () => {
    jest.useFakeTimers();
    try {
      const cancel = jest.fn(async () => undefined);
      const handle: LoginHandle = { authorizeUrl: 'https://claude.com/x', complete: async () => '', cancel };
      const ctx = setup({ runner: { start: async () => handle } });
      const { loginId } = await ctx.service.startLogin({ userId: 'user-1' });
      await jest.advanceTimersByTimeAsync(LOGIN_TTL_MS - 1000);
      expect(ctx.service.pendingCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(2000);
      expect(ctx.service.pendingCount()).toBe(0);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(await codeOf(ctx.service.completeLogin({ userId: 'user-1' }, loginId, GOOD))).toBe('login_not_found');
    } finally { jest.useRealTimers(); }
  });

  it.each([['malformed'], ['crash']])('stores nothing when the CLI produced a bad credentials file (%s)', async (mode) => {
    const ctx = setup();
    const runner = new LocalClaudeLoginRunner({ command: process.execPath, args: [FAKE, mode], tmpRoot: ctx.tmpRoot });
    const svc = new ClaudeSubscriptionService({ ...(ctx.service as any).deps, runner });
    const { loginId } = await svc.startLogin({ userId: 'user-1' });
    expect(await codeOf(svc.completeLogin({ userId: 'user-1' }, loginId, GOOD))).toBe('bad_credentials');
    expect(await ctx.db.get('sub-1')).toBeNull();
    expect(loginDirs(ctx.tmpRoot)).toEqual([]);
  });

  it('fails cleanly when the CLI cannot start', async () => {
    const ctx = setup();
    const runner = new LocalClaudeLoginRunner({ command: process.execPath, args: [FAKE, 'nourl'], tmpRoot: ctx.tmpRoot });
    const svc = new ClaudeSubscriptionService({ ...(ctx.service as any).deps, runner });
    expect(await codeOf(svc.startLogin({ userId: 'user-1' }))).toBe('start_failed');
    expect(svc.pendingCount()).toBe(0);
  });

  it('respects the per-owner connection cap', async () => {
    const ctx = setup();
    for (let i = 0; i < 10; i++) await connect(ctx);
    expect(await codeOf((async () => { const { loginId } = await ctx.service.startLogin({ userId: 'user-1' }); return ctx.service.completeLogin({ userId: 'user-1' }, loginId, GOOD); })())).toBe('limit_reached');
  });

  it('does not log the code or any token', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = setup();
    await connect(ctx);
    const logged = [...log.mock.calls, ...err.mock.calls].flat().join(' ');
    log.mockRestore(); err.mockRestore();
    expect(logged).not.toMatch(/GOODCODE1|GOODSTATE1|SENTINEL/);
  });

  it('cannot be pushed past the pending cap by concurrent starts', async () => {
    const users = Array.from({ length: MAX_PENDING_LOGINS + 5 }, (_, i) => `u${i}`);
    const slow: LoginRunner = { start: async () => { await sleep(30); return { authorizeUrl: 'https://claude.com/x', complete: async () => '', cancel: async () => undefined }; } };
    const ctx = setup({ enabled: new Set(users), runner: slow });
    const results = await Promise.all(users.map((u) => codeOf(ctx.service.startLogin({ userId: u }))));
    expect(results.filter((r) => r === 'resolved')).toHaveLength(MAX_PENDING_LOGINS);
    expect(ctx.service.pendingCount()).toBe(MAX_PENDING_LOGINS);
    await ctx.service.shutdown();
  });

  it('tells the user to start again when the CLI went away before the code arrived', async () => {
    const { LoginError } = require('../claudeLoginRunner');
    const gone: LoginRunner = { start: async () => ({ authorizeUrl: 'https://claude.com/x', complete: async () => { throw new LoginError('login_gone'); }, cancel: async () => undefined }) };
    const ctx = setup({ runner: gone });
    const { loginId } = await ctx.service.startLogin({ userId: 'user-1' });
    expect(await codeOf(ctx.service.completeLogin({ userId: 'user-1' }, loginId, GOOD))).toBe('login_not_found');
  });

  describe('signing in again (reconnect in place)', () => {
    it('replaces the login, keeps the connection id, clears the flag', async () => {
      const ctx = setup();
      await connect(ctx);
      await ctx.service.reportDeadLogin('sub-1', 1, 'cli_login_expired');
      expect((await ctx.db.get('sub-1'))?.subNeedsReconnect).toBe(true);
      const { loginId } = await ctx.service.startLogin({ userId: 'user-1' }, { reconnectConnectionId: 'sub-1' } as any);
      const view = await ctx.service.completeLogin({ userId: 'user-1' }, loginId, GOOD);
      expect(view.connectionId).toBe('sub-1');
      expect(await ctx.db.get('sub-1')).toMatchObject({ subNeedsReconnect: false, subVersion: 2, status: 'active' });
    });
    it('only for your own, un-revoked Claude login', async () => {
      const ctx = setup();
      await connect(ctx);
      expect(await codeOf(ctx.service.startLogin({ userId: 'user-2' }, { reconnectConnectionId: 'sub-1' }))).toBe('not_found');
      expect(await codeOf(ctx.service.startLogin({ userId: 'user-1' }, { reconnectConnectionId: 'nope' }))).toBe('not_found');
    });
    it('is refused at the start, before the user spends a code, while a turn holds the live copy', async () => {
      const ctx = setup();
      await connect(ctx);
      await ctx.db.acquireSubLease('sub-1', 'someone', Date.now(), 60_000);
      expect(await codeOf(ctx.service.startLogin({ userId: 'user-1' }, { reconnectConnectionId: 'sub-1' }))).toBe('busy');
      expect(ctx.service.pendingCount()).toBe(0);
    });
    it('is busy while a turn holds the live copy', async () => {
      const ctx = setup();
      await connect(ctx);
      const { loginId } = await ctx.service.startLogin({ userId: 'user-1' }, { reconnectConnectionId: 'sub-1' });
      await ctx.db.acquireSubLease('sub-1', 'someone', Date.now(), 60_000);
      expect(await codeOf(ctx.service.completeLogin({ userId: 'user-1' }, loginId, GOOD))).toBe('busy');
    });
  });
});

describe('withLogin: the single live copy', () => {
  const rewrite = (configDir: string, text: string) => writeFileSync(join(configDir, '.credentials.json'), text);

  it('unseals into a private dir, runs, wipes, and releases the lease', async () => {
    const ctx = setup();
    const text = await seedLogin(ctx);
    let seen = '';
    let mode = 0;
    const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => {
      seen = readFileSync(join(configDir, '.credentials.json'), 'utf8');
      mode = statSync(join(configDir, '.credentials.json')).mode & 0o777;
      expect(statSync(configDir).mode & 0o077).toBe(0);
      return 42;
    });
    expect(res).toEqual({ value: 42, status: 'ok' });
    expect(seen).toBe(text);
    expect(mode).toBe(0o600);
    expect(homeDirs(ctx.tmpRoot)).toEqual([]);
    expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeUndefined();
    expect((await ctx.db.get('sub-x'))?.subVersion).toBe(1); // unchanged => nothing written
  });

  it('writes a refreshed login back at once, as a new version, sealed under the login context', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    const refreshed = credsText({ accessToken: 'SENTINEL-ACCESS-NEW', refreshToken: 'SENTINEL-REFRESH-NEW' });
    const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => {
      rewrite(configDir, refreshed);
      await sleep(SAVE_DEBOUNCE_MS + 300); // saved while the turn is still running, not only at the end
      expect((await ctx.db.get('sub-x'))?.subVersion).toBe(2);
    });
    expect(res.status).toBe('ok');
    const row = (await ctx.db.get('sub-x'))!;
    expect(JSON.parse(await openSecret(ctx.kms, row.sealed!, { connectionId: 'sub-x', ownerUserId: 'user-1', provider: 'anthropic', purpose: 'claude_login' })).claudeAiOauth.refreshToken).toBe('SENTINEL-REFRESH-NEW');
  });

  it('keeps saving across several refreshes in one turn (each save builds on the last version)', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => {
      rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-ONE' }));
      await sleep(SAVE_DEBOUNCE_MS + 300);
      rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-TWO' }));
      await sleep(SAVE_DEBOUNCE_MS + 300);
    });
    expect(res.status).toBe('ok');
    expect((await ctx.db.get('sub-x'))?.subVersion).toBe(3);
  });

  it('saves a change made right at the end of the turn too', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-LAST' })));
    expect((await ctx.db.get('sub-x'))?.subVersion).toBe(2);
  });

  it('does not save a half-written file', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => { rewrite(configDir, '{"claudeAiOauth":{"accessTo'); await sleep(SAVE_DEBOUNCE_MS + 200); });
    expect((await ctx.db.get('sub-x'))?.subVersion).toBe(1);
  });

  it('allows only one live copy: a second use is busy until the first finishes', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    let release!: () => void;
    let started!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const running = new Promise<void>((r) => (started = r));
    const first = ctx.service.withLogin('sub-x', 'user-1', async () => { started(); await hold; });
    await running; // the first turn really holds the lease now
    expect(await codeOf(ctx.service.withLogin('sub-x', 'user-1', async () => 1))).toBe('busy');
    release();
    await first;
    expect((await ctx.service.withLogin('sub-x', 'user-1', async () => 2)).value).toBe(2);
  });

  it('reports "lost" and aborts the caller when the stored version moved on under it (a stale save never lands)', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    let aborted = false;
    const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir, signal }) => {
      signal.addEventListener('abort', () => (aborted = true));
      // someone else changes the stored copy (version 1 -> 2) while we run
      await ctx.db.saveSubCredentials('sub-x', { owner: (await ctx.db.get('sub-x'))!.subLeaseOwner!, expectedVersion: 1, sealed: (await ctx.db.get('sub-x'))!.sealed!, health: { type: 'max', tier: '', accessExpiresAtMs: 1, refreshExpiresAtMs: Date.now() + 1e9 }, nowIso: new Date().toISOString() });
      rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-STALE' }));
      await sleep(SAVE_DEBOUNCE_MS + 300);
    });
    expect(res.status).toBe('lost');
    expect(aborted).toBe(true);
    const row = (await ctx.db.get('sub-x'))!;
    expect(row.subVersion).toBe(2);
    expect(JSON.stringify(row)).not.toContain('STALE');
  });

  it('reports "revoked", aborts, and writes nothing when the connection is revoked mid-turn', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    let aborted = false;
    const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir, signal }) => {
      signal.addEventListener('abort', () => (aborted = true));
      await ctx.db.revoke('sub-x', { userId: 'user-1' }, new Date().toISOString());
      rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-AFTER-REVOKE' }));
      await sleep(SAVE_DEBOUNCE_MS + 300);
    });
    expect(res.status).toBe('revoked');
    expect(aborted).toBe(true);
    const row = (await ctx.db.get('sub-x'))!;
    expect(row.sealed).toBeUndefined();
    expect(homeDirs(ctx.tmpRoot)).toEqual([]);
  });

  it('retries a transient save failure and then succeeds', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    const real = ctx.db.saveSubCredentials.bind(ctx.db);
    let calls = 0;
    jest.spyOn(ctx.db, 'saveSubCredentials').mockImplementation(async (...a) => { if (++calls === 1) throw new Error('throttled'); return real(...a); });
    const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-RETRY' })));
    expect(res.status).toBe('ok');
    expect((await ctx.db.get('sub-x'))?.subVersion).toBe(2);
    expect(calls).toBe(2);
  });

  describe('when saving back keeps failing', () => {
    const FAST = { persistRetryMs: 40, persistMaxMs: 400 };
    const failing = (ctx: ReturnType<typeof setup>) => jest.spyOn(ctx.db, 'saveSubCredentials').mockRejectedValue(new Error('dynamo down'));
    const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);

    it('keeps retrying in the background, still holding the lease, and cleans up once the save lands', async () => {
      const ctx = setup({ deps: FAST });
      await seedLogin(ctx);
      const real = ctx.db.saveSubCredentials.bind(ctx.db);
      const spy = failing(ctx);
      const err = quiet();
      const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-LATE' })));
      expect(res.status).toBe('save_failed');
      expect(homeDirs(ctx.tmpRoot)).toHaveLength(1);
      expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeDefined();
      spy.mockImplementation(real); // the store comes back
      await sleep(400);
      expect((await ctx.db.get('sub-x'))?.subVersion).toBe(2);
      expect(homeDirs(ctx.tmpRoot)).toEqual([]);
      expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeUndefined();
      expect(err.mock.calls.flat().join(' ')).not.toContain('SENTINEL');
      err.mockRestore();
    });

    it('wipes the dir and stops if the connection is revoked while it is still retrying', async () => {
      const ctx = setup({ deps: { persistRetryMs: 40, persistMaxMs: 5000 } });
      await seedLogin(ctx);
      const real = ctx.db.saveSubCredentials.bind(ctx.db);
      const spy = failing(ctx);
      const err = quiet();
      await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-REVOKED' })));
      await ctx.db.revoke('sub-x', { userId: 'user-1' }, new Date().toISOString());
      spy.mockImplementation(real);
      await sleep(400);
      expect(homeDirs(ctx.tmpRoot)).toEqual([]);
      err.mockRestore();
    });

    it('gives up after its window, keeps the only copy for boot recovery, and recovery then saves it', async () => {
      const ctx = setup({ deps: FAST });
      await seedLogin(ctx);
      const real = ctx.db.saveSubCredentials.bind(ctx.db);
      const spy = failing(ctx);
      const err = quiet();
      await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-ONLYCOPY' })));
      await sleep(1800); // past the window (each failing attempt backs off ~600 ms)
      expect(homeDirs(ctx.tmpRoot)).toHaveLength(1);
      err.mockRestore();
      spy.mockImplementation(real);
      // a new process: this one's own dir is only "active" while its run is live
      expect(await ctx.service.recoverOrphans()).toEqual({ saved: 1, wiped: 1, kept: 0 });
      expect(homeDirs(ctx.tmpRoot)).toEqual([]);
      expect((await ctx.db.get('sub-x'))?.subVersion).toBe(2);
      expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeUndefined();
    });

    it('recovery keeps the dir while the store is unreachable and wipes junk', async () => {
      const ctx = setup({ deps: FAST });
      await seedLogin(ctx);
      const err = quiet();
      const spy = failing(ctx);
      await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-KEEP' })));
      await sleep(1800);
      expect(await ctx.service.recoverOrphans()).toEqual({ saved: 0, wiped: 0, kept: 1 });
      expect(homeDirs(ctx.tmpRoot)).toHaveLength(1);
      mkdirSync(join(ctx.tmpRoot, `${HOME_DIR_PREFIX}junk`));
      spy.mockRestore();
      err.mockRestore();
      const out = await ctx.service.recoverOrphans();
      expect(out.wiped).toBeGreaterThanOrEqual(1);
    });
  });

  describe('recovery', () => {
    const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);

    it('saves the NEWEST login after an earlier save in the same turn (the marker follows the version)', async () => {
      const ctx = setup({ deps: { persistRetryMs: 40, persistMaxMs: 300 } });
      await seedLogin(ctx);
      const real = ctx.db.saveSubCredentials.bind(ctx.db);
      let calls = 0;
      const err = quiet();
      const spy = jest.spyOn(ctx.db, 'saveSubCredentials').mockImplementation(async (...a) => { if (++calls > 1) throw new Error('down'); return real(...a); });
      await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => {
        rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-ONE' }));
        await sleep(SAVE_DEBOUNCE_MS + 300); // saved: version 2
        rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-TWO' })); // this one never reaches the store
      });
      await sleep(1800); // past the background window (each failing attempt backs off ~600 ms)
      err.mockRestore();
      spy.mockImplementation(real);
      expect(JSON.parse(readFileSync(join(ctx.tmpRoot, homeDirs(ctx.tmpRoot)[0], 'marker.json'), 'utf8')).version).toBe(2);
      expect(await ctx.service.recoverOrphans()).toMatchObject({ saved: 1 });
      expect((await ctx.db.get('sub-x'))?.subVersion).toBe(3);
      const row = (await ctx.db.get('sub-x'))!;
      expect(JSON.parse(await openSecret(ctx.kms, row.sealed!, { connectionId: 'sub-x', ownerUserId: 'user-1', provider: 'anthropic', purpose: 'claude_login' })).claudeAiOauth.refreshToken).toBe('SENTINEL-REFRESH-TWO');
    });

    it('builds on the stored version when the marker lags it and the lease is still the recorded owner\'s', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      await ctx.db.acquireSubLease('sub-x', 'owner-old', Date.now(), 60_000);
      const dir = join(ctx.tmpRoot, `${HOME_DIR_PREFIX}lag`);
      mkdirSync(join(dir, 'cfg'), { recursive: true });
      writeFileSync(join(dir, 'cfg', '.credentials.json'), credsText({ refreshToken: 'SENTINEL-REFRESH-LAG' }));
      writeFileSync(join(dir, 'marker.json'), JSON.stringify({ connectionId: 'sub-x', owner: 'owner-old', version: 0, ownerUserId: 'user-1', pid: 999999 }));
      expect(await ctx.service.recoverOrphans()).toMatchObject({ saved: 1, wiped: 1 });
      expect((await ctx.db.get('sub-x'))?.subVersion).toBe(2);
    });

    it('does not build on a stored version that is more than one save ahead of the marker (not ours to overwrite)', async () => {
      const ctx = setup();
      await seedLogin(ctx, { subVersion: 5 });
      await ctx.db.acquireSubLease('sub-x', 'owner-old', Date.now(), 60_000);
      const dir = join(ctx.tmpRoot, `${HOME_DIR_PREFIX}far`);
      mkdirSync(join(dir, 'cfg'), { recursive: true });
      writeFileSync(join(dir, 'cfg', '.credentials.json'), credsText({ refreshToken: 'SENTINEL-REFRESH-FAR' }));
      writeFileSync(join(dir, 'marker.json'), JSON.stringify({ connectionId: 'sub-x', owner: 'owner-old', version: 2, ownerUserId: 'user-1', pid: 999999 }));
      expect(await ctx.service.recoverOrphans()).toMatchObject({ saved: 0, wiped: 1 });
      expect((await ctx.db.get('sub-x'))?.subVersion).toBe(5);
    });

    it('does not touch a dir whose recording process is still alive, but cleans one whose process is gone', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      const mk = (name: string, pid: number) => {
        const dir = join(ctx.tmpRoot, `${HOME_DIR_PREFIX}${name}`);
        mkdirSync(join(dir, 'cfg'), { recursive: true });
        writeFileSync(join(dir, 'cfg', '.credentials.json'), credsText({ refreshToken: `SENTINEL-${name}` }));
        writeFileSync(join(dir, 'marker.json'), JSON.stringify({ connectionId: 'sub-x', owner: 'nobody', version: 1, ownerUserId: 'user-1', pid }));
        return dir;
      };
      const alive = mk('alive', process.ppid);
      const dead = mk('dead', 999999);
      await ctx.service.recoverOrphans();
      expect(existsSync(alive)).toBe(true);
      expect(existsSync(dead)).toBe(false);
    });

    it('removes stale sign-in dirs and keeps fresh ones', async () => {
      const ctx = setup();
      const stale = join(ctx.tmpRoot, `${TMP_ROOT_PREFIX}old`);
      const fresh = join(ctx.tmpRoot, `${TMP_ROOT_PREFIX}new`);
      mkdirSync(stale); mkdirSync(fresh);
      const old = new Date(Date.now() - 2 * 3600e3);
      utimesSync(stale, old, old);
      await ctx.service.recoverOrphans();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    });

    it('the boot hook does nothing, and builds nothing, when no such dir exists', async () => {
      const root = mkdtempSync(join(tmpdir(), 'aw-boot-empty-'));
      expect(await recoverClaudeSubscriptionOrphansAtBoot(root)).toBeNull();
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe('after a reconnect and other edge cases (second review)', () => {
    const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => undefined);

    it('recovery never overwrites a login the user has since reconnected', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      // a process died holding a refreshed login: its dir and marker remain, its lease lapsed
      await ctx.db.acquireSubLease('sub-x', 'dead-owner', Date.now() - 200_000, 90_000);
      const dir = join(ctx.tmpRoot, `${HOME_DIR_PREFIX}dead`);
      mkdirSync(join(dir, 'cfg'), { recursive: true });
      writeFileSync(join(dir, 'cfg', '.credentials.json'), credsText({ refreshToken: 'SENTINEL-REFRESH-DEADPROC' }));
      writeFileSync(join(dir, 'marker.json'), JSON.stringify({ connectionId: 'sub-x', owner: 'dead-owner', version: 1, ownerUserId: 'user-1', pid: 999999 }));
      // the user reconnects meanwhile
      expect(await ctx.db.replaceSubCredentials('sub-x', { expectedVersion: 1, sealed: (await ctx.db.get('sub-x'))!.sealed!, health: { type: 'max', tier: '', accessExpiresAtMs: 1, refreshExpiresAtMs: Date.now() + 1e9 }, nowMs: Date.now(), nowIso: new Date().toISOString() })).toBe(true);
      expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeUndefined();
      const before = (await ctx.db.get('sub-x'))!;
      expect(await ctx.service.recoverOrphans()).toMatchObject({ saved: 0, wiped: 1 });
      const after = (await ctx.db.get('sub-x'))!;
      expect(after.subVersion).toBe(before.subVersion);
      expect(after.sealed).toEqual(before.sealed);
    });

    it('a synchronous throw from the caller still stops the timers, wipes the dir and releases the lease', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      await expect(ctx.service.withLogin('sub-x', 'user-1', (() => { throw new Error('sync boom'); }) as any)).rejects.toThrow('sync boom');
      expect(homeDirs(ctx.tmpRoot)).toEqual([]);
      expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeUndefined();
    });

    it('recovers a lost response on the LAST attempt of a save, not only the first (attempts are tracked per run)', async () => {
      const ctx = setup({ deps: { persistRetryMs: 40, persistMaxMs: 3000 } });
      await seedLogin(ctx);
      const real = ctx.db.saveSubCredentials.bind(ctx.db);
      let calls = 0;
      const err = quiet();
      jest.spyOn(ctx.db, 'saveSubCredentials').mockImplementation(async (...a) => {
        calls++;
        if (calls < 3) throw new Error('down');
        if (calls === 3) { await real(...a); throw new Error('response lost after commit'); }
        return real(...a);
      });
      let aborted = false;
      const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir, signal }) => {
        signal.addEventListener('abort', () => (aborted = true));
        rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-LASTATTEMPT' }));
      });
      expect(res.status).toBe('save_failed');
      await sleep(900); // background retry sees "stale" and recognises its own earlier write
      err.mockRestore();
      expect(aborted).toBe(false);
      expect((await ctx.db.get('sub-x'))?.subVersion).toBe(2);
      expect(homeDirs(ctx.tmpRoot)).toEqual([]);
    });

    it('does not lose the NEWEST login when an older refresh of the same run landed with a lost response', async () => {
      const ctx = setup({ deps: { persistRetryMs: 40, persistMaxMs: 3000 } });
      await seedLogin(ctx);
      const real = ctx.db.saveSubCredentials.bind(ctx.db);
      let calls = 0;
      const err = quiet();
      jest.spyOn(ctx.db, 'saveSubCredentials').mockImplementation(async (...a) => {
        calls++;
        if (calls < 3) throw new Error('down');
        if (calls === 3) { await real(...a); throw new Error('response lost after commit'); } // login A committed, no answer
        return real(...a);
      });
      const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => {
        rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-A' }));
        await sleep(1100); // all three attempts for A are over
        rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-B' })); // the CLI refreshed again
      });
      err.mockRestore();
      expect(res.status).toBe('ok');
      const row = (await ctx.db.get('sub-x'))!;
      expect(row.subVersion).toBe(3); // A then B on top, nothing dropped
      expect(JSON.parse(await openSecret(ctx.kms, row.sealed!, { connectionId: 'sub-x', ownerUserId: 'user-1', provider: 'anthropic', purpose: 'claude_login' })).claudeAiOauth.refreshToken).toBe('SENTINEL-REFRESH-B');
    });

    it('a failed READ while checking a stale save is retried, never read as a lost login', async () => {
      const ctx = setup({ deps: { persistRetryMs: 40, persistMaxMs: 4000 } });
      await seedLogin(ctx);
      const realSave = ctx.db.saveSubCredentials.bind(ctx.db);
      const realGet = ctx.db.get.bind(ctx.db);
      let saves = 0;
      let armed = false;
      let readFailures = 0;
      let afterStale = false;
      const err = quiet();
      jest.spyOn(ctx.db, 'saveSubCredentials').mockImplementation(async (...a) => {
        saves++;
        if (saves < 3) throw new Error('down');
        if (saves === 3) { await realSave(...a); throw new Error('response lost after commit'); } // login A committed, no answer
        const r = await realSave(...a); // later retries: stale (A is already stored)
        if (r === 'stale' && armed) afterStale = true;
        return r;
      });
      // Fail the read the SERVICE makes right after the store reports "stale" (to check whether the stored copy is its own
      // earlier write): the store's own internal read happens before it returns, so the next read is the service's.
      jest.spyOn(ctx.db, 'get').mockImplementation(async (id: string) => {
        if (armed && afterStale && readFailures === 0) { afterStale = false; readFailures++; throw new Error('read blip'); } // once
        return realGet(id);
      });
      let aborted = false;
      const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir, signal }) => {
        armed = true;
        signal.addEventListener('abort', () => (aborted = true));
        rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-A' }));
        await sleep(SAVE_DEBOUNCE_MS + 900); // all three attempts are over: the save is reported failed
      });
      expect(['ok', 'save_failed']).toContain(res.status); // depends on how many file-watch events fire; both are legitimate
      await sleep(1500); // any background retry meets "stale", its read fails once, then succeeds and adopts A
      err.mockRestore();
      expect(readFailures).toBeGreaterThanOrEqual(1);
      expect(aborted).toBe(false); // a failed read is not a lost login
      const row = (await realGet('sub-x'))!;
      expect(row.subVersion).toBe(2);
      expect(homeDirs(ctx.tmpRoot)).toEqual([]); // saved, so the dir was wiped and the lease released
      expect(row.subLeaseOwner).toBeUndefined();
    });

    it('a revoke in this process stops the running holder at once, as revoked, and wipes the login dir', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      let aborted = false;
      let started!: () => void;
      const running = new Promise<void>((r) => (started = r));
      const p = ctx.service.withLogin('sub-x', 'user-1', async ({ signal }) => {
        signal.addEventListener('abort', () => (aborted = true));
        started();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      });
      await running;
      const t0 = Date.now();
      ctx.service.abortConnection('sub-x');
      const res = await p;
      expect(aborted).toBe(true);
      expect(res.status).toBe('revoked');
      expect(Date.now() - t0).toBeLessThan(2000); // not the next heartbeat (30 s)
      expect(homeDirs(ctx.tmpRoot)).toEqual([]);
    });

    it('a reconnect is refused BEFORE the one-time code is spent when a turn has started meanwhile', async () => {
      const ctx = setup();
      await connect(ctx);
      const { loginId } = await ctx.service.startLogin({ userId: 'user-1' }, { reconnectConnectionId: 'sub-1' });
      await ctx.db.acquireSubLease('sub-1', 'a-turn', Date.now(), 60_000);
      expect(await codeOf(ctx.service.completeLogin({ userId: 'user-1' }, loginId, GOOD))).toBe('busy');
      expect(ctx.service.pendingCount()).toBe(1); // the sign-in is still pending: the code was not consumed
      await ctx.db.releaseSubLease('sub-1', 'a-turn');
      expect((await ctx.service.completeLogin({ userId: 'user-1' }, loginId, GOOD)).connectionId).toBe('sub-1');
    });

    it('recovery leaves a login dir recorded by another host alone while it is fresh', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      const dir = join(ctx.tmpRoot, `${HOME_DIR_PREFIX}foreign`);
      mkdirSync(join(dir, 'cfg'), { recursive: true });
      writeFileSync(join(dir, 'cfg', '.credentials.json'), credsText({ refreshToken: 'SENTINEL-REFRESH-FOREIGN' }));
      writeFileSync(join(dir, 'marker.json'), JSON.stringify({ connectionId: 'sub-x', owner: 'x', version: 1, ownerUserId: 'user-1', pid: 999999, host: 'some-other-machine' }));
      await ctx.service.recoverOrphans();
      expect(existsSync(dir)).toBe(true);
    });

    it('recovery leaves a young dir with no marker yet alone (a run still setting up), but removes an old one', async () => {
      const ctx = setup();
      const young = join(ctx.tmpRoot, `${HOME_DIR_PREFIX}young`);
      const old = join(ctx.tmpRoot, `${HOME_DIR_PREFIX}old`);
      mkdirSync(join(young, 'cfg'), { recursive: true });
      mkdirSync(join(old, 'cfg'), { recursive: true });
      const t = new Date(Date.now() - 3600e3);
      utimesSync(old, t, t);
      await ctx.service.recoverOrphans();
      expect(existsSync(young)).toBe(true);
      expect(existsSync(old)).toBe(false);
    });
  });

  describe('a response that never arrived', () => {
    it('is not mistaken for a lost login: the retry finds our own write already stored', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      const real = ctx.db.saveSubCredentials.bind(ctx.db);
      let calls = 0;
      jest.spyOn(ctx.db, 'saveSubCredentials').mockImplementation(async (...a) => {
        if (++calls === 1) { await real(...a); throw new Error('timeout after commit'); }
        return real(...a);
      });
      let aborted = false;
      const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir, signal }) => {
        signal.addEventListener('abort', () => (aborted = true));
        rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-COMMITTED' }));
        await sleep(SAVE_DEBOUNCE_MS + 700);
      });
      expect(res.status).toBe('ok');
      expect(aborted).toBe(false);
      expect((await ctx.db.get('sub-x'))?.subVersion).toBe(2);
    });
  });

  describe('a caller that ignores the abort', () => {
    it('is not waited for forever: withLogin returns after the grace period, wipes the dir, and does not release the lease', async () => {
      const ctx = setup({ deps: { abortGraceMs: 200 } });
      await seedLogin(ctx);
      const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const t0 = Date.now();
      const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => {
        await ctx.db.revoke('sub-x', { userId: 'user-1' }, new Date().toISOString());
        rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-IGNORED' }));
        await new Promise(() => undefined); // never stops
      });
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(res.status).toBe('revoked');
      expect(homeDirs(ctx.tmpRoot)).toEqual([]);
      err.mockRestore();
    });
  });

  describe('setting up', () => {
    it('releases the lease and leaves no dir when the temp dir cannot be created', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      const notADir = join(ctx.tmpRoot, 'a-file');
      writeFileSync(notADir, 'x');
      const svc = new ClaudeSubscriptionService({ ...(ctx.service as any).deps, tmpRoot: notADir });
      await expect(svc.withLogin('sub-x', 'user-1', async () => 1)).rejects.toBeTruthy();
      expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeUndefined();
      expect(await codeOf(ctx.service.withLogin('sub-x', 'user-1', async () => 2))).toBe('resolved');
    });

    it('tells the caller which version its changes build on, and it moves up after a save', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      const seen: number[] = [];
      await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir, version }) => {
        seen.push(version());
        rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-VER' }));
        await sleep(SAVE_DEBOUNCE_MS + 300);
        seen.push(version());
      });
      expect(seen).toEqual([1, 2]);
    });
  });

  it('still saves and cleans up, then rethrows, when the caller throws', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    await expect(
      ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => { rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-THROW' })); throw new Error('turn failed'); }),
    ).rejects.toThrow('turn failed');
    expect((await ctx.db.get('sub-x'))?.subVersion).toBe(2);
    expect(homeDirs(ctx.tmpRoot)).toEqual([]);
    expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeUndefined();
  });

  describe('lease timing', () => {
    afterEach(() => jest.useRealTimers());

    it('extends the lease while the turn runs', async () => {
      jest.useFakeTimers();
      const ctx = setup();
      await seedLogin(ctx);
      const p = ctx.service.withLogin('sub-x', 'user-1', async () => { await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 3 + 1000)); });
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS * 3 + 2000);
      const res = await p;
      expect(res.status).toBe('ok');
    });

    it('aborts the caller when the lease can no longer be confirmed (store unreachable past the skew margin)', async () => {
      jest.useFakeTimers();
      const ctx = setup();
      await seedLogin(ctx);
      jest.spyOn(ctx.db, 'extendSubLease').mockRejectedValue(new Error('down'));
      let aborted = false;
      const p = ctx.service.withLogin('sub-x', 'user-1', async ({ signal }) => {
        signal.addEventListener('abort', () => (aborted = true));
        await new Promise((r) => setTimeout(r, LEASE_MS + 5000));
      });
      await jest.advanceTimersByTimeAsync(LEASE_MS - 20_000);
      expect(aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(aborted).toBe(true);
      await jest.advanceTimersByTimeAsync(10_000);
      expect((await p).status).toBe('lost');
    });

    it('reports "revoked" (not just "lost") when the heartbeat finds the connection was revoked from another process', async () => {
      jest.useFakeTimers();
      const ctx = setup();
      await seedLogin(ctx);
      // A real store answers in milliseconds, not instantly: make the heartbeat's read slow so the order matters.
      const realGet = ctx.db.get.bind(ctx.db);
      let slow = false;
      jest.spyOn(ctx.db, 'get').mockImplementation(async (id: string) => { if (slow) await new Promise((r) => setTimeout(r, 300)); return realGet(id); });
      let aborted = false;
      const p = ctx.service.withLogin('sub-x', 'user-1', async ({ signal }) => {
        signal.addEventListener('abort', () => (aborted = true));
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      });
      await jest.advanceTimersByTimeAsync(1000);
      slow = true;
      await ctx.db.revoke('sub-x', { userId: 'user-1' }, new Date().toISOString()); // another instance's revoke: no in-process hook here
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS + 1000);
      expect(aborted).toBe(true);
      expect((await p).status).toBe('revoked');
      expect(homeDirs(ctx.tmpRoot)).toEqual([]);
    });

    it('stops the caller at once on a lost lease even when the follow-up read hangs, then ends as "lost" after its deadline', async () => {
      jest.useFakeTimers();
      const ctx = setup();
      await seedLogin(ctx);
      const realGet = ctx.db.get.bind(ctx.db);
      let hang = false;
      jest.spyOn(ctx.db, 'get').mockImplementation((id: string) => (hang ? new Promise(() => undefined) : realGet(id)));
      let abortedAt = -1;
      const t0 = Date.now();
      const p = ctx.service.withLogin('sub-x', 'user-1', async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => { abortedAt = Date.now() - t0; resolve(); }));
      });
      await jest.advanceTimersByTimeAsync(1000);
      hang = true;
      await ctx.db.revoke('sub-x', { userId: 'user-1' }, new Date().toISOString());
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS + 500);
      expect(abortedAt).toBeGreaterThan(0); // stopped at the heartbeat, not after the hung read
      expect(abortedAt).toBeLessThan(HEARTBEAT_MS + 600);
      await jest.advanceTimersByTimeAsync(8000); // the read's deadline passes, the run asks once more, and that one times out too
      expect((await p).status).toBe('lost');
    });

    it('still reports "revoked" when the first "why was the lease lost?" read failed but the row was revoked by the end', async () => {
      jest.useFakeTimers();
      const ctx = setup();
      await seedLogin(ctx);
      const realGet = ctx.db.get.bind(ctx.db);
      let down = false;
      jest.spyOn(ctx.db, 'extendSubLease').mockRejectedValue(new Error('store down')); // the heartbeat cannot renew: the watchdog will stop the run
      jest.spyOn(ctx.db, 'get').mockImplementation(async (id: string) => {
        if (down) { await new Promise((r) => setTimeout(r, 1000)); throw new Error('store down'); }
        return realGet(id);
      });
      let aborted = false;
      const p = ctx.service.withLogin('sub-x', 'user-1', async ({ signal }) => {
        signal.addEventListener('abort', () => (aborted = true));
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      });
      await jest.advanceTimersByTimeAsync(LEASE_MS - 20_000);
      down = true; // from now the store is unreachable for reads too
      await jest.advanceTimersByTimeAsync(15_000); // the watchdog fires: stop, and the first lookup starts (and will fail)
      expect(aborted).toBe(true);
      await ctx.db.revoke('sub-x', { userId: 'user-1' }, new Date().toISOString());
      await jest.advanceTimersByTimeAsync(500);
      down = false; // the store is back before the first lookup has failed
      await jest.advanceTimersByTimeAsync(2500); // first lookup fails; the run asks once more and now gets the answer
      expect((await p).status).toBe('revoked');
    });

    it('a caller that ignores the abort is still reported "revoked" when the lease was lost to a revoke (the grace path waits for the answer)', async () => {
      jest.useFakeTimers();
      const ctx = setup({ deps: { abortGraceMs: 100 } });
      await seedLogin(ctx);
      const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const realGet = ctx.db.get.bind(ctx.db);
      let slow = false;
      jest.spyOn(ctx.db, 'get').mockImplementation(async (id: string) => { if (slow) await new Promise((r) => setTimeout(r, 400)); return realGet(id); });
      const p = ctx.service.withLogin('sub-x', 'user-1', async () => { await new Promise(() => undefined); }); // never stops
      await jest.advanceTimersByTimeAsync(1000);
      slow = true;
      await ctx.db.revoke('sub-x', { userId: 'user-1' }, new Date().toISOString());
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS + 1000); // heartbeat sees the lost lease, stops the caller; grace (100 ms) ends before the 400 ms read
      await jest.advanceTimersByTimeAsync(2000);
      expect((await p).status).toBe('revoked');
      err.mockRestore();
    });

    it('aborts when another holder has taken the lease', async () => {
      jest.useFakeTimers();
      const ctx = setup();
      await seedLogin(ctx);
      let aborted = false;
      const p = ctx.service.withLogin('sub-x', 'user-1', async ({ signal }) => {
        signal.addEventListener('abort', () => (aborted = true));
        await new Promise((r) => setTimeout(r, HEARTBEAT_MS * 2));
      });
      await jest.advanceTimersByTimeAsync(1000);
      await ctx.db.releaseSubLease('sub-x', (await ctx.db.get('sub-x'))!.subLeaseOwner!);
      await ctx.db.acquireSubLease('sub-x', 'thief', Date.now(), LEASE_MS);
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS + 1000);
      expect(aborted).toBe(true);
      await jest.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect((await p).status).toBe('lost');
    });
  });

  describe('who may use it', () => {
    it('refuses another user, a missing connection and an API key row, all as not found', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      await ctx.db.create({ connectionId: 'key-1', ownerUserId: 'user-1', kind: 'api_key', provider: 'anthropic', status: 'active', keyLast4: 'abcd', createdAt: 'x', updatedAt: 'x', sealed: (await ctx.db.get('sub-x'))!.sealed } as any);
      expect(await codeOf(ctx.service.withLogin('sub-x', 'user-2', async () => 1))).toBe('not_found');
      expect(await codeOf(ctx.service.withLogin('nope', 'user-1', async () => 1))).toBe('not_found');
      expect(await codeOf(ctx.service.withLogin('key-1', 'user-1', async () => 1))).toBe('not_found');
      expect(homeDirs(ctx.tmpRoot)).toEqual([]);
    });
    it('refuses when the flag is off, when it needs reconnecting, and when expired or revoked', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      ctx.enabled.delete('user-1');
      expect(await codeOf(ctx.service.withLogin('sub-x', 'user-1', async () => 1))).toBe('disabled');
      ctx.enabled.add('user-1');
      await ctx.service.reportDeadLogin('sub-x', 1, 'cli_login_expired');
      expect(await codeOf(ctx.service.withLogin('sub-x', 'user-1', async () => 1))).toBe('needs_reconnect');
      const ctx2 = setup();
      await seedLogin(ctx2, { status: 'expired' });
      expect(await codeOf(ctx2.service.withLogin('sub-x', 'user-1', async () => 1))).toBe('not_usable');
      const ctx3 = setup();
      await seedLogin(ctx3);
      await ctx3.db.revoke('sub-x', { userId: 'user-1' }, new Date().toISOString());
      expect(await codeOf(ctx3.service.withLogin('sub-x', 'user-1', async () => 1))).toBe('not_found');
    });
    it('releases the lease and leaves no dir when the sealed login cannot be opened', async () => {
      const ctx = setup();
      await seedLogin(ctx);
      const other = await sealSecret(ctx.kms, credsText(), { connectionId: 'someone-else', ownerUserId: 'user-1', provider: 'anthropic', purpose: 'claude_login' });
      await (ctx.db as any).client.update({ TableName: require('../llmConnectionDb').LLM_CONNECTIONS_TABLE, Key: { connectionId: 'sub-x' }, UpdateExpression: 'SET sealed = :s', ExpressionAttributeValues: { ':s': other } }).promise();
      await expect(ctx.service.withLogin('sub-x', 'user-1', async () => 1)).rejects.toBeTruthy();
      expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeUndefined();
      expect(homeDirs(ctx.tmpRoot)).toEqual([]);
    });
  });
});

describe('expiry', () => {
  it('expires only active logins past their fixed refresh lifetime and counts those about to', async () => {
    const ctx = setup();
    const now = Date.now();
    const mk = (id: string, ms: number, over: Record<string, unknown> = {}) =>
      ctx.db.create({ connectionId: id, ownerUserId: 'user-1', kind: 'claude_subscription', provider: 'anthropic', status: 'active', keyLast4: '', createdAt: 'x', updatedAt: 'x', sealed: { v: 1, wrappedDataKey: 'w', iv: 'i', ciphertext: 'c', tag: 't' }, subVersion: 1, subNeedsReconnect: false, subRefreshExpiresAtMs: now + ms, ...over } as any);
    await mk('past', -1000); await mk('soon2', 86400e3); await mk('soon7', 5 * 86400e3); await mk('far', 20 * 86400e3);
    await mk('revoked', -1000, { revokedAt: 'x', status: 'revoked' });
    expect(await ctx.service.expiryPass()).toEqual({ expired: 1, within7Days: 1, within2Days: 1, soon: [{ connectionId: 'soon2', daysLeft: 1 }, { connectionId: 'soon7', daysLeft: 5 }] });
    expect((await ctx.db.get('past'))?.status).toBe('expired');
    expect((await ctx.db.get('far'))?.status).toBe('active');
    expect(await ctx.service.expiryPass()).toMatchObject({ expired: 0, within7Days: 1, within2Days: 1 });
  });
});
