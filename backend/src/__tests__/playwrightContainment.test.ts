/**
 * ENG-3187: the browser server's environment, the addresses its navigate tool may open, and the metadata origins it must not request.
 * No network: the literal and reserved addresses below are refused without a DNS lookup, and the one public-name case injects its own check.
 */
import {
  BROWSER_NAVIGATE_TOOL,
  PLAYWRIGHT_BLOCKED_ORIGINS,
  browserNavigationRefusal,
  playwrightChildEnv,
  playwrightWorkDirName,
} from '../mcp/client/playwrightContainment';

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

  it('keeps the proxy, certificate, font, locale and browser-location variables a browser needs', () => {
    const child = playwrightChildEnv({
      ...HOST_VARIABLES, HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/ca.pem', SSL_CERT_FILE: '/etc/ssl/cert.pem',
      PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers', FONTCONFIG_PATH: '/etc/fonts', LC_CTYPE: 'C.UTF-8', XDG_CACHE_HOME: '/tmp/cache',
    });
    expect(child).toMatchObject({
      HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/ca.pem', SSL_CERT_FILE: '/etc/ssl/cert.pem',
      PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers', FONTCONFIG_PATH: '/etc/fonts', LC_CTYPE: 'C.UTF-8', XDG_CACHE_HOME: '/tmp/cache',
    });
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
    const child = playwrightChildEnv({ PATH: '/bin', HOME: undefined });
    expect(child).toEqual({ PATH: '/bin' });
  });

  it('gives the browser server the whole environment again only when the rollback switch asks for it', () => {
    const child = playwrightChildEnv(backendEnv(), {}, { inheritFullEnv: true });
    expect(child.JWT_SECRET).toBe('value-of-JWT_SECRET');
    expect(child.PATH).toBe(HOST_VARIABLES.PATH);
  });
});

describe('playwrightWorkDirName', () => {
  it('turns a pool key into a folder-safe name', () => {
    expect(playwrightWorkDirName('user-1::session/../x')).toBe('user-1__session____x');
    expect(playwrightWorkDirName('playwright')).toBe('playwright');
  });
});

describe('PLAYWRIGHT_BLOCKED_ORIGINS', () => {
  it('lists the cloud metadata origins, semicolon separated', () => {
    const origins = PLAYWRIGHT_BLOCKED_ORIGINS.split(';');
    expect(origins).toEqual(expect.arrayContaining([
      'http://169.254.169.254', 'https://169.254.169.254', 'http://[fd00:ec2::254]', 'http://metadata.google.internal', 'http://169.254.170.2',
    ]));
    expect(origins.every((origin) => /^https?:\/\/\S+$/.test(origin))).toBe(true);
  });
});

describe('browserNavigationRefusal', () => {
  const noLog = () => undefined;
  const publicOk = jest.fn().mockResolvedValue(undefined);
  beforeEach(() => publicOk.mockClear());
  const refusal = (url: unknown, log: (line: string) => void = noLog) => browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, { url }, undefined, log);

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
    expect(await browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, { url: 'https://example.com/a?b=1' }, publicOk, noLog)).toBeNull();
    expect(publicOk).toHaveBeenLastCalledWith('https://example.com/a?b=1');
    expect(await browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, { url: 'example.com/path' }, publicOk, noLog)).toBeNull();
    expect(publicOk).toHaveBeenLastCalledWith('https://example.com/path');
    expect(await browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, { url: 'http://example.com' }, publicOk, noLog)).toBeNull();
  });

  it('opens about:blank without any host check', async () => {
    expect(await browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, { url: 'about:blank' }, publicOk, noLog)).toBeNull();
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
    'data:text/html,<script>1</script>',
    'javascript:alert(1)',
    'blob:https://example.com/abc',
    'ftp://example.com/file',
    'ws://example.com/socket',
    'about:srcdoc',
    'localhost:3001',
  ])('refuses %s because it is not a public http(s) page', async (url) => {
    const lines: string[] = [];
    const message = await refusal(url, (line) => lines.push(line));
    expect(message).toMatch(/only open public web pages \(http or https\)/);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'browser_navigation_refused', reason: 'scheme' });
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'https://169.254.169.254/',
    'http://169.254.170.2/v2/credentials',
    'http://127.0.0.1:3001/api/auth/login',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://10.0.0.5/',
    'http://172.16.4.4/',
    'http://192.168.1.1/',
    'http://localhost/',
    'localhost',
    'http://LOCALHOST:3001/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://[::1]/',
    'http://[fd00:ec2::254]/latest/',
  ])('refuses %s because it is an internal address', async (url) => {
    const lines: string[] = [];
    const message = await refusal(url, (line) => lines.push(line));
    expect(message).toMatch(/only open public web pages\. It cannot open internal/);
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'browser_navigation_refused', reason: 'address' });
  });

  it('refuses a name that cannot be checked, and a name the host check refuses', async () => {
    const dnsFailure = jest.fn().mockRejectedValue(new Error('DNS lookup failed: ENOTFOUND'));
    expect(await browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, { url: 'https://no-such-name.invalid/' }, dnsFailure, noLog)).toMatch(/cannot open internal, local-network or unresolvable/);
    const privateName = jest.fn().mockRejectedValue(new Error('URL resolves to a private/internal address'));
    expect(await browserNavigationRefusal(BROWSER_NAVIGATE_TOOL, { url: 'https://rebind.example/' }, privateName, noLog)).toMatch(/cannot open internal/);
  });

  it('never writes the address it refused into the log (it can carry a token in its query)', async () => {
    const lines: string[] = [];
    await refusal('file:///etc/passwd?token=SECRET123', (line) => lines.push(line));
    await refusal('http://169.254.169.254/latest/meta-data/?token=SECRET123', (line) => lines.push(line));
    expect(lines).toHaveLength(2);
    expect(lines.join('')).not.toMatch(/SECRET123|passwd|meta-data|169\.254/);
  });
});
