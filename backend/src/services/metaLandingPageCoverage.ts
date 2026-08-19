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

/** Days over which the site population is rotated. See {@link shouldCheckSiteToday}. */
export const SITE_ROTATION_DAYS = 7;

/**
 * Should this site be fetched TODAY?
 *
 * What this check detects — a deployed page carrying no usable pixel — is a CONFIGURATION
 * state, not a live signal. It changes when someone regenerates or hand-edits a site, on the
 * order of weeks; re-fetching every customer's pages every single day to re-confirm a fact
 * that almost never moves is the definition of waste, and it is waste aimed at someone else's
 * servers rather than ours.
 *
 * So each site is checked roughly once a week instead of daily: ~7x fewer outbound requests,
 * spread evenly rather than arriving as one daily burst. Storage-free by construction — the
 * shard falls out of the site id and the date, so nothing has to be remembered between runs,
 * which keeps §G clear of the data-plane gate exactly as every other §G check is.
 *
 * ⚠ THE TRADE, STATED: worst-case detection latency goes from 1 day to 7. That is acceptable
 * here and would NOT be for the other §G checks — this is the only one whose findings have no
 * ad spend behind them. A page nothing points at is losing nothing while it waits. The moment
 * an ad DOES point at it, #2448 picks it up the next morning at full daily cadence.
 */
export function shouldCheckSiteToday(siteId: string, asOf: Date = new Date()): boolean {
  const id = String(siteId ?? '');
  if (!id) return false;
  // Cheap deterministic hash — this only has to spread ids evenly, not resist anything.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  // Days since epoch, so the shard advances once per UTC day regardless of run time.
  const day = Math.floor(asOf.getTime() / 86_400_000);
  return h % SITE_ROTATION_DAYS === day % SITE_ROTATION_DAYS;
}

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
  /**
   * The HTML read as uninstrumented, but the page's own record says we installed an owned
   * pixel on it. Logged, NEVER paged.
   *
   * Our read is an INFERENCE: we fetch without executing JavaScript, so a site injecting its
   * pixel client-side (a tag manager, a consent gate, a framework that hydrates it) reads as
   * bare when it is fine. When the record and the fetch disagree, the record is evidence we
   * once installed it deliberately, and it outranks a single unexecuted read — the same
   * "second signal outranks our HTML inference" rule #2448 established.
   */
  unconfirmed: LandingPageFinding[];
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
export function collectSitesToCheck(
  pages: LandingPageRecord[] | null | undefined,
  asOf: Date = new Date(),
): {
  sites: SiteToCheck[];
  sitesNotChecked: number;
  sitesDeferred: number;
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

  // Rotation applied AFTER collection so the deferred count is honest about the whole
  // population rather than only what today's shard happened to contain.
  const due = all.filter((s) => shouldCheckSiteToday(s.siteId, asOf));
  return {
    sites: due.slice(0, MAX_SITES_CHECKED),
    sitesNotChecked: Math.max(0, due.length - MAX_SITES_CHECKED),
    sitesDeferred: all.length - due.length,
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
    alerting: [], unconfirmed: [], unverifiable: [], okCount: 0, sitesNotChecked,
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
      // The record claims we installed a pixel this account owns, and the fetch disagrees.
      // Two explanations, and only one of them is a defect: the page injects it client-side
      // (our unexecuted read cannot see it), or it was genuinely removed. Downgraded rather
      // than paged, because a confidently wrong alert costs more than an honest gap.
      if (site.recordedPixelId && owned.has(String(site.recordedPixelId))) {
        verdict.unconfirmed.push({ ...site, reason: 'no_pixel', detectedPixelIds: [] });
        continue;
      }
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
  /** Sites whose weekly rotation slot is not today. Not a failure — reported so the
   *  difference between "checked and healthy" and "not due" is never invisible. */
  sitesDeferred: number;
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
  const empty = { sites: [], sitesNotChecked: 0, sitesDeferred: 0, observations: {} };
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

  const { sites, sitesNotChecked, sitesDeferred } = collectSitesToCheck(pages);
  if (sites.length === 0) return { status: 'ok', ...empty, sitesDeferred };

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
    return { status: 'ok', sites, sitesNotChecked, sitesDeferred, observations };
  } catch (error: any) {
    // The page list already succeeded, so it is kept: every site becomes unverifiable, which
    // is logged and pages nobody. Discarding it too would throw away good work.
    console.warn(`[Tracking Monitor] §G landing-page fetch failed: ${error?.message ?? error}`);
    return { status: 'ok', sites, sitesNotChecked, sitesDeferred, observations: {} };
  }
}
