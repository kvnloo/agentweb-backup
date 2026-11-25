/**
 * ENG-3187: containment for the Playwright browser server the agent drives.
 *
 * The browser server is a child process of the backend. Before this change it started with a full copy of the backend's
 * environment (login-token signing secret, cloud keys, payment and Slack keys) and with the backend's own working folder,
 * and the `browser_navigate` tool could be pointed at local files and internal addresses. What is here:
 *
 *  - playwrightChildEnv: the child gets only the variables a headless browser needs, never the backend's secrets.
 *  - the child runs in its own empty working and output folder; Playwright confines its file tools to that folder.
 *  - withoutBrowserClientMeta: a tool call cannot move that confinement (Playwright reads `arguments._meta.cwd` as the base for the paths it checks).
 *  - browserNavigationRefusal: the `browser_navigate` tool opens public http(s) pages only.
 *
 * What this does NOT do (tracked in ENG-3187, phase B): `browser_run_code` hands the caller Playwright's raw `page`. Through it a
 * caller can still `page.goto('file:///proc/<backend pid>/environ')`, call `page.request` (Node-side HTTP, not routed or checked) to
 * loopback or the cloud metadata address, or escape the Node `vm` it runs in. The child also runs as the same OS user as the backend. The
 * navigate check does not see redirects, links, meta refresh or DNS rebinding (Chrome resolves the name again). Closing all of that needs
 * the browser server under its own OS user or container with the metadata address blocked for it, or `browser_run_code` withdrawn from callers.
 */
import { SsrfBlockedError, assertPublicHostname } from '../../utils/ssrfGuard';

/** Variables a headless browser (and npx, if it is used to start the server) needs. Anything not listed stays behind. */
export const PLAYWRIGHT_ENV_ALLOWED_NAMES: ReadonlySet<string> = new Set([
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
    if (options.inheritFullEnv || PLAYWRIGHT_ENV_ALLOWED_NAMES.has(name) || ENV_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      env[name] = value;
    }
  }
  return { ...env, ...configuredEnv };
}

/** Where each browser server's own working and output folder lives (one fresh folder per browser server, mode 0700, removed with it). */
export const PLAYWRIGHT_WORK_ROOT = '/tmp/playwright-mcp-work';

/** The start of a working folder's name: the owning process id (so a sweep can tell a live owner from a dead one) and a folder-safe pool key. */
export function playwrightWorkDirPrefix(poolKeyOrName: string, pid: number = process.pid): string {
  return `${pid}-${poolKeyOrName.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 80)}-`;
}

