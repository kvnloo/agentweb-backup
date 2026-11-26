/**
 * ENG-3187: the browser server's environment, what a browser tool call may carry, the addresses its navigate tool may open, and how an abandoned
 * working folder is recognised.
 * No network: the literal and reserved addresses below are refused without a DNS lookup, and every public-name case injects its own host check.
 */
import { spawnSync } from 'child_process';
import {
  BROWSER_NAVIGATE_TOOL,
  PLAYWRIGHT_ENV_ALLOWED_NAMES,
  browserNavigationRefusal,
  isAbandonedPlaywrightWorkDir,
  playwrightChildEnv,
  playwrightWorkDirPrefix,
  processIsAlive,
  withoutBrowserClientMeta,
} from '../mcp/client/playwrightContainment';
import { STDIO_CHILD_ENV_ALLOWLIST } from '../mcp/client/stdioChildEnv';
import { SsrfBlockedError } from '../utils/ssrfGuard';

// The NAMES (never values) the production backend environment held on 2026-11-25, read from Elastic Beanstalk, plus the ones a host adds itself.
const PRODUCTION_VARIABLE_NAMES = [
  'AGENT_MODE_LOOP_ENABLED', 'APOLLO_WEBHOOK_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'AZURE_OPENAI_API_KEY',
  'BACKEND_URL', 'FEATUREBASE_WEBHOOK_SECRET', 'GCS_CLIENT_EMAIL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'JWT_SECRET', 'LINEAR_WEBHOOK_SECRET',
  'MCP_ACCESS_TOKEN', 'META_SECRETS_NAME', 'NODE_ENV', 'PLACID_PRIVATE_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_VERIFICATION_TOKEN',
  'STRIPE_SECRET_KEY', 'UNIPILE_WEBHOOK_SECRET', 'ZOMA_STRIPE_PLAN_PRICE_ID',
];
const HOST_VARIABLES = { PATH: '/usr/bin:/bin', HOME: '/home/webapp', LANG: 'en_US.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', TMPDIR: '/tmp', USER: 'webapp' };

describe('playwrightChildEnv', () => {
  const backendEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...HOST_VARIABLES };
    for (const name of PRODUCTION_VARIABLE_NAMES) env[name] = `value-of-${name}`;
    return env;
  };

  it('passes none of the backend\'s variables to the browser server except what a headless browser needs', () => {
    const child = playwrightChildEnv(backendEnv());
    for (const name of PRODUCTION_VARIABLE_NAMES) expect(child).not.toHaveProperty(name);
    expect(child).toEqual(HOST_VARIABLES);
  });

  it('passes on every name on the allow-list, with its value', () => {
    expect(PLAYWRIGHT_ENV_ALLOWED_NAMES.size).toBeGreaterThanOrEqual(25);
    for (const name of PLAYWRIGHT_ENV_ALLOWED_NAMES) {
      expect(playwrightChildEnv({ [name]: `v-${name}`, JWT_SECRET: 'x' })).toEqual({ [name]: `v-${name}` });
    }
  });

  it('allows at least every name the shared stdio allow-list allows (the two lists must not drift apart)', () => {
    for (const name of STDIO_CHILD_ENV_ALLOWLIST) expect(PLAYWRIGHT_ENV_ALLOWED_NAMES.has(name)).toBe(true);
  });

  it('has nothing on the allow-list that looks like a secret', () => {
    for (const name of PLAYWRIGHT_ENV_ALLOWED_NAMES) expect(name).not.toMatch(/SECRET|TOKEN|PASSWORD|_KEY$|CREDENTIAL|AWS_/i);
  });

  it('passes on the locale and XDG families', () => {
    const child = playwrightChildEnv({ LC_CTYPE: 'C.UTF-8', LC_MESSAGES: 'C', XDG_CACHE_HOME: '/tmp/cache', XDG_RUNTIME_DIR: '/run/user/1', LCX: 'no', XDGX: 'no' });
    expect(child).toEqual({ LC_CTYPE: 'C.UTF-8', LC_MESSAGES: 'C', XDG_CACHE_HOME: '/tmp/cache', XDG_RUNTIME_DIR: '/run/user/1' });
  });

  it('does not let a Playwright setting from the backend\'s environment change what the browser server may do', () => {
    const child = playwrightChildEnv({ ...HOST_VARIABLES, PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS: 'true', PLAYWRIGHT_MCP_OUTPUT_DIR: '/', NODE_OPTIONS: '--require /x.js' });
    expect(child).toEqual(HOST_VARIABLES);
  });

  it('passes on what the server\'s own configuration sets on purpose, and that wins over the backend\'s value', () => {
    const child = playwrightChildEnv({ ...HOST_VARIABLES, LANG: 'C' }, { LANG: 'de_DE.UTF-8', MY_SETTING: 'x' });
    expect(child.LANG).toBe('de_DE.UTF-8');
    expect(child.MY_SETTING).toBe('x');
  });

  it('drops variables that have no value', () => {
    expect(playwrightChildEnv({ PATH: '/bin', HOME: undefined })).toEqual({ PATH: '/bin' });
  });

  it('gives the browser server the whole environment again only when the rollback switch asks for it', () => {
    const child = playwrightChildEnv(backendEnv(), {}, { inheritFullEnv: true });
    expect(child.JWT_SECRET).toBe('value-of-JWT_SECRET');
    expect(child.PATH).toBe(HOST_VARIABLES.PATH);
    expect(playwrightChildEnv(backendEnv(), {}, { inheritFullEnv: false })).not.toHaveProperty('JWT_SECRET');
  });
});

