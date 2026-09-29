/**
 * PageSpeed Insights (Lighthouse) performance/accessibility check for deployed landing pages
 * (ENG-2193, ENG-2128 B).
 *
 * Reuses the existing PageSpeed API key — `getPageSpeedApiKey()` in `seoService.ts`, secret
 * `prod|dev/AgentWeb/Google/PageSpeed` — rather than adding a new one. `seoService.ts` only ever
 * requests `category=seo` for the SEO-score feature; this requests `performance` +
 * `accessibility` instead, in the SAME single `runPagespeed` call (repeated `category` query
 * params), not a second API call.
 *
 * ADVISORY ONLY, matching every other landing-page check in this codebase
 * (`landingPageSmokeTest.ts`'s `smokeTestResult`, `landingPageLaunchReadiness.ts`): a flat
 * `{ok, ...scores, checkedAt, error?}` result, not `creativeGates.ts`'s `{id,status,reason}[]`
 * shape — that shape is specific to image-creative gates. `v0Service.ts` calls this
 * fire-and-forget after deploy, alongside the existing Playwright smoke test, and persists the
 * result on the page record's own `pageSpeedResult` field (no new table).
 */

import { getPageSpeedApiKey } from './seoService';

const PAGESPEED_STRATEGY = 'mobile';
/** PageSpeed Insights runs a real Lighthouse pass server-side; 20-30s responses are routine. */
const PAGESPEED_TIMEOUT_MS = 45_000;

export interface LandingPagePageSpeedResult {
  ok: boolean;
  /** 0-100, Lighthouse's `performance` category score. */
  performanceScore?: number;
  /** 0-100, Lighthouse's `accessibility` category score. */
  accessibilityScore?: number;
  checkedAt: string;
  error?: string;
}

function pageSpeedUrl(targetUrl: string, apiKey: string): string {
  const params = new URLSearchParams();
  params.set('url', targetUrl);
  params.append('category', 'performance');
  params.append('category', 'accessibility');
  params.set('strategy', PAGESPEED_STRATEGY);
  params.set('key', apiKey);
  return `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params.toString()}`;
}

function scoreOf(category: unknown): number | undefined {
  const score = (category as { score?: unknown } | undefined)?.score;
  return typeof score === 'number' ? Math.round(score * 100) : undefined;
}

/**
 * Never throws — every failure (no API key, network error, timeout, malformed response) comes
 * back as `{ok: false, error}` so a deployed page always gets a stored attempt, not silence.
 */
export async function runLandingPagePageSpeedCheck(url: string | undefined): Promise<LandingPagePageSpeedResult> {
  const checkedAt = new Date().toISOString();
  if (!url) return { ok: false, checkedAt, error: 'no URL to check' };
  try {
    const apiKey = await getPageSpeedApiKey();
    if (!apiKey) return { ok: false, checkedAt, error: 'PageSpeed API key unavailable' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGESPEED_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(pageSpeedUrl(url, apiKey), { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      return {
        ok: false,
        checkedAt,
        error: `PageSpeed Insights returned ${response.status}: ${(errorBody ? JSON.stringify(errorBody) : response.statusText).slice(0, 300)}`,
      };
    }

    const data = await response.json();
    const categories = (data as { lighthouseResult?: { categories?: unknown } })?.lighthouseResult?.categories as
      | { performance?: unknown; accessibility?: unknown }
      | undefined;
    const performanceScore = scoreOf(categories?.performance);
    const accessibilityScore = scoreOf(categories?.accessibility);
    if (performanceScore === undefined && accessibilityScore === undefined) {
      return { ok: false, checkedAt, error: 'PageSpeed response had no performance or accessibility score' };
    }
    return {
      ok: true,
      checkedAt,
      ...(performanceScore !== undefined ? { performanceScore } : {}),
      ...(accessibilityScore !== undefined ? { accessibilityScore } : {}),
    };
  } catch (err) {
    return { ok: false, checkedAt, error: err instanceof Error ? err.message : String(err) };
  }
}