/** A working folder with no readable owner (not made by this code) is judged by age alone. */
const FOREIGN_WORK_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a folder under PLAYWRIGHT_WORK_ROOT was left behind: its owning process is gone. A live process's folders are never touched, however old
 * (a folder's own modification time only changes when entries are added directly to it). A folder named for THIS process is abandoned only when this
 * process does not know it and it is older than this process (a restart in a container reuses the same process id). A name without an owner is removed
 * only when very old. Assumes every process that shares the root also shares the process-id space (true on one host).
 */
export function isAbandonedPlaywrightWorkDir(
  entryName: string,
  mtimeMs: number,
  nowMs: number,
  ownPid: number,
  pidAlive: (pid: number) => boolean,
  ownLiveNames: ReadonlySet<string> = new Set(),
  processStartMs: number = 0,
): boolean {
  const owner = /^(\d+)-/.exec(entryName);
  if (!owner) return nowMs - mtimeMs > FOREIGN_WORK_DIR_MAX_AGE_MS;
  const pid = Number(owner[1]);
  if (pid === ownPid) return !ownLiveNames.has(entryName) && mtimeMs < processStartMs;
  return !pidAlive(pid);
}

/** True when a process with this id exists (a process we may not signal still exists). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const isBrowserToolName = (toolName: string): boolean => typeof toolName === 'string' && (toolName.startsWith('browser_') || toolName.startsWith('playwright_'));

/**
 * The arguments to send to a browser tool: a copy without `_meta`. Playwright's `callTool` reads `arguments._meta.cwd` as the folder it resolves the
 * paths of `browser_file_upload` against when it checks them, but `setFiles` then resolves the same raw paths against its own working folder, so a
 * model-supplied `_meta.cwd` makes the check pass for a path that reads somewhere else (any file the backend's user can read). No tool needs it.
 */
export function withoutBrowserClientMeta(toolName: string, args: unknown): Record<string, unknown> {
  const copy: Record<string, unknown> = args && typeof args === 'object' ? { ...(args as Record<string, unknown>) } : {};
  if (isBrowserToolName(toolName)) delete copy._meta;
  return copy;
}

export const BROWSER_NAVIGATE_TOOL = 'browser_navigate';

const REFUSAL_SCHEME = 'The browser can only open public web pages (http or https). It cannot open local files or other kinds of address.';
const REFUSAL_ADDRESS = 'The browser can only open public web pages. It cannot open internal, local-network or IPv6 literal addresses.';
const REFUSAL_UNRESOLVED = 'The browser could not check that address just now (it did not resolve). Check the spelling, or try again in a moment.';

/** How long the host check may take before the address is treated as not checkable. */
const HOST_CHECK_TIMEOUT_MS = 5000;

/**
 * How many host checks may be waiting at once. A name lookup holds one of the process's few lookup threads until it answers, so a burst of navigates
 * to names that never answer must not starve the rest of the backend; past this many, the address is refused as "could not check just now".
 */
const MAX_CONCURRENT_HOST_CHECKS = 8;
let activeHostChecks = 0;

/** Names Chrome or the network treat as local without asking the public DNS (`*.localhost` is loopback in Chrome; `.local` is mDNS; `.internal` is private by convention). */
const LOCAL_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home.arpa'];

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

class HostCheckTimeout extends Error {}

/**
 * For `browser_navigate`: a reason (worded for the model) when the address is not a public http(s) page (or `data:`, which has no host), otherwise null.
 * Every other tool returns null. It looks at the scheme first (file:, view-source:, chrome:, javascript:, blob: and the like are refused), then at the
 * host: IPv6 literals, local names and names that resolve to private, loopback or link-local addresses are refused, and an address that cannot be checked
 * within a few seconds is refused with a different reason. It is a check on this tool only, made before the call (see the header for what it does not see).
 */
export async function browserNavigationRefusal(
  toolName: string,
  args: unknown,
  options: {
    assertPublic?: (url: string) => Promise<void>;
    log?: (line: string) => void;
    who?: { userId?: string; sessionId?: string };
    timeoutMs?: number;
    maxConcurrentChecks?: number;
  } = {},
): Promise<string | null> {
  if (toolName !== BROWSER_NAVIGATE_TOOL) return null;
  const rawUrl = (args as { url?: unknown } | null | undefined)?.url;
  // Not a string: leave it to the tool's own schema check to reject.
  if (typeof rawUrl !== 'string') return null;
  const assertPublic = options.assertPublic ?? assertPublicHostname;
  const log = options.log ?? ((line: string) => console.warn(line));
  const refused = (reason: 'scheme' | 'address' | 'unresolved', scheme?: string): void =>
    log(JSON.stringify({ event: 'browser_navigation_refused', reason, ...(scheme ? { scheme: scheme.slice(0, 32) } : {}), userId: options.who?.userId, sessionId: options.who?.sessionId }));

  const target = readNavigationTarget(rawUrl);
  if (!target) {
    refused('address');
    return REFUSAL_ADDRESS;
  }
  if (target.protocol === 'about:') {
    if (target.href === 'about:blank') return null;
    refused('scheme', target.protocol);
    return REFUSAL_SCHEME;
  }
  // A data: page has no host to check; it is an opaque origin that can reach no more than any other page can.
  if (target.protocol === 'data:') return null;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    refused('scheme', target.protocol);
    return REFUSAL_SCHEME;
  }
  const host = target.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.startsWith('[') || LOCAL_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    refused('address');
    return REFUSAL_ADDRESS;
  }
  if (activeHostChecks >= (options.maxConcurrentChecks ?? MAX_CONCURRENT_HOST_CHECKS)) {
    refused('unresolved');
    return REFUSAL_UNRESOLVED;
  }
  activeHostChecks += 1;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      assertPublic(target.href),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HostCheckTimeout()), options.timeoutMs ?? HOST_CHECK_TIMEOUT_MS); }),
    ]);
  } catch (error) {
    const couldNotCheck = error instanceof HostCheckTimeout
      || (error instanceof SsrfBlockedError && /^(DNS lookup failed|Hostname did not resolve)/.test(error.message))
      || (!(error instanceof SsrfBlockedError) && /^(DNS lookup failed|Hostname did not resolve)/.test(String((error as Error)?.message)));
    refused(couldNotCheck ? 'unresolved' : 'address');
    return couldNotCheck ? REFUSAL_UNRESOLVED : REFUSAL_ADDRESS;
  } finally {
    activeHostChecks -= 1;
    if (timer) clearTimeout(timer);
  }
  return null;
}
