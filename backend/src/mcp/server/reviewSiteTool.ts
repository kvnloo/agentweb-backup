/**
 * emma_review_site — the one tool a stranger may run (ENG-1034).
 *
 * It makes our server fetch a URL chosen by an unauthenticated caller, so every
 * layer here is about refusing that URL safely:
 *   AC1 DNS-resolved private / loopback / link-local (169.254.169.254) / CGNAT /
 *       IPv6 ULA+loopback destinations are refused (utils/ssrfGuard).
 *   AC2 every redirect hop is re-resolved and re-validated, with the same
 *       scheme/port rules, before any connection to it.
 *   AC3 http/https only, default ports only, body and total time capped.
 *   AC4/5 per-IP and global daily ceilings, refused loudly (anonymousToolLimits).
 *   AC6 no user data: the handler takes only the URL and the caller address. It
 *       imports nothing from db/session/CRM/knowledge-base code.
 *
 * The analysis is deterministic HTML heuristics — no LLM — so an anonymous call
 * costs one bounded fetch and nothing else.
 */

import { mcpToolRegistry } from './registry';
import { jsonResult } from './toolHelpers';
import {
  fetchBufferFollowingRedirects,
  resolvePinnedPublicAddress,
  SsrfBlockedError,
  RedirectFetchDeps,
  DEFAULT_MAX_REDIRECTS,
} from '../../utils/ssrfGuard';
import { anonymousToolLimiter } from './anonymousToolLimits';

export const REVIEW_SITE_TOOL_NAME = 'emma_review_site';
export const REVIEW_SITE_MAX_BYTES = 2 * 1024 * 1024;
export const REVIEW_SITE_TIMEOUT_MS = 10_000;

export class ReviewSiteUrlRefused extends Error {}

/** AC3: scheme and port shape. Applied to the first URL AND every redirect hop. */
export function assertAllowedUrlShape(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ReviewSiteUrlRefused('That is not a valid URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ReviewSiteUrlRefused(`Only http and https URLs can be reviewed (got ${u.protocol}).`);
  }
  // URL.port is '' when the port is the scheme default (80/443 normalised away).
  if (u.port !== '') {
    throw new ReviewSiteUrlRefused('Only standard ports (80/443) can be reviewed.');
  }
  if (u.username || u.password) {
    throw new ReviewSiteUrlRefused('URLs with embedded credentials cannot be reviewed.');
  }
  return u;
}

/** Per-hop validator: shape first (cheap, no DNS), then DNS-resolved SSRF check. */
export function guardedResolve(
  resolve: (url: string) => Promise<{ hostname: string; address: string; family: number }> = resolvePinnedPublicAddress
) {
  return async (url: string) => {
    assertAllowedUrlShape(url);
    return resolve(url);
  };
}

export interface SiteReview {
  url: string;
  finalUrl: string;
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  positioning: string[];
  offerClarity: string[];
  conversionBlockers: string[];
  strengths: string[];
}

function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? textOf(m[1]).slice(0, 300) || null : null;
}

