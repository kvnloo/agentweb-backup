/**
 * ENG-926 §G — the last of the card's six checks: every GENERATED landing page.
 *
 * The card asks for verification across *"every ad's destination URL, every generated landing
 * page, and the dataset attached to the ad account."* Four of those six were shipped:
 * destination pixel install + id (#2448), optimised-event taxonomy (#2435), all-event taxonomy
 * (#2459). This is the generated-landing-page half of the remaining pair.
 *
 * Why it is NOT redundant with #2448: that check only ever inspects a page an ACTIVE,
 * conversion-optimised ad points at. A lander sitting deployed with no ad pointing at it today
 * is inspected by nothing — and it is exactly the page someone launches against next week,
 * having assumed it was instrumented because we built it.
 *
 * ⚠ ONE CHECK PER SITE, NOT PER PAGE. A Meta pixel is one-per-SITE: the base snippet lives in
 * `app/layout.tsx`, which every page in that repo shares (§22 — asking a single record "do you
 * have a pixel?" reported 9 of one customer's 10 pages as untracked while the whole site was
 * fine). Checking per page would be wrong AND would multiply outbound fetches by pages-per-site.
 */

import { preflightMetaTrackingGate } from './metaTrackingPreflight';

/** Sites checked per account per sweep. Mirrors MAX_DESTINATION_URLS_CHECKED's reasoning:
 *  a bound that keeps one pathological account from dominating the run, reported when hit
 *  rather than silently truncating (§44's third defect). */
export const MAX_SITES_CHECKED = 20;

export interface LandingPageRecord {
  id: string;
  userId?: string;
  name?: string;
  status?: string;
  siteId?: string;
  isRootPage?: boolean;
  deployedUrl?: string;
  customDomainUrl?: string;
  metaPixelId?: string;
  createdAt?: string;
}

export interface SiteToCheck {
  siteId: string;
  url: string;
  pageId: string;
  pageName?: string;
  /** The pixel the RECORD claims, if any. Never trusted as proof — the page is what serves. */
  recordedPixelId?: string;
}

export type LandingPageFinding = {
  siteId: string;
  pageId: string;
  pageName?: string;
  url: string;
  reason: 'no_pixel' | 'foreign_pixel';
  /** Pixels actually detected in the served HTML. Empty for `no_pixel`. */
  detectedPixelIds: string[];
};

export type LandingPageVerdict = {
  /** Deployed sites we built whose served HTML carries no usable pixel. */
  alerting: LandingPageFinding[];
  /** Fetch failed, or the account owns no pixels to compare against. Logged, never paged. */
  unverifiable: { siteId: string; url: string; reason: string }[];
  /** Confirmed carrying a pixel this account owns. */
  okCount: number;
  /** Sites beyond MAX_SITES_CHECKED. Reported so truncation is never invisible. */
  sitesNotChecked: number;
};

/**
 * Collapse a user's pages to ONE checkable URL per site.
 *
 * Preference order within a site: the root record (`isRootPage`, or `siteId === id`), then the
 * oldest — the root is where the shared layout and therefore the pixel lives.
 */
export function collectSitesToCheck(pages: LandingPageRecord[] | null | undefined): {
  sites: SiteToCheck[];
  sitesNotChecked: number;
} {
  const rows = (Array.isArray(pages) ? pages : []).filter(Boolean);
  const bySite = new Map<string, LandingPageRecord[]>();

  for (const p of rows) {
    // Only DEPLOYED pages serve anything. A draft or a failed generation has no URL to read,
    // and reporting it as uninstrumented would be an accusation about a page nobody can visit.
    if (String(p?.status ?? '') !== 'deployed') continue;
    const url = (p.customDomainUrl || p.deployedUrl || '').trim();
    if (!url) continue;
    const site = String(p.siteId || p.id);
    const list = bySite.get(site) ?? [];
    list.push(p);
    bySite.set(site, list);
  }

  const ranked = (p: LandingPageRecord) =>
    (p.isRootPage === true || String(p.siteId || p.id) === String(p.id)) ? 0 : 1;

  const all: SiteToCheck[] = [];
  for (const [siteId, list] of bySite) {
    const chosen = list.slice().sort((a, b) => {
      const r = ranked(a) - ranked(b);
      if (r !== 0) return r;
      return String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''));
    })[0];
    all.push({
      siteId,
      pageId: chosen.id,
      pageName: chosen.name,
      url: (chosen.customDomainUrl || chosen.deployedUrl || '').trim(),
      recordedPixelId: chosen.metaPixelId,
    });
  }

  // Deterministic order so a cap truncates the same set each run rather than a shifting one.
  all.sort((a, b) => a.siteId.localeCompare(b.siteId));
  return {
    sites: all.slice(0, MAX_SITES_CHECKED),
    sitesNotChecked: Math.max(0, all.length - MAX_SITES_CHECKED),
  };
}

