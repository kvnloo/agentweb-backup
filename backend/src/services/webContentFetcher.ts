/**
 * Item #1 — Web page content fetcher.
 *
 * After a SERP search, the top 1–2 result snippets are 100–200 chars and frequently
 * miss the actual data we want (funding figures, employee counts, tech stack).
 * This service fetches the page and extracts main content, appending up to ~4KB
 * of clean text to the web context for the LLM.
 *
 * Bounds:
 *   - 5s timeout per fetch
 *   - 1MB body cap
 *   - 4000 char output cap (per page)
 *   - Skips known low-value domains (login walls, paywalls)
 */

import * as cheerio from 'cheerio';
import { promises as dns } from 'dns';
import * as net from 'net';

const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_OUTPUT_CHARS = 4000;
const USER_AGENT = 'Mozilla/5.0 (compatible; AgentWebEnrichBot/1.0)';

const SKIP_DOMAINS = new Set([
  'linkedin.com',          // requires auth, snippets are often enough
  'login.microsoftonline.com',
  'accounts.google.com',
  'twitter.com',           // login walls
  'x.com',
  'facebook.com',
  'instagram.com',
  'tiktok.com',
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * SSRF defense: reject IPs that target the local host, private networks,
 * link-local space (notably AWS instance metadata at 169.254.169.254),
 * carrier-grade NAT, and IPv6 reserved ranges. The caller already filters
 * URLs, but we duplicate the check here so the fetcher is safe regardless of
 * how the URL got in.
 */
function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return true;                      // 0.0.0.0/8
    if (a === 10) return true;                     // 10/8
    if (a === 127) return true;                    // 127/8 loopback
    if (a === 169 && b === 254) return true;       // 169.254/16 link-local (AWS metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;       // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    if (a >= 224) return true;                     // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::1' || norm === '::') return true;
    if (norm.startsWith('fc') || norm.startsWith('fd')) return true; // ULA fc00::/7
    if (norm.startsWith('fe80')) return true;                         // link-local
    if (norm.startsWith('ff')) return true;                           // multicast
    // IPv4-mapped: ::ffff:a.b.c.d → unwrap and recheck
    const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateOrReservedIp(mapped[1]);
    return false;
  }
  return false;
}

/** WHATWG URL.hostname returns IPv6 wrapped in brackets — strip them for net.isIP. */
function unbracketHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function shouldSkip(url: string): boolean {
  try {
    const u = new URL(url);
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) return true;
    const rawHost = unbracketHost(u.hostname);
    const host = rawHost.toLowerCase().replace(/^www\./, '');
    if (!host) return true;
    if (SKIP_DOMAINS.has(host)) return true;
    // If the host is a literal IP, run the private/reserved check synchronously.
    // If it's a hostname, the runtime DNS check in fetchAndExtract handles it.
    if (net.isIP(rawHost) && isPrivateOrReservedIp(rawHost)) return true;
    // Skip image / pdf / non-HTML
    if (/\.(pdf|jpg|jpeg|png|gif|mp4|zip|rar)$/i.test(u.pathname)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Resolve `hostname` and reject if any A/AAAA record is in a private or
 * reserved range. This closes the DNS-rebinding gap: a hostname that resolves
 * to a private IP at fetch time is treated the same as a literal private IP.
 */
async function resolvesToPublicIp(hostname: string): Promise<boolean> {
  const host = unbracketHost(hostname);
  if (net.isIP(host)) {
    return !isPrivateOrReservedIp(host);
  }
  try {
    const records = await dns.lookup(host, { all: true });
    if (records.length === 0) return false;
    return records.every(r => !isPrivateOrReservedIp(r.address));
  } catch {
    return false;
  }
}

/**
 * Strip HTML and return main-content text. Uses cheerio (fast, no DOM)
 * with a heuristic: prefer <main>, <article>, then <body>; remove <script>,
 * <style>, <nav>, <footer>, <header>, <aside>.
 */
function extractMainText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  const title = ($('title').first().text() || '').trim();

  // Strip noise elements
  ['script', 'style', 'nav', 'footer', 'header', 'aside', 'iframe', 'noscript'].forEach(sel => {
    $(sel).remove();
  });

  // Pick the main content root in priority order
  let root = $('main').first();
  if (root.length === 0) root = $('article').first();
  if (root.length === 0) root = $('body');

  const text = root.text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text };
}

export async function fetchAndExtract(url: string): Promise<{ title: string; text: string; url: string } | null> {
  if (shouldSkip(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // SSRF defense: refuse to fetch when the hostname resolves into private /
  // reserved address space (incl. AWS metadata 169.254.169.254). This catches
  // both literal-IP URLs and hostnames that DNS-rebind to private IPs.
  if (!(await resolvesToPublicIp(parsed.hostname))) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ctype = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(ctype)) return null;
    // Cap body size. Check the size BEFORE appending so a single oversized
    // chunk (a hostile server can send one >100MB chunk) cannot push us past
    // MAX_BODY_BYTES — we slice the offending chunk to fit and stop reading.
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = MAX_BODY_BYTES - total;
      if (remaining <= 0) break;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        // Best-effort cancel; ignore failures (some implementations no-op).
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
    const buffer = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { buffer.set(c, pos); pos += c.byteLength; }
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

    const { title, text } = extractMainText(html);
    if (!text) return null;
    const capped = text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) + '…' : text;
    return { title, text: capped, url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch top N URLs in parallel with bounded concurrency. Returns successful pages only.
 */
export async function fetchTopPages(
  urls: string[],
  topN = 2
): Promise<Array<{ title: string; text: string; url: string }>> {
  const candidates = urls.slice(0, topN);
  const results = await Promise.all(candidates.map(u => fetchAndExtract(u)));
  return results.filter((r): r is { title: string; text: string; url: string } => r !== null);
}