describe('withoutBrowserClientMeta', () => {
  it('removes `_meta` from a browser tool call, which would move the base Playwright resolves upload paths against', () => {
    const args = { paths: ['../../etc/passwd'], _meta: { cwd: '/tmp/playwright-mcp-work/x/a/b/c' } };
    expect(withoutBrowserClientMeta('browser_file_upload', args)).toEqual({ paths: ['../../etc/passwd'] });
    expect(withoutBrowserClientMeta('playwright_browser_file_upload', args)).toEqual({ paths: ['../../etc/passwd'] });
  });

  it('returns a copy and leaves the caller\'s arguments alone', () => {
    const args = { url: 'https://example.com', _meta: { cwd: '/' } };
    const prepared = withoutBrowserClientMeta('browser_navigate', args);
    expect(prepared).not.toBe(args);
    expect(args._meta).toEqual({ cwd: '/' });
  });

  it('keeps every other argument, including a nested `_meta`', () => {
    expect(withoutBrowserClientMeta('browser_evaluate', { function: '() => 1', filename: 'a.json', options: { _meta: 1 } })).toEqual({ function: '() => 1', filename: 'a.json', options: { _meta: 1 } });
  });

  it('leaves a tool that is not a browser tool exactly as it is', () => {
    expect(withoutBrowserClientMeta('some_other_tool', { a: 1, _meta: { progressToken: 't' } })).toEqual({ a: 1, _meta: { progressToken: 't' } });
  });

  it('turns arguments that are not an object into an empty one', () => {
    expect(withoutBrowserClientMeta('browser_snapshot', undefined)).toEqual({});
    expect(withoutBrowserClientMeta('browser_snapshot', null)).toEqual({});
  });
});

describe('working folder names and abandoned folders', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 1_800_000_000_000;

  it('names a folder after the owning process and a folder-safe pool key', () => {
    expect(playwrightWorkDirPrefix('user-1::session/../x', 4242)).toBe('4242-user-1__session____x-');
    expect(playwrightWorkDirPrefix('a'.repeat(200), 7)).toBe(`7-${'a'.repeat(80)}-`);
    expect(playwrightWorkDirPrefix('playwright')).toBe(`${process.pid}-playwright-`);
  });

  it('never calls a folder this process knows abandoned, however old', () => {
    expect(isAbandonedPlaywrightWorkDir('100-a-xyz', now - 30 * DAY, now, 100, () => false, new Set(['100-a-xyz']), now - DAY)).toBe(false);
  });

  it('never calls a folder this process made since it started abandoned, even if it does not know it', () => {
    expect(isAbandonedPlaywrightWorkDir('100-a-xyz', now - 1000, now, 100, () => false, new Set(), now - DAY)).toBe(false);
  });

  it('calls a folder named for this process id abandoned when it is older than this process and unknown to it (a restart in a container reuses the id)', () => {
    expect(isAbandonedPlaywrightWorkDir('100-a-xyz', now - 2 * DAY, now, 100, () => true, new Set(), now - DAY)).toBe(true);
  });

  it('never calls a live process\'s folder abandoned, however old (the folder\'s own modification time does not move while the browser works)', () => {
    expect(isAbandonedPlaywrightWorkDir('200-a-xyz', now - 30 * DAY, now, 100, () => true)).toBe(false);
  });

  it('calls a folder abandoned when its owner is gone, even if it is brand new', () => {
    expect(isAbandonedPlaywrightWorkDir('300-a-xyz', now, now, 100, () => false)).toBe(true);
  });

  it('judges a folder with no owner in its name by age alone: a week', () => {
    expect(isAbandonedPlaywrightWorkDir('legacy', now - DAY, now, 100, () => false)).toBe(false);
    expect(isAbandonedPlaywrightWorkDir('legacy', now - 8 * DAY, now, 100, () => false)).toBe(true);
  });

  it('knows a process that is running from one that is not', () => {
    expect(processIsAlive(process.pid)).toBe(true);
    const finished = spawnSync(process.execPath, ['-e', '0']);
    expect(typeof finished.pid).toBe('number');
    expect(processIsAlive(finished.pid as number)).toBe(false);
  });
});

