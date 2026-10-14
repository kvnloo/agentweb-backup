/**
 * ENG-2110 (B3): connecting a Claude login, and holding its single live copy.
 * In-memory store + KMS; the CLI is a stand-in script, so no real login happens in CI.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openSecret, sealSecret } from '../llmConnectionCrypto';
import { LocalClaudeLoginRunner, TMP_ROOT_PREFIX, type LoginHandle, type LoginRunner } from '../claudeLoginRunner';
import {
  ClaudeSubscriptionError, ClaudeSubscriptionService, HEARTBEAT_MS, HOME_DIR_PREFIX, LEASE_MS, LOGIN_TTL_MS, MAX_PENDING_LOGINS, parseCredentials, SAVE_DEBOUNCE_MS,
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

function setup(opts: { enabled?: Set<string>; runner?: LoginRunner } = {}) {
  const { db } = makeDb();
  const kms = new FakeKms();
  const enabled = opts.enabled ?? new Set(['user-1', 'user-2']);
  const tmpRoot = mkdtempSync(join(tmpdir(), 'aw-sub-test-'));
  let ids = 0;
  let tokens = 0;
  const runner = opts.runner ?? new LocalClaudeLoginRunner({ command: process.execPath, args: [FAKE, 'ok'], tmpRoot });
  const service = new ClaudeSubscriptionService({
    db, kms, runner, tmpRoot,
    isEnabledFor: async (u) => enabled.has(u),
    now: () => Date.now(),
    newId: () => `sub-${++ids}`,
    newToken: () => `tok-${++tokens}`,
  });
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
    const hold = new Promise<void>((r) => (release = r));
    const first = ctx.service.withLogin('sub-x', 'user-1', async () => { await hold; });
    await sleep(50);
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

  it('keeps the refreshed login (private) and the lease when every save fails, and boot recovery then saves it', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    const real = ctx.db.saveSubCredentials.bind(ctx.db);
    const spy = jest.spyOn(ctx.db, 'saveSubCredentials').mockRejectedValue(new Error('dynamo down'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-ONLYCOPY' })));
    expect(res.status).toBe('save_failed');
    expect(homeDirs(ctx.tmpRoot)).toHaveLength(1);
    expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeDefined();
    expect(err.mock.calls.flat().join(' ')).not.toContain('SENTINEL');
    err.mockRestore();
    spy.mockImplementation(real);
    expect(await ctx.service.recoverOrphans()).toEqual({ saved: 1, wiped: 1, kept: 0 });
    expect(homeDirs(ctx.tmpRoot)).toEqual([]);
    expect((await ctx.db.get('sub-x'))?.subVersion).toBe(2);
    expect((await ctx.db.get('sub-x'))?.subLeaseOwner).toBeUndefined();
  });

  it('recovery keeps the dir when the store is unreachable, and wipes junk', async () => {
    const ctx = setup();
    await seedLogin(ctx);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(ctx.db, 'saveSubCredentials').mockRejectedValue(new Error('down'));
    await ctx.service.withLogin('sub-x', 'user-1', async ({ configDir }) => rewrite(configDir, credsText({ refreshToken: 'SENTINEL-REFRESH-KEEP' })));
    expect(await ctx.service.recoverOrphans()).toEqual({ saved: 0, wiped: 0, kept: 1 });
    expect(homeDirs(ctx.tmpRoot)).toHaveLength(1);
    require('fs').mkdirSync(join(ctx.tmpRoot, `${HOME_DIR_PREFIX}junk`));
    (ctx.db.saveSubCredentials as jest.Mock).mockRestore();
    const out = await ctx.service.recoverOrphans();
    expect(out.wiped).toBeGreaterThanOrEqual(1);
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
    expect(await ctx.service.expiryPass()).toEqual({ expired: 1, within7Days: 1, within2Days: 1 });
    expect((await ctx.db.get('past'))?.status).toBe('expired');
    expect((await ctx.db.get('far'))?.status).toBe('active');
    expect(await ctx.service.expiryPass()).toEqual({ expired: 0, within7Days: 1, within2Days: 1 });
  });
});
