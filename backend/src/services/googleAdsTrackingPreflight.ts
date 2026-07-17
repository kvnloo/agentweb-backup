/**
 * Deterministic pre-flight tracking gate for Google Ads launches (ENG-335).
 *
 * Before a Google Ads campaign is enabled/launched, every final URL it points at
 * must be *measurable*: the served HTML has to contain at least one recognised
 * conversion-measurement mechanism. Spending on pages that structurally cannot
 * report a conversion (the ThinkingAI incident, ENG-334) is blocked by default.
 *
 * This module is intentionally pure and deterministic — no LLM, no model
 * judgement. Fetching is behind a mockable boundary (`PreflightDeps.fetchHtml`)
 * so the whole gate is unit-testable with the network stubbed.
 *
 * v1 SPA caveat: a destination that injects its tracking only client-side (after
 * the initial document loads) can false-negative here, because we inspect the
 * served HTML for the script tags rather than executing the page. That is an
 * accepted limitation for v1 — the explicit override path exists precisely so
 * server-side / unusual tracking setups are not stranded.
 */

import axios from 'axios';
import { assertPublicHostname } from '../utils/ssrfGuard';

export type UrlTrackingStatus = 'measured' | 'unmeasured' | 'unverifiable';

export interface UrlTrackingResult {
  url: string;
  status: UrlTrackingStatus;
  /** Labelled mechanisms detected in the served HTML, e.g. `GA4:G-ABC123`. */
  mechanisms: string[];
  /** Human-readable list of what was looked for (constant, for messaging/audit). */
  checkedFor: string[];
  /** Populated only when status === 'unverifiable' (fetch failed / non-2xx / timeout). */
  error?: string;
}

export interface PreflightGateResult {
  /** True only when every checked URL is 'measured' (or there were no URLs). */
  ok: boolean;
  results: UrlTrackingResult[];
  /** URLs that are 'unmeasured' or 'unverifiable' — i.e. the reason a launch is blocked. */
  blockedUrls: UrlTrackingResult[];
  /** Human-readable explanation naming each blocked URL, what was checked, and how to fix it. */
  message: string;
}

export interface PreflightDeps {
  /** Injectable fetch boundary. Must resolve to the served HTML or throw on failure. */
  fetchHtml?: (url: string) => Promise<string>;
}

/** The measurement mechanisms this gate recognises (surfaced to users verbatim). */
export const TRACKING_MECHANISMS: string[] = [
  'GA4 gtag (G-…)',
  'GTM container (GTM-…)',
  'Google Ads conversion snippet (AW-…)',
];

/**
 * Inspect served HTML for Google measurement mechanisms. Pure and side-effect-free.
 * Returns a de-duplicated list of labelled matches (empty ⇒ no tracking detected).
 */
export function detectTrackingSnippets(html: string): string[] {
  if (!html || typeof html !== 'string') return [];
  const found = new Set<string>();

  // GA4 measurement ID: G-XXXXXXXXXX (also matches googletagmanager.com/gtag/js?id=G-…)
  for (const m of html.match(/\bG-[A-Z0-9]{6,}\b/gi) || []) {
    found.add(`GA4:${m.toUpperCase()}`);
  }
  // GTM container: GTM-XXXXXXX (also matches gtm.js?id=GTM-… and the ns.html noscript iframe)
  for (const m of html.match(/\bGTM-[A-Z0-9]{4,}\b/gi) || []) {
    found.add(`GTM:${m.toUpperCase()}`);
  }
  // Google Ads conversion / remarketing tag: AW-123456789
  for (const m of html.match(/\bAW-[0-9]{6,}\b/gi) || []) {
    found.add(`AW:${m.toUpperCase()}`);
  }

  return [...found];
}

/** Max redirect hops to follow before giving up (→ 'unverifiable'). */
const MAX_REDIRECTS = 5;

export interface RedirectFetchDeps {
  /** One HTTP GET that does NOT auto-follow redirects and surfaces 3xx as a resolved
   *  response (so we can read Location and re-check SSRF ourselves). */
  get: (url: string) => Promise<{ status: number; headers: Record<string, any>; data: any }>;
  /** SSRF guard, run on every hop (start URL and each redirect target). */
  assertPublic: (url: string) => Promise<void>;
  maxRedirects?: number;
}

/**
 * Fetch a URL's served HTML, following redirects MANUALLY and re-validating the
 * SSRF guard on every hop. This is deliberately not `axios`'s built-in redirect
 * following: axios only lets us vet the *pre-redirect* host, so a final URL that
 * 302s to an internal/metadata endpoint would bypass the guard (the ENG-335
 * security finding). Refusing all redirects (`maxRedirects:0`) closed that hole
 * but false-blocked every measured page behind a normal apex→www / http→https /
 * rebrand redirect — i.e. most real landing pages. Following hop-by-hop with a
 * fresh `assertPublic` on each target keeps BOTH properties: SSRF-safe across
 * redirects, and correct for legitimately-measured pages that redirect once.
 *
 * Pure and injectable (deps) so the redirect/SSRF behaviour is unit-testable
 * without real network or DNS.
 */
