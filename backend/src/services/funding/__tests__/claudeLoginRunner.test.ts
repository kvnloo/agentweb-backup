/** ENG-2110 (B3): the login ceremony runner against a stand-in `claude` (no real login in CI). */
import { existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LocalClaudeLoginRunner, LoginError, TMP_ROOT_PREFIX, CODE_PATTERN, resolveClaudeBinary, sweepStaleLoginDirs } from '../claudeLoginRunner';

const FAKE = join(__dirname, 'fixtures', 'fakeClaudeLogin.js');
const GOOD = 'GOODCODE1#GOODSTATE1';
let root: string;
const runner = (mode: string, extra: Record<string, unknown> = {}) =>
  new LocalClaudeLoginRunner({ command: process.execPath, args: [FAKE, mode], tmpRoot: root, ...extra });
const leftovers = () => readdirSync(root).filter((n) => n.startsWith(TMP_ROOT_PREFIX));
const thrownCode = (p: Promise<unknown>) => p.then(() => 'resolved', (e) => (e instanceof LoginError ? e.code : `unexpected:${e?.message}`));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aw-test-root-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('LocalClaudeLoginRunner', () => {
  it('returns the authorize URL, then the credentials file the CLI wrote, and wipes the dir', async () => {
    const handle = await runner('ok').start();
    expect(handle.authorizeUrl).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    expect(leftovers()).toHaveLength(1);
    const text = await handle.complete(GOOD);
    expect(JSON.parse(text).claudeAiOauth.subscriptionType).toBe('max');
    expect(leftovers()).toHaveLength(0);
  });

  it('runs the CLI with an allowlisted environment only: no backend env, no ANTHROPIC_*, no AWS keys', async () => {
    process.env.AWS_SECRET_ACCESS_KEY = 'AWS-SENTINEL'; process.env.ANTHROPIC_API_KEY = 'ANTHROPIC-SENTINEL'; process.env.OPENROUTER_API_KEY = 'OR-SENTINEL';
    try {
      const creds = JSON.parse(await (await runner('ok').start()).complete(GOOD));
      const keys: string[] = creds._env;
      expect(keys.filter((k) => /AWS|ANTHROPIC|OPENROUTER|SECRET|_KEY/.test(k))).toEqual([]);
      expect(keys).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'HOME', 'PATH']));
      expect(creds._config).toContain(TMP_ROOT_PREFIX);
    } finally {
      delete process.env.AWS_SECRET_ACCESS_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('rejects a wrong code, wipes the dir, and the handle cannot be reused', async () => {
    const handle = await runner('wrong').start();
    expect(await thrownCode(handle.complete('WRONGCODE1#WRONGSTATE1'))).toBe('code_rejected');
    expect(leftovers()).toHaveLength(0);
    expect(await thrownCode(handle.complete(GOOD))).toBe('cancelled');
  });

  it.each(['', 'short#x', 'GOODCODE1', 'GOODCODE1#GOOD STATE', 'GOODCODE1#GOODSTATE1\nextra', 'a'.repeat(300) + '#' + 'b'.repeat(10), '../../etc#passwd12', 'GOODCODE1#GOODSTATE1;rm'])(
    'refuses the malformed code %j before it reaches the CLI',
    async (code) => {
      const handle = await runner('ok').start();
      expect(await thrownCode(handle.complete(code))).toBe('bad_code_format');
      expect(leftovers()).toHaveLength(0);
    },
  );

  it('accepts exactly the code shape the CLI prints', () => {
    expect(CODE_PATTERN.test(GOOD)).toBe(true);
    expect(CODE_PATTERN.test('AbC-123_x.y~z9#AbC-123_x.y~z9')).toBe(true);
  });

  it('fails cleanly, leaving nothing, when the CLI never prints a URL or exits immediately', async () => {
    expect(await thrownCode(runner('nourl').start())).toBe('start_failed');
    expect(await thrownCode(runner('hang', { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], startTimeoutMs: 300 }).start())).toBe('start_timeout');
    expect(leftovers()).toHaveLength(0);
  });

  it('times out a CLI that never finishes after the code, kills it and wipes the dir', async () => {
    const handle = await runner('hang', { completeTimeoutMs: 400 }).start();
    expect(await thrownCode(handle.complete(GOOD))).toBe('complete_timeout');
    expect(leftovers()).toHaveLength(0);
  });

  it('reports no_credentials when the CLI exits 0 without writing the file', async () => {
    const handle = await runner('crash').start();
    expect(await thrownCode(handle.complete(GOOD))).toBe('no_credentials');
    expect(leftovers()).toHaveLength(0);
  });

  it('cancel kills the process and wipes the dir, and is safe to repeat', async () => {
    const handle = await runner('ok').start();
    await handle.cancel();
    await handle.cancel();
    expect(leftovers()).toHaveLength(0);
    expect(await thrownCode(handle.complete(GOOD))).toBe('login_gone');
  });

  it('keeps the temp dir private to the owner', async () => {
    const handle = await runner('ok').start();
    const dir = join(root, leftovers()[0]);
    expect(existsSync(dir)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(require('fs').statSync(dir).mode & 0o077).toBe(0);
    await handle.cancel();
  });

  it('fails with start_failed, leaving nothing, when the binary does not exist', async () => {
    expect(await thrownCode(new LocalClaudeLoginRunner({ command: join(root, 'no-such-claude'), args: [], tmpRoot: root }).start())).toBe('start_failed');
    expect(leftovers()).toHaveLength(0);
  });

  it('takes the authorize URL only from the claude.com sign-in page, ignoring other links in the output', async () => {
    const handle = await new LocalClaudeLoginRunner({ command: process.execPath, args: [FAKE, 'otherlink'], tmpRoot: root }).start();
    expect(handle.authorizeUrl.startsWith('https://claude.com/cai/oauth/authorize?')).toBe(true);
    await handle.cancel();
  });

  it('says login_gone (start again) when the CLI exited on its own before the code arrived', async () => {
    const handle = await new LocalClaudeLoginRunner({ command: process.execPath, args: [FAKE, 'exitsoon'], tmpRoot: root }).start();
    await new Promise((r) => setTimeout(r, 400));
    expect(await thrownCode(handle.complete(GOOD))).toBe('login_gone');
    expect(leftovers()).toHaveLength(0);
  });
});

describe('resolveClaudeBinary', () => {
  it('finds the pinned claude binary by absolute path, not by looking it up on PATH', () => {
    const bin = resolveClaudeBinary();
    expect(bin).toMatch(/claude-code\/bin\/claude\.exe$/);
    expect(existsSync(bin)).toBe(true);
  });
});

describe('sweepStaleLoginDirs', () => {
  it('removes only old login dirs', () => {
    const r = mkdtempSync(join(tmpdir(), 'aw-sweep-'));
    const old = join(r, `${TMP_ROOT_PREFIX}old`); const fresh = join(r, `${TMP_ROOT_PREFIX}new`); const other = join(r, 'unrelated');
    [old, fresh, other].forEach((d) => mkdirSync(d));
    const t = new Date(Date.now() - 3 * 3600e3); utimesSync(old, t, t); utimesSync(other, t, t);
    expect(sweepStaleLoginDirs(r)).toBe(1);
    expect(existsSync(old)).toBe(false); expect(existsSync(fresh)).toBe(true); expect(existsSync(other)).toBe(true);
    rmSync(r, { recursive: true, force: true });
  });
});