/**
 * Judge each site's served HTML against the pixels this ad account owns.
 *
 * `observations` is keyed by URL, exactly as `preflightMetaTrackingGate` returns it.
 *
 * ⚠ An account with NO owned pixels yields `unverifiable` for every site, never a fleet of
 * `foreign_pixel` findings. With nothing to compare against, "this pixel isn't yours" is a
 * claim we cannot make — the same rule #2448 applies, and the same one that stopped a
 * truncated owned-pixel read from inventing alerts.
 */
export function evaluateLandingPageCoverage(
  sites: SiteToCheck[] | null | undefined,
  observations: Record<string, { status?: string; detectedPixelIds?: string[] }> | null | undefined,
  ownedPixelIds: string[] | null | undefined,
  sitesNotChecked = 0,
): LandingPageVerdict {
  const verdict: LandingPageVerdict = {
    alerting: [], unverifiable: [], okCount: 0, sitesNotChecked,
  };
  const owned = new Set((ownedPixelIds ?? []).filter(Boolean).map(String));
  const obs = observations && typeof observations === 'object' ? observations : {};

  for (const site of (Array.isArray(sites) ? sites : [])) {
    const o = obs[site.url];
    if (!o || o.status === 'unverifiable') {
      verdict.unverifiable.push({ siteId: site.siteId, url: site.url, reason: 'page could not be read' });
      continue;
    }
    if (owned.size === 0) {
      verdict.unverifiable.push({
        siteId: site.siteId, url: site.url, reason: 'ad account owns no pixels to compare against',
      });
      continue;
    }

    const detected = (o.detectedPixelIds ?? []).filter(Boolean).map(String);
    if (detected.length === 0) {
      verdict.alerting.push({ ...site, reason: 'no_pixel', detectedPixelIds: [] });
      continue;
    }
    if (detected.some((id) => owned.has(id))) {
      verdict.okCount++;
      continue;
    }
    // A pixel IS installed, but this ad account cannot receive its conversions. A naive
    // "is there any tracking?" check passes this — ownership is the test (#2448).
    verdict.alerting.push({ ...site, reason: 'foreign_pixel', detectedPixelIds: detected });
  }

  return verdict;
}

export interface LandingPageFetchDeps {
  fetchHtml?: (url: string) => Promise<string>;
  listPages?: (userId: string) => Promise<LandingPageRecord[]>;
}

export type LandingPageInputs = {
  status: 'ok' | 'fetch_error';
  sites: SiteToCheck[];
  sitesNotChecked: number;
  observations: Record<string, { status?: string; detectedPixelIds?: string[] }>;
  error?: string;
};

/**
 * Read the user's deployed sites and observe each one's served HTML.
 *
 * Never throws. A failure here must leave the rest of the sweep intact, and produce
 * `unverifiable` rather than a finding — the discipline every §G check shares.
 */
export async function fetchLandingPageInputs(
  userId: string,
  ownedPixelIds: string[],
  deps?: LandingPageFetchDeps,
): Promise<LandingPageInputs> {
  const empty = { sites: [], sitesNotChecked: 0, observations: {} };
  let pages: LandingPageRecord[] = [];

  try {
    const list =
      deps?.listPages ??
      (async (u: string) => {
        const { getLandingPagesByOwner } = await import('./v0Service');
        return (await getLandingPagesByOwner(u)) as unknown as LandingPageRecord[];
      });
    pages = (await list(userId)) ?? [];
  } catch (error: any) {
    return { status: 'fetch_error', ...empty, error: error?.message || 'landing page read failed' };
  }

  const { sites, sitesNotChecked } = collectSitesToCheck(pages);
  if (sites.length === 0) return { status: 'ok', ...empty };

  try {
    const gate = await preflightMetaTrackingGate(
      sites.map((s) => s.url),
      ownedPixelIds ?? [],
      // Forwarded only when present. Passing `{ fetchHtml: undefined }` would override the
      // gate's own SSRF-guarded fetcher in any implementation checking presence rather than
      // truthiness — the trap #2448's gate suite pins.
      deps?.fetchHtml ? { fetchHtml: deps.fetchHtml } : {},
    );
    const observations: LandingPageInputs['observations'] = {};
    for (const r of (gate?.results ?? [])) {
      observations[(r as any).url] = {
        status: (r as any).status,
        detectedPixelIds: ((r as any).mechanisms ?? [])
          .filter((m: string) => typeof m === 'string' && m.startsWith('PIXEL:'))
          .map((m: string) => m.replace(/^PIXEL:/, '')),
      };
    }
    return { status: 'ok', sites, sitesNotChecked, observations };
  } catch (error: any) {
    // The page list already succeeded, so it is kept: every site becomes unverifiable, which
    // is logged and pages nobody. Discarding it too would throw away good work.
    console.warn(`[Tracking Monitor] §G landing-page fetch failed: ${error?.message ?? error}`);
    return { status: 'ok', sites, sitesNotChecked, observations: {} };
  }
}
