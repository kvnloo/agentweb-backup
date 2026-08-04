/**
 * SSRF guard: rejects URLs whose hostnames resolve to private/internal IPs.
 *
 * Used by routes that fetch a user-supplied URL server-side (e.g. /api/crm/.../
 * group-email/load-from-url). Without this guard, an authenticated user can
 * point us at internal services (cloud metadata, RFC1918 hosts, loopback) and
 * exfiltrate internal data through the response body.
 *
 * Strategy:
 *   1. Reject obvious internal hostname literals (`localhost`,
 *      metadata.{google,aws}.internal).
 *   2. Resolve the hostname (or accept the literal IP if the host *is* an IP).
 *   3. Reject if any resolved address falls into a private/internal range
 *      (RFC1918, loopback, link-local, CGNAT, ULA, IPv4-mapped private).
 *
 * Pure Node stdlib — no new npm deps.
 */

import { lookup as dnsLookup } from 'dns/promises';
import { isIP, isIPv4, isIPv6 } from 'net';

// Hostnames that should never be accepted, even if DNS would resolve them
// to a public IP (defence in depth — these are "we don't ever want to fetch
// this" labels).
const FORBIDDEN_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.aws.internal',
  'metadata',
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  /* istanbul ignore next — callers gate on isIPv4(ip), so malformed inputs never reach here */
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    /* istanbul ignore next — callers gate on isIPv4(ip) */
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) + octet;
  }
  // Force unsigned 32-bit
  return n >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const raw = ipv4ToInt(ip);
  /* istanbul ignore next — ipv4ToInt only returns null on malformed IPs, which the callers' isIPv4 guard rejects upstream */
  if (raw === null) return false;
  // JS bitwise ops produce 32-bit signed values; force unsigned with `>>> 0`
  // before comparing against unsigned literal network addresses.
  // 10.0.0.0/8
  if (((raw & 0xff000000) >>> 0) === 0x0a000000) return true;
  // 172.16.0.0/12
  if (((raw & 0xfff00000) >>> 0) === 0xac100000) return true;
  // 192.168.0.0/16
  if (((raw & 0xffff0000) >>> 0) === 0xc0a80000) return true;
  // 127.0.0.0/8 (loopback)
  if (((raw & 0xff000000) >>> 0) === 0x7f000000) return true;
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (((raw & 0xffff0000) >>> 0) === 0xa9fe0000) return true;
  // 100.64.0.0/10 (CGNAT)
  if (((raw & 0xffc00000) >>> 0) === 0x64400000) return true;
  // 0.0.0.0/8 (this-network — including 0.0.0.0)
  if (((raw & 0xff000000) >>> 0) === 0x00000000) return true;
  // 224.0.0.0/4 (multicast)
  if (((raw & 0xf0000000) >>> 0) === 0xe0000000) return true;
  // 240.0.0.0/4 (class E reserved — includes 255.255.255.255 broadcast)
  if (((raw & 0xf0000000) >>> 0) === 0xf0000000) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // ::1 (loopback)
  if (lower === '::1') return true;

  // ::  (unspecified — never legitimate as a destination)
  if (lower === '::') return true;

  // Expand ::ffff:a.b.c.d (IPv4-mapped) — Node accepts both ::ffff:1.2.3.4 and
  // ::ffff:0102:0304 forms; the first is most common and easy to detect.
  const v4mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (v4mapped) {
    return isPrivateIPv4(v4mapped[1]);
  }
  // Hex form ::ffff:hhhh:hhhh — convert to IPv4 dotted and re-check
  const v4mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4mappedHex) {
    const hi = parseInt(v4mappedHex[1], 16);
    const lo = parseInt(v4mappedHex[2], 16);
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(dotted);
  }

  // fc00::/7 (Unique Local Address): first byte 0xfc or 0xfd
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;

  // fe80::/10 (link-local): first 10 bits = 1111111010xx
  // i.e. fe80::, fe90::, fea0::, feb0:: (any `feXx` where Xx in 80..bf)
  const llMatch = lower.match(/^fe([0-9a-f]{2}):/);
  if (llMatch) {
    const second = parseInt(llMatch[1], 16);
    if (second >= 0x80 && second <= 0xbf) return true;
  }

  // ff00::/8 (multicast)
  if (/^ff[0-9a-f]{2}:/.test(lower)) return true;

  return false;
}

function isPrivateIP(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateIPv4(ip);
  if (isIPv6(ip)) return isPrivateIPv6(ip);
  // Unknown family — be conservative and reject. Both call sites already
  // gate with isIP(), so this is unreachable through the public API.
  /* istanbul ignore next */
  return true;
}

export class SsrfBlockedError extends Error {
  constructor(message = 'URL resolves to a private/internal address') {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Validates a URL's hostname is not internal and resolves only to public
 * IPs, and returns the validated hostname plus ONE resolved address/family.
 *
 * Greptile finding: assertPublicHostname alone validates one DNS answer, but
 * a caller that does its own SEPARATE lookup afterward to actually connect
 * (e.g. axios.get without pinning) is vulnerable to DNS rebinding — an
 * attacker-controlled DNS server can return a public IP for the validation
 * lookup and a private IP for the connection lookup, since they're two
 * independent queries. Callers that need to be rebinding-safe should use
 * this function and pin their connection to the returned address (see
 * agentModeService.fetchAndParseCsvRows) instead of re-resolving the
 * hostname a second time.
 */
export async function resolvePinnedPublicAddress(rawUrl: string): Promise<{ hostname: string; address: string; family: number }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }

