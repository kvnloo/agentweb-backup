import axios from 'axios';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import { resolvePinnedPublicAddress, SsrfBlockedError } from '../utils/ssrfGuard';

type Pinned = { hostname: string; address: string; family: number };
type Method = 'GET' | 'HEAD';
type HttpReply = { status: number; headers: Record<string, unknown>; data?: unknown };

export interface SiteLinkCrawlerDeps {
  resolvePinned?: (url: string) => Promise<Pinned>;
  request?: (url: string, pinned: Pinned, method: Method, timeoutMs: number, maxBytes: number) => Promise<HttpReply>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SiteLinkScanResult {
  success: boolean;
  startUrl: string;
  crawlOrigin: string;
  pagesScanned: number;
  linksChecked: number;
  brokenLinkCount: number;
  brokenLinks: Array<{ url: string; kind: 'internal' | 'outbound'; status?: number; error?: string; foundOn: string[] }>;
  unverifiableLinkCount: number;
  unverifiableLinks: Array<{ url: string; status?: number; error?: string }>;
  robotsSkipped: string[];
  truncated: boolean;
  deadlineExceeded: boolean;
}

const UA = 'AgentWebLinkChecker';
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2_048;

class ScanDeadlineError extends Error {}
class RobotsDeniedError extends Error { constructor(readonly url: string) { super('Blocked by robots.txt'); } }

async function byDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  try { return await Promise.race([work, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new ScanDeadlineError('Site scan deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer!); }
}

function bounded(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value!), 1), max) : fallback;
}

function normalizeUrl(raw: string, base?: string): URL {
  const url = new URL(raw, base);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  if (url.username || url.password) throw new Error('URL credentials are not allowed');
  if (url.port) throw new Error('Nonstandard URL ports are not allowed');
  url.hash = '';
  if (url.toString().length > MAX_URL_LENGTH) throw new Error('URL exceeds maximum length');
  return url;
}

function siteHost(hostname: string): string { return hostname.startsWith('www.') ? hostname.slice(4) : hostname; }
function isSameSite(url: URL, host: string): boolean { return siteHost(url.hostname) === host; }

function header(headers: Record<string, unknown>, name: string): string {
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1] ?? '') : '';
}

/* istanbul ignore next -- tests inject a transport; production pins DNS here. */
async function defaultRequest(url: string, pinned: Pinned, method: Method, timeoutMs: number, maxBytes: number): Promise<HttpReply> {
  return axios.request({
    url,
    method,
    responseType: method === 'GET' ? 'text' : undefined,
    timeout: timeoutMs,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    maxRedirects: 0,
    validateStatus: (status: number) => status >= 200 && status < 600,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.2' },
    lookup: (_hostname: string, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      callback(null, pinned.address, pinned.family);
    },
  } as any) as any;
}