/** Pure: HTML in, review out. Exported for tests. */
export function analyseHtml(html: string, url: string, finalUrl: string): SiteReview {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaDescription =
    (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i))?.[1]?.trim() || null;
  const h1 = Array.from(html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)).map(m => textOf(m[1])).filter(Boolean).slice(0, 5);
  const body = textOf(html).toLowerCase();
  const wordCount = body ? body.split(' ').length : 0;

  const positioning: string[] = [];
  const offerClarity: string[] = [];
  const conversionBlockers: string[] = [];
  const strengths: string[] = [];

  if (!title) positioning.push('No <title>: search results and browser tabs show no positioning statement.');
  else if (title.length < 15) positioning.push(`Title "${title}" is too short to say who it is for and what it does.`);
  else strengths.push(`Title states: "${title}".`);

  if (h1.length === 0) positioning.push('No H1 headline: the first screen has no single, explicit value proposition.');
  else if (h1.length > 1) positioning.push(`${h1.length} H1 headlines compete for the main message; pick one.`);
  else strengths.push(`Headline: "${h1[0]}".`);

  if (!metaDescription) positioning.push('No meta description: the search snippet is left to chance.');

  if (!/\b(for|helps?|built for|designed for)\b/.test(body)) {
    offerClarity.push('Copy never names who it is for ("for X", "helps X"); the audience is implicit.');
  }
  if (!/(pricing|price|\$\d|per month|\/mo\b|free trial|plans?\b)/.test(body)) {
    offerClarity.push('No pricing or plan signal found; visitors cannot gauge cost or commitment.');
  } else strengths.push('Pricing or plan information is visible.');
  if (wordCount < 80) offerClarity.push(`Very little readable copy (${wordCount} words); the offer is hard to understand without JavaScript.`);

  const ctaRe = /<(a|button)[^>]*>([\s\S]*?)<\/\1>/gi;
  const ctas = Array.from(html.matchAll(ctaRe))
    .map(m => textOf(m[2]).toLowerCase())
    .filter(t => /(get started|start|sign up|try|book|demo|contact|buy|subscribe|request|talk to|join)/.test(t));
  if (ctas.length === 0) conversionBlockers.push('No clear call to action (e.g. "Get started", "Book a demo") found.');
  else strengths.push(`Calls to action found: ${Array.from(new Set(ctas)).slice(0, 4).map(c => `"${c}"`).join(', ')}.`);

  if (!/<form[\s>]/i.test(html) && !/(calendly|hubspot|typeform|mailto:)/i.test(html)) {
    conversionBlockers.push('No form, booking widget, or email link: there is no on-page way to capture a lead.');
  }
  if (!/(testimonial|customers?|trusted by|case stud|reviews?|rated|\d+\+? (companies|teams|users))/.test(body)) {
    conversionBlockers.push('No social proof (testimonials, customer logos, case studies) detected.');
  } else strengths.push('Social proof is present.');
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
    conversionBlockers.push('No mobile viewport meta tag; the page may render poorly on phones.');
  }
  if (url.startsWith('http:') && finalUrl.startsWith('http:')) {
    conversionBlockers.push('Served over plain HTTP; browsers mark it "Not secure".');
  }

  return { url, finalUrl, title, metaDescription, h1, positioning, offerClarity, conversionBlockers, strengths };
}

export interface ReviewSiteDeps {
  fetchDeps?: RedirectFetchDeps;
  limiter?: { check(ip: string | undefined): { allowed: boolean; message?: string; scope?: string } };
}

/** The handler. Takes the URL and caller address only — never a user identity. */
export async function reviewSite(args: { url?: unknown }, clientIp: string | undefined, deps: ReviewSiteDeps = {}) {
  const raw = typeof args?.url === 'string' ? args.url.trim() : '';
  if (!raw) return jsonResult({ status: 'refused', error: 'Pass `url`: the public website to review.' });

  try {
    assertAllowedUrlShape(raw);
  } catch (e) {
    return jsonResult({ status: 'refused', error: (e as Error).message });
  }

  const verdict = (deps.limiter ?? anonymousToolLimiter).check(clientIp);
  if (!verdict.allowed) {
    return jsonResult({ status: 'rate_limited', scope: (verdict as any).scope, error: (verdict as any).message });
  }

  const fetchDeps: RedirectFetchDeps = {
    ...deps.fetchDeps,
    resolvePinned: guardedResolve(deps.fetchDeps?.resolvePinned),
  };
  try {
    const { buffer, contentType, finalUrl } = await fetchBufferFollowingRedirects(
      raw,
      fetchDeps,
      DEFAULT_MAX_REDIRECTS,
      REVIEW_SITE_TIMEOUT_MS,
      REVIEW_SITE_MAX_BYTES
    );
    if (contentType && !/html|xml|text\/plain/i.test(contentType)) {
      return jsonResult({ status: 'refused', error: `That URL is not a web page (content-type ${contentType}).` });
    }
    return jsonResult({ status: 'ok', review: analyseHtml(buffer.toString('utf8'), raw, finalUrl) });
  } catch (e) {
    if (e instanceof SsrfBlockedError || e instanceof ReviewSiteUrlRefused) {
      return jsonResult({ status: 'refused', error: 'That address is not a public website and cannot be reviewed.' });
    }
    return jsonResult({ status: 'failed', error: `Could not fetch the site: ${(e as Error).message}` });
  }
}

mcpToolRegistry.register({
  name: REVIEW_SITE_TOOL_NAME,
  readOnly: true,
  definition: {
    name: REVIEW_SITE_TOOL_NAME,
    description:
      "Analyse any public website's go-to-market readiness: positioning, offer clarity, and conversion blockers. Works without an account.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public http(s) URL of the site to review, e.g. https://example.com' },
      },
      required: ['url'],
    },
  },
  execute: async (args: any, context: any) => reviewSite(args, context?.clientIp),
});