  // URL.hostname strips IPv6 brackets, so this is the bare hostname or IP.
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new SsrfBlockedError('Invalid URL');
  }

  // Block obvious labels regardless of DNS
  if (FORBIDDEN_HOSTNAMES.has(hostname)) {
    throw new SsrfBlockedError();
  }

  // If the hostname is itself a literal IP, check it directly — DNS never runs.
  if (isIP(hostname)) {
    if (isPrivateIP(hostname)) {
      throw new SsrfBlockedError();
    }
    return { hostname, address: hostname, family: isIPv4(hostname) ? 4 : 6 };
  }

  // Otherwise resolve via DNS (`all: true` returns every A/AAAA record).
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch (err: any) {
    throw new SsrfBlockedError(`DNS lookup failed: ${err?.message || 'unknown'}`);
  }

  /* istanbul ignore next — dns.promises.lookup either resolves with an array or rejects; the !addresses branch is defensive */
  if (!addresses || addresses.length === 0) {
    throw new SsrfBlockedError('Hostname did not resolve');
  }

  for (const addr of addresses) {
    if (isPrivateIP(addr.address)) {
      throw new SsrfBlockedError();
    }
  }

  return { hostname, address: addresses[0].address, family: addresses[0].family };
}

/**
 * Throws SsrfBlockedError if the URL's hostname is internal or resolves to
 * a private/internal IP. Returns void on success. Callers that then connect
 * with a SEPARATE DNS lookup (rather than pinning to the address this
 * validated) remain exposed to DNS rebinding — see resolvePinnedPublicAddress.
 */
export async function assertPublicHostname(rawUrl: string): Promise<void> {
  await resolvePinnedPublicAddress(rawUrl);
}

/** Minimal response shape shared by the injected and real HTTP transports. */
export interface HttpResponseLike {
  status: number;
  headers: Record<string, any>;
  data: any;
}

export interface RedirectFetchDeps {
  resolvePinned?: (url: string) => Promise<{ hostname: string; address: string; family: number }>;
  request?: (
    url: string,
    pinned: { address: string; family: number },
    timeoutMs: number
  ) => Promise<HttpResponseLike>;
}

export const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Fetch a URL's bytes SSRF-safely, following redirects hop by hop.
 *
 * Pinning the connection to a pre-validated address (resolvePinnedPublicAddress)
 * is DNS-rebinding-safe but only for the hop it validated: a public URL that
 * 302s to 169.254.169.254 walks straight past it, which is why the naive guard
 * pairs pinning with `maxRedirects: 0`. Refusing all redirects closes that hole
 * and simultaneously false-blocks every legitimate one-hop URL — Google Drive
 * `uc?export=view` links 303 once to drive.usercontent.google.com, and
 * describe_image was failing on exactly those (ENG-834).
 *
 * Following hop-by-hop with a fresh resolvePinned on EVERY hop keeps both
 * properties: SSRF-safe across redirects, and correct for legitimately
 * redirecting media URLs. Same shape as
 * googleAdsTrackingPreflight.fetchHtmlFollowingRedirects, which learned this
 * lesson first — this is its byte-returning sibling.
 *
 * Deps are injectable so redirect/SSRF behaviour is unit-testable without real
 * network or DNS. Content-type is returned verbatim (params stripped) and is
 * NEVER defaulted — fabricating a media type would short-circuit sharp's format
 * detection downstream (ENG-370).
 */
export async function fetchBufferFollowingRedirects(
  startUrl: string,
  deps: RedirectFetchDeps = {},
  maxRedirects: number = DEFAULT_MAX_REDIRECTS,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  const resolvePinned = deps.resolvePinned ?? resolvePinnedPublicAddress;
  const request = deps.request ?? defaultPinnedRequest;

  // timeoutMs bounds the WHOLE fetch, not each hop. Per-hop it would multiply by
  // the redirect limit (6 hops x 30s = 180s), and this download runs OUTSIDE
  // describe_image's 90s vision bound — so a slow chain could stall a tool call
  // for minutes and eat the run's generation budget (the unbounded-media-call
  // failure ENG-294 exists to prevent).
  const deadline = Date.now() + timeoutMs;

  let url = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Timed out following redirects after ${timeoutMs}ms`);
    }
    // Re-validate the resolved host at EVERY hop, not just the first.
    const pinned = await resolvePinned(url);
    const res = await request(url, pinned, remainingMs);

    if (res.status >= 200 && res.status < 300) {
      const rawType = res.headers?.['content-type'] ?? res.headers?.['Content-Type'] ?? '';
      return {
        buffer: Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data ?? []),
        contentType: String(rawType).split(';')[0].trim(),
        finalUrl: url,
      };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers?.location ?? res.headers?.Location;
      if (!location) throw new Error(`Redirect ${res.status} with no Location header`);
      const next = new URL(String(location), url); // resolve relative Location against current URL
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new Error(`Refusing to follow non-http(s) redirect to ${next.protocol}`);
      }
      url = next.toString();
      continue;
    }

    throw new Error(`Request failed with status code ${res.status}`);
  }
  throw new Error(`Too many redirects (>${maxRedirects})`);
}

/* istanbul ignore next — network boundary; unit tests inject `request` instead. */
async function defaultPinnedRequest(
  url: string,
  pinned: { address: string; family: number },
  timeoutMs: number
): Promise<HttpResponseLike> {
  const axios = (await import('axios')).default;
  return axios.get(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    // This transport handles redirects itself (above) so it can re-validate each
    // hop; axios must therefore never follow one on its own.
    maxRedirects: 0,
    validateStatus: (s: number) => s >= 200 && s < 400,
    lookup: (_hostname: string, options: any, callback: any) => {
      if (typeof options === 'function') callback = options;
      callback(null, pinned.address, pinned.family);
    },
  } as any);
}