export async function fetchHtmlFollowingRedirects(startUrl: string, deps: RedirectFetchDeps): Promise<string> {
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  let url = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await deps.assertPublic(url); // re-validate the resolved host at EVERY hop
    const res = await deps.get(url);
    if (res.status >= 200 && res.status < 300) {
      return typeof res.data === 'string' ? res.data : String(res.data ?? '');
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

/* istanbul ignore next — network boundary; unit tests inject `fetchHtml` (or exercise
   fetchHtmlFollowingRedirects with fake deps) instead. */
async function defaultFetchHtml(url: string): Promise<string> {
  const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MB is plenty for a landing page document
  // `as any` routes around the legacy @types/axios shim that omits maxContentLength /
  // validateStatus (same workaround as googleAdsService.uploadAsset). maxRedirects:0 so
  // axios never follows on its own — fetchHtmlFollowingRedirects does, re-running the SSRF
  // guard on each hop. validateStatus accepts 3xx so we can read the Location header;
  // any 4xx/5xx throws → surfaced as 'unverifiable' by checkUrlTracking.
  return fetchHtmlFollowingRedirects(url, {
    assertPublic: assertPublicHostname,
    // `as any` on the result too: the legacy @types/axios shim types get() as a
    // non-standard IPromise that doesn't structurally match our Promise<...> dep.
    get: (u: string) => axios.get(u, {
      responseType: 'text',
      timeout: 10000,
      maxContentLength: MAX_HTML_BYTES,
      maxBodyLength: MAX_HTML_BYTES,
      maxRedirects: 0,
      validateStatus: (s: number) => s >= 200 && s < 400,
      headers: { 'User-Agent': 'AgentWeb-TrackingPreflight/1.0' },
    } as any) as any,
  });
}

/**
 * Fetch one final URL and classify its measurement status. A fetch failure
 * (timeout, 4xx/5xx, DNS, SSRF-blocked) is NEVER treated as measured — it
 * surfaces as 'unverifiable' and follows the blocked-by-default path.
 */
export async function checkUrlTracking(url: string, deps: PreflightDeps = {}): Promise<UrlTrackingResult> {
  const fetchHtml = deps.fetchHtml || defaultFetchHtml;
  try {
    const html = await fetchHtml(url);
    const mechanisms = detectTrackingSnippets(html);
    return {
      url,
      status: mechanisms.length > 0 ? 'measured' : 'unmeasured',
      mechanisms,
      checkedFor: TRACKING_MECHANISMS,
    };
  } catch (err: any) {
    return {
      url,
      status: 'unverifiable',
      mechanisms: [],
      checkedFor: TRACKING_MECHANISMS,
      error: err?.message || 'Could not fetch URL',
    };
  }
}

function buildBlockMessage(blocked: UrlTrackingResult[]): string {
  const lines = blocked.map((r) => {
    const reason = r.status === 'unverifiable'
      ? `could not verify (fetch failed: ${r.error || 'unknown error'})`
      : 'no GA4 / GTM / Google Ads conversion snippet found in the served HTML';
    return `  • ${r.url} — ${reason}`;
  });
  return [
    'Launch blocked: pre-flight tracking check failed. These final URLs are not measurable, ' +
      'so paid traffic would be spent on pages that cannot report a conversion:',
    ...lines,
    '',
    `Checked each URL's served HTML for: ${TRACKING_MECHANISMS.join(', ')}.`,
    'Fix: install GA4, a GTM container, or a Google Ads conversion snippet on these pages. ' +
      'For Emma-built landers, enable the conversion-tracking / GTM setting (see ENG-334). ' +
      'If you use server-side or otherwise undetectable tracking, re-run with override_tracking_check=true ' +
      'to launch anyway (the override is recorded).',
  ].join('\n');
}

function buildPassMessage(results: UrlTrackingResult[]): string {
  if (results.length === 0) {
    return 'Pre-flight tracking check: no final URLs to verify.';
  }
  return `Pre-flight tracking check passed: all ${results.length} final URL(s) have detectable ` +
    'conversion measurement (GA4 / GTM / Google Ads conversion snippet).';
}

/**
 * Run the deterministic pre-flight tracking gate over a set of final URLs.
 * `ok` is true only if every (de-duplicated) URL is 'measured'; an empty URL
 * list is treated as ok (nothing to gate).
 */
export async function preflightTrackingGate(urls: string[], deps: PreflightDeps = {}): Promise<PreflightGateResult> {
  const unique = [...new Set(
    (urls || [])
      .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      .map((u) => u.trim()),
  )];

  const results = await Promise.all(unique.map((u) => checkUrlTracking(u, deps)));
  const blockedUrls = results.filter((r) => r.status !== 'measured');
  const ok = blockedUrls.length === 0;

  return {
    ok,
    results,
    blockedUrls,
    message: ok ? buildPassMessage(results) : buildBlockMessage(blockedUrls),
  };
}