async function requestFollowingRedirects(
  start: string,
  method: Method,
  deps: SiteLinkCrawlerDeps,
  deadlineAt: number,
  delayMs: number,
  beforeRequest?: (url: string) => Promise<void>
): Promise<HttpReply & { finalUrl: string }> {
  const resolvePinned = deps.resolvePinned ?? resolvePinnedPublicAddress;
  const request = deps.request ?? defaultRequest;
  const now = deps.now ?? Date.now;
  const seen = new Set<string>();
  let url = normalizeUrl(start).toString();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (seen.has(url)) throw new Error('Redirect loop detected');
    seen.add(url);
    if (now() >= deadlineAt) throw new ScanDeadlineError('Site scan deadline exceeded');
    let remaining = deadlineAt - now();
    if (remaining <= 0) throw new ScanDeadlineError('Site scan deadline exceeded');
    const pinned = await byDeadline(resolvePinned(url), remaining);
    await beforeRequest?.(url);
    remaining = deadlineAt - now();
    if (remaining <= 0) throw new ScanDeadlineError('Site scan deadline exceeded');
    if (delayMs) await byDeadline((deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delayMs), remaining);
    remaining = deadlineAt - now();
    if (remaining <= 0) throw new ScanDeadlineError('Site scan deadline exceeded');
    const reply = await byDeadline(request(url, pinned, method, Math.min(TIMEOUT_MS, remaining), MAX_BODY_BYTES), remaining);
    if (method === 'GET' && Buffer.byteLength(String(reply.data ?? '')) > MAX_BODY_BYTES) throw new Error('Response body exceeds maximum size');
    if (reply.status < 300 || reply.status >= 400) return { ...reply, finalUrl: url };
    const location = header(reply.headers, 'location');
    if (!location) throw new Error(`Redirect ${reply.status} with no Location header`);
    url = normalizeUrl(location, url).toString();
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

function isBrokenStatus(status: number): boolean { return status === 404 || status === 410; }
function isUnverifiableStatus(status: number): boolean { return status < 200 || status >= 300; }
function isTerminalDns(error: unknown): boolean { return /(?:ENOTFOUND|ENODATA|NXDOMAIN|Hostname did not resolve)/i.test(error instanceof Error ? error.message : String(error)); }

export async function crawlWebsiteLinks(
  startUrl: string,
  options: { maxPages?: number; maxLinks?: number; requestDelayMs?: number; deadlineMs?: number } = {},
  deps: SiteLinkCrawlerDeps = {}
): Promise<SiteLinkScanResult> {
  const start = normalizeUrl(startUrl).toString();
  const canonicalHost = siteHost(new URL(start).hostname);
  const maxPages = bounded(options.maxPages, 100, 500);
  const maxLinks = bounded(options.maxLinks, 500, 2_000);
  const delayMs = options.requestDelayMs === 0 ? 0 : bounded(options.requestDelayMs, 100, 1_000);
  const now = deps.now ?? Date.now;
  const deadlineAt = now() + bounded(options.deadlineMs, 60_000, 300_000);
  const robotsByOrigin = new Map<string, ReturnType<typeof robotsParser> | null>();
  let robotsUnavailable = false;

  async function robotsAllows(url: URL): Promise<boolean> {
    if (robotsByOrigin.has(url.origin)) return robotsByOrigin.get(url.origin)?.isAllowed(url.toString(), UA) === true;
    try {
      const robotsUrl = `${url.origin}/robots.txt`;
      const reply = await requestFollowingRedirects(robotsUrl, 'GET', deps, deadlineAt, delayMs, async (hop) => {
        if (!isSameSite(new URL(hop), canonicalHost)) throw new Error('Off-site robots redirect blocked');
      });
      if (reply.status === 429 || reply.status >= 500) {
        robotsUnavailable = true;
        robotsByOrigin.set(url.origin, null);
        return false;
      }
      const rules = robotsParser(robotsUrl, reply.status >= 200 && reply.status < 300 ? String(reply.data ?? '') : '');
      robotsByOrigin.set(url.origin, rules);
      return rules.isAllowed(url.toString(), UA) !== false;
    } catch (error) {
      if (error instanceof SsrfBlockedError && !isTerminalDns(error)) throw error;
      if (error instanceof ScanDeadlineError) throw error;
      robotsUnavailable = true;
      robotsByOrigin.set(url.origin, null);
      return false;
    }
  }

  let crawlOrigin = new URL(start).origin;
  const queue = [start];
  const queued = new Set(queue);
  const seenPages = new Set<string>();
  const sources = new Map<string, Set<string>>();
  const outbound = new Set<string>();
  const checked = new Set<string>();
  const brokenLinks: SiteLinkScanResult['brokenLinks'] = [];
  const unverifiableLinks: SiteLinkScanResult['unverifiableLinks'] = [];
  const robotsSkipped: string[] = [];
  let pagesScanned = 0;
  let truncated = false;
  let deadlineExceeded = false;

  const rememberSource = (target: string, foundOn: string) => {
    const set = sources.get(target) ?? new Set<string>();
    if (set.size < 5) set.add(foundOn);
    sources.set(target, set);
  };
  const addBroken = (url: string, kind: 'internal' | 'outbound', status?: number, error?: string) => {
    brokenLinks.push({ url, kind, ...(status ? { status } : {}), ...(error ? { error: error.slice(0, 200) } : {}), foundOn: [...(sources.get(url) ?? [])] });
  };
  const addUnverifiable = (url: string, status?: number, error?: string) => {
    unverifiableLinks.push({ url, ...(status ? { status } : {}), ...(error ? { error: error.slice(0, 200) } : {}) });
  };

  while (queue.length && pagesScanned < maxPages) {
    const requestedUrl = queue.shift()!;
    if (seenPages.has(requestedUrl)) continue;
    seenPages.add(requestedUrl);
    let reply: HttpReply & { finalUrl: string };
    try {
      reply = await requestFollowingRedirects(requestedUrl, 'GET', deps, deadlineAt, delayMs, async (hop) => {
        const destination = new URL(hop);
        if (!isSameSite(destination, canonicalHost)) throw new Error('Off-site page redirect blocked');
        if (!(await robotsAllows(destination))) throw new RobotsDeniedError(hop);
      });
    } catch (error) {
      if (error instanceof ScanDeadlineError) { deadlineExceeded = truncated = true; break; }
      if (error instanceof RobotsDeniedError) { robotsSkipped.push(error.url); continue; }
      if (pagesScanned === 0 && error instanceof SsrfBlockedError && !isTerminalDns(error)) throw error;
      if (requestedUrl !== start) checked.add(requestedUrl);
      const message = error instanceof Error ? error.message : 'Request failed';
      if (/maximum size/i.test(message)) truncated = true;
      if (isTerminalDns(error)) addBroken(requestedUrl, 'internal', undefined, message);
      else addUnverifiable(requestedUrl, undefined, message);
      continue;
    }
    pagesScanned++;
    if (requestedUrl !== start) checked.add(requestedUrl);
    const finalUrl = normalizeUrl(reply.finalUrl).toString();
    const final = new URL(finalUrl);
    seenPages.add(finalUrl);
    if (pagesScanned === 1) crawlOrigin = final.origin;
    if (isBrokenStatus(reply.status)) addBroken(requestedUrl, 'internal', reply.status);
    else if (isUnverifiableStatus(reply.status)) addUnverifiable(requestedUrl, reply.status);
    if (reply.status < 200 || reply.status >= 300 || !isSameSite(final, canonicalHost)) continue;
    const contentType = header(reply.headers, 'content-type');
    const body = String(reply.data ?? '');
    if (contentType ? !/text\/html|application\/xhtml/i.test(contentType) : !/<(?:html|a)\b/i.test(body)) continue;
    const $ = cheerio.load(body);
    for (const element of $('a[href]').toArray()) {
      const href = $(element).attr('href');
      if (!href || href.startsWith('#')) continue;
      let target: URL;
      try { target = normalizeUrl(href, finalUrl); } catch (error) {
        if (/credentials|port|maximum length/i.test(error instanceof Error ? error.message : '')) addUnverifiable(String(href).slice(0, MAX_URL_LENGTH), undefined, error instanceof Error ? error.message : 'Unsafe URL');
        continue;
      }
      const targetUrl = target.toString();
      if (targetUrl === finalUrl || targetUrl === requestedUrl) continue;
      if (!sources.has(targetUrl) && sources.size >= maxLinks) {
        truncated = true;
        break;
      }
      rememberSource(targetUrl, finalUrl);
      if (seenPages.has(targetUrl)) continue;
      if (isSameSite(target, canonicalHost)) {
        if (!queued.has(targetUrl)) {
          queue.push(targetUrl);
          queued.add(targetUrl);
        }
      } else {
        outbound.add(targetUrl);
      }
    }
  }
  if (queue.length) truncated = true;

  for (const url of outbound) {
    if (deadlineExceeded) break;
    let reply: (HttpReply & { finalUrl: string }) | undefined;
    let usedGet = false;
    try {
      try {
        reply = await requestFollowingRedirects(url, 'HEAD', deps, deadlineAt, delayMs);
      } catch (error) {
        if (error instanceof SsrfBlockedError || error instanceof ScanDeadlineError || isTerminalDns(error)) throw error;
        usedGet = true;
        reply = await requestFollowingRedirects(url, 'GET', deps, deadlineAt, delayMs);
      }
      if (!usedGet && (reply.status < 200 || reply.status >= 300)) {
        reply = await requestFollowingRedirects(url, 'GET', deps, deadlineAt, delayMs);
      }
      checked.add(url);
      if (isBrokenStatus(reply.status)) addBroken(url, 'outbound', reply.status);
      else if (isUnverifiableStatus(reply.status)) addUnverifiable(url, reply.status);
    } catch (error) {
      if (error instanceof ScanDeadlineError) { deadlineExceeded = truncated = true; break; }
      checked.add(url);
      const message = error instanceof Error ? error.message : 'Request failed';
      if (isTerminalDns(error)) addBroken(url, 'outbound', undefined, message);
      else addUnverifiable(url, undefined, message);
    }
  }
  for (const link of brokenLinks) link.foundOn = [...(sources.get(link.url) ?? [])];

  return {
    success: !robotsUnavailable && !deadlineExceeded,
    startUrl: start,
    crawlOrigin,
    pagesScanned,
    linksChecked: checked.size,
    brokenLinkCount: brokenLinks.length,
    brokenLinks,
    unverifiableLinkCount: unverifiableLinks.length,
    unverifiableLinks,
    robotsSkipped,
    truncated,
    deadlineExceeded,
  };
}