describe('browserNavigationRefusal', () => {
  const noLog = () => undefined;
  const publicOk = jest.fn().mockResolvedValue(undefined);
  beforeEach(() => publicOk.mockClear());
  const navigate = (url: unknown, options: Parameters<typeof browserNavigationRefusal>[2] = { log: noLog }) => browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, { url }, options);

  it('leaves every other tool alone, whatever it is given', async () => {
    expect(await browserNavigationRefusal('browser_snapshot', { url: 'file:///etc/passwd' })).toBeNull();
    expect(await browserNavigationRefusal('browser_click', { url: 'http://169.254.169.254/' })).toBeNull();
    expect(await browserNavigationRefusal('browser_run_code', { code: "page.goto('file:///etc/passwd')" })).toBeNull();
  });

  it('leaves a call without a usable address to the tool\'s own schema check', async () => {
    expect(await browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, undefined)).toBeNull();
    expect(await browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, {})).toBeNull();
    expect(await browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, { url: 42 })).toBeNull();
  });

  it('opens a public page, with or without a scheme, after asking whether its host is public', async () => {
    expect(await navigate('https://example.com/a?b=1', { assertPublic: publicOk, log: noLog })).toBeNull();
    expect(publicOk).toHaveBeenLastCalledWith('https://example.com/a?b=1');
    expect(await navigate('example.com/path', { assertPublic: publicOk, log: noLog })).toBeNull();
    expect(publicOk).toHaveBeenLastCalledWith('https://example.com/path');
    expect(await navigate('http://example.com', { assertPublic: publicOk, log: noLog })).toBeNull();
  });

  it('opens about:blank and a data: page without any host check (neither has a host)', async () => {
    expect(await navigate('about:blank', { assertPublic: publicOk, log: noLog })).toBeNull();
    expect(await navigate('data:text/html,<p>hello</p>', { assertPublic: publicOk, log: noLog })).toBeNull();
    expect(publicOk).not.toHaveBeenCalled();
  });

  it.each([
    'file:///etc/passwd',
    'FILE:///etc/passwd',
    '  file:///etc/passwd',
    'fi\tle:///etc/passwd',
    'view-source:file:///etc/hostname',
    'view-source:https://example.com',
    'chrome://settings',
    'chrome-extension://abc/page.html',
    'devtools://devtools/bundled/inspector.html',
    'javascript:alert(1)',
    'blob:https://example.com/abc',
    'filesystem:https://example.com/temporary/x',
    'ftp://example.com/file',
    'ws://example.com/socket',
    'about:srcdoc',
    'localhost:3001',
  ])('refuses %s because it is not a public http(s) page', async (url) => {
    const lines: string[] = [];
    const message = await navigate(url, { assertPublic: publicOk, log: (line) => lines.push(line) });
    expect(message).toMatch(/only open public web pages \(http or https\)/);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'browser_navigation_refused', reason: 'scheme' });
    expect(publicOk).not.toHaveBeenCalled();
  });

  it.each(['', ' ', '%', '['])('refuses the address %j that cannot be read as an address at all', async (url) => {
    expect(await navigate(url, { assertPublic: publicOk, log: noLog })).toMatch(/cannot open internal, local-network or IPv6 literal addresses/);
    expect(publicOk).not.toHaveBeenCalled();
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'https://169.254.169.254/',
    'http://169.254.170.2/v2/credentials',
    'http://127.0.0.1:3001/api/auth/login',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0/',
    'http://10.0.0.5/',
    'http://172.16.4.4/',
    'http://192.168.1.1/',
    'http://example.com@127.0.0.1/',
    'http://localhost/',
    'localhost',
    'http://LOCALHOST:3001/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ])('refuses %s because it is an internal address', async (url) => {
    const lines: string[] = [];
    const message = await navigate(url, { log: (line) => lines.push(line) });
    expect(message).toMatch(/only open public web pages\. It cannot open internal/);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'browser_navigation_refused', reason: 'address' });
  });

  it.each([
    'http://[::1]/',
    'http://[fd00:ec2::254]/latest/',
    'http://[2001:4860:4860::8888]/',
    'http://foo.localhost/',
    'http://printer.local/',
    'http://db.internal/',
    'http://router.lan/',
    'http://localhost./',
    'http://LOCALHOST.:3001/',
  ])('refuses %s without asking the host check (a literal IPv6 address or a name that is local by convention)', async (url) => {
    expect(await navigate(url, { assertPublic: publicOk, log: noLog })).toMatch(/cannot open internal, local-network or IPv6 literal addresses/);
    expect(publicOk).not.toHaveBeenCalled();
  });

  it('refuses a name the host check says is private', async () => {
    const privateName = jest.fn().mockRejectedValue(new SsrfBlockedError());
    expect(await navigate('https://rebind.example/', { assertPublic: privateName, log: noLog })).toMatch(/cannot open internal/);
  });

  it('tells the model when a name could not be checked, not that it is internal', async () => {
    const lines: string[] = [];
    const dnsFailure = jest.fn().mockRejectedValue(new SsrfBlockedError('DNS lookup failed: ENOTFOUND'));
    const message = await navigate('https://no-such-name.invalid/', { assertPublic: dnsFailure, log: (line) => lines.push(line) });
    expect(message).toMatch(/could not check that address just now \(it did not resolve\)/);
    expect(JSON.parse(lines[0])).toMatchObject({ reason: 'unresolved' });
    const unresolved = jest.fn().mockRejectedValue(new SsrfBlockedError('Hostname did not resolve'));
    expect(await navigate('https://nothing.invalid/', { assertPublic: unresolved, log: noLog })).toMatch(/did not resolve/);
  });

  it('gives up on a host check that does not answer, and says it could not check', async () => {
    const hangs = jest.fn().mockImplementation(() => new Promise<void>(() => undefined));
    const started = Date.now();
    expect(await navigate('https://slow.example/', { assertPublic: hangs, timeoutMs: 25, log: noLog })).toMatch(/could not check that address just now/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not let a burst of checks that never answer hold every lookup thread: past the limit the address is refused as not checkable, and the room comes back', async () => {
    const hangs = jest.fn().mockImplementation(() => new Promise<void>(() => undefined));
    const lines: string[] = [];
    const first = navigate('https://slow-1.example/', { assertPublic: hangs, timeoutMs: 40, maxConcurrentChecks: 1, log: noLog });
    const second = await navigate('https://slow-2.example/', { assertPublic: publicOk, maxConcurrentChecks: 1, log: (line) => lines.push(line) });
    expect(second).toMatch(/could not check that address just now/);
    expect(JSON.parse(lines[0])).toMatchObject({ reason: 'unresolved' });
    expect(publicOk).not.toHaveBeenCalled();
    expect(await first).toMatch(/could not check that address just now/);
    expect(await navigate('https://fine.example/', { assertPublic: publicOk, maxConcurrentChecks: 1, log: noLog })).toBeNull();
  });

  it('waits for at most 8 host checks at once by default', async () => {
    const hangs = jest.fn().mockImplementation(() => new Promise<void>(() => undefined));
    const waiting = Array.from({ length: 8 }, (_, i) => navigate(`https://slow-${i}.example/`, { assertPublic: hangs, timeoutMs: 60, log: noLog }));
    expect(await navigate('https://ninth.example/', { assertPublic: publicOk, log: noLog })).toMatch(/could not check that address just now/);
    expect(publicOk).not.toHaveBeenCalled();
    await Promise.all(waiting);
    expect(await navigate('https://after.example/', { assertPublic: publicOk, log: noLog })).toBeNull();
  });

  it('gives the slot back when the host check throws before it returns anything', async () => {
    const throwsAtOnce = jest.fn().mockImplementation(() => { throw new Error('boom'); });
    expect(await navigate('https://one.example/', { assertPublic: throwsAtOnce, maxConcurrentChecks: 1, log: noLog })).toMatch(/cannot open internal/);
    expect(await navigate('https://two.example/', { assertPublic: throwsAtOnce, maxConcurrentChecks: 1, log: noLog })).toMatch(/cannot open internal/);
    expect(await navigate('https://three.example/', { assertPublic: publicOk, maxConcurrentChecks: 1, log: noLog })).toBeNull();
  });

  it('refuses an unexpected failure of the host check (it fails closed)', async () => {
    const broken = jest.fn().mockRejectedValue(new Error('boom'));
    expect(await navigate('https://example.com/', { assertPublic: broken, log: noLog })).toMatch(/cannot open internal/);
  });

  it('writes who was refused into the log, caps the scheme, and never writes the address', async () => {
    const lines: string[] = [];
    const who = { userId: 'user-1', sessionId: 'session-1' };
    await navigate('file:///etc/passwd?token=SECRET123', { log: (line) => lines.push(line), who });
    await navigate('http://169.254.169.254/latest/meta-data/?token=SECRET123', { log: (line) => lines.push(line), who });
    await navigate(`${'a'.repeat(60)}://x/?token=SECRET123`, { log: (line) => lines.push(line), who });
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'browser_navigation_refused', reason: 'scheme', scheme: 'file:', ...who });
    expect(JSON.parse(lines[2]).scheme.length).toBe(32);
    expect(lines.join('')).not.toMatch(/SECRET123|passwd|meta-data|169\.254/);
  });
});
