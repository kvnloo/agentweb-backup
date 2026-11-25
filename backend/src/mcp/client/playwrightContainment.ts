/**
 * ENG-3187: containment for the Playwright browser server the agent drives.
 *
 * The browser server is a child process of the backend. Before this change it started with a full copy of the backend's
 * environment (login-token signing secret, cloud keys, payment and Slack keys) and with the backend's own working folder,
 * and the browser could be pointed at local files and internal addresses. Everything here is a layer that makes that harder:
 *
 *  - playwrightChildEnv: the child gets only the variables a headless browser needs, never the backend's secrets.
 *  - the child runs in its own empty working and output folder (its file tools are confined to the working folder).
 *  - browserNavigationRefusal: `browser_navigate` opens public http(s) pages only.
 *  - PLAYWRIGHT_BLOCKED_ORIGINS: the cloud metadata addresses are blocked at the browser too.
 *
 * What this does NOT do: `browser_run_code` runs the caller's code in a Node `vm`, which is not a security boundary, and the
 * child runs as the same OS user as the backend, so code that escapes it can still read the backend's process and files.
 * Closing that needs the browser server under a separate OS user or container (infrastructure, tracked in ENG-3187).
 */
import { assertPublicHostname } from '../../utils/ssrfGuard';

/** Variables a headless browser (and npx, if it is used to start the server) needs. Anything not listed stays behind. */
const ENV_ALLOWED_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'TMPDIR', 'TEMP', 'TMP',
  // Where Playwright's own browsers were installed, and the font setup.
  'PLAYWRIGHT_BROWSERS_PATH', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE',
  // Network setup the browser needs to reach the web the same way the backend does. A proxy value can carry credentials; it is
  // passed on only because the browser cannot reach the web without it.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);
const ENV_ALLOWED_PREFIXES = ['LC_', 'XDG_'];

/** Set to the string "true" to give the browser server the backend's whole environment again (the old behaviour). A rollback switch only. */
export const PLAYWRIGHT_INHERIT_ENV_FLAG = 'MCP_PLAYWRIGHT_INHERIT_ENV';

/**
 * The environment of the browser server. `configuredEnv` is what the server's own configuration sets on purpose; it is passed on as is.
 */
export function playwrightChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  configuredEnv: Record<string, string> = {},
  options: { inheritFullEnv?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (typeof value !== 'string') continue;
    if (options.inheritFullEnv || ENV_ALLOWED_NAMES.has(name) || ENV_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      env[name] = value;
    }
  }
  return { ...env, ...configuredEnv };
}

/** Where each browser server's own working and output folder lives (one folder per pool, mode 0700, removed with the pool). */
export const PLAYWRIGHT_WORK_ROOT = '/tmp/playwright-mcp-work';

/** A folder-safe name for a pool key (or, for a shared server, its name). */
export function playwrightWorkDirName(poolKeyOrName: string): string {
  return poolKeyOrName.replace(/[^a-zA-Z0-9-_]/g, '_');
}

/**
 * Origins the browser may never request: the cloud metadata services. Playwright says this list is not a security boundary and does not
 * follow redirects, so it is one extra layer; the address check in browserNavigationRefusal and the instance setting (IMDSv2 required) are the others.
 */
export const PLAYWRIGHT_BLOCKED_ORIGINS = [
  'http://169.254.169.254', 'https://169.254.169.254',
  'http://169.254.170.2', 'https://169.254.170.2',
  'http://[fd00:ec2::254]', 'https://[fd00:ec2::254]',
  'http://metadata.google.internal', 'https://metadata.google.internal',
].join(';');

export const BROWSER_NAVIGATE_TOOL = 'browser_navigate';

const REFUSAL_SCHEME = 'The browser can only open public web pages (http or https). It cannot open local files or other kinds of address.';
const REFUSAL_ADDRESS = 'The browser can only open public web pages. It cannot open internal, local-network or unresolvable addresses.';

/** The address as Playwright's own `browser_navigate` reads it: a string that is not a URL gets http:// (localhost) or https://. */
function readNavigationTarget(rawUrl: string): URL | null {
  let url = rawUrl;
  try {
    return new URL(url);
  } catch {
    url = url.startsWith('localhost') ? `http://${url}` : `https://${url}`;
  }
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * For `browser_navigate`: a reason (worded for the model) when the address is not a public http(s) page, otherwise null. Every other tool returns null.
 * It looks at the scheme first (file:, view-source:, chrome:, data:, javascript: and the like are refused), then asks whether the host is a public address
 * (literal private, loopback and link-local addresses, local names and names that resolve to them are refused; an address that cannot be checked is refused).
 * A page that redirects to an internal address after this check is not covered (see the header).
 */
export async function browserNavigationRefusal(
  toolName: string,
  args: unknown,
  assertPublic: (url: string) => Promise<void> = assertPublicHostname,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<string | null> {
  if (toolName !== BROWSER_NAVIGATE_TOOL) return null;
  const rawUrl = (args as { url?: unknown } | null | undefined)?.url;
  // Not a string: leave it to the tool's own schema check to reject.
  if (typeof rawUrl !== 'string') return null;
  const target = readNavigationTarget(rawUrl);
  if (!target) return REFUSAL_ADDRESS;
  if (target.protocol === 'about:' && target.href === 'about:blank') return null;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    log(JSON.stringify({ event: 'browser_navigation_refused', reason: 'scheme', scheme: target.protocol }));
    return REFUSAL_SCHEME;
  }
  try {
    await assertPublic(target.href);
  } catch {
    log(JSON.stringify({ event: 'browser_navigation_refused', reason: 'address' }));
    return REFUSAL_ADDRESS;
  }
  return null;
}
