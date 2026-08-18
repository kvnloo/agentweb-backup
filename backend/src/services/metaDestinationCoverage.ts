/**
 * ENG-926 §G — is an ACTIVE ad sending paid traffic to a page that cannot measure it?
 *
 * THE INCIDENT THIS EXISTS FOR. RankAI churned after ~$5,202 of spend against a lander that
 * collected `utm_*`/`fbclid`, used them to build a redirect, and then wrote the lead without
 * them. `hireemma.ai` separately ran campaigns whose destination carried a pixel the paying
 * ad account did not own. Both look identical from inside the ad account: money leaves,
 * clicks arrive, and the conversion column stays empty for a reason nothing reports.
 *
 * ENG-941 already answers this question ONCE, at launch. The card is explicit that this is
 * not enough: *"the gate is a launch-time artifact that runs once; it cannot catch a pixel
 * that breaks in week three… This ticket covers the continuous half."* This module is that
 * continuous half, running inside §F's existing daily sweep — no new cron, and no stored
 * history, so no new table.
 *
 * §G Tier 1 (`metaOptimisationCoverage`) asks whether the EVENT an ad set bids on is
 * arriving. This asks whether the PAGE it points at can report anything at all. They fail
 * independently: Tier 1 is silent on a lander with no pixel, because an event nobody
 * receives and an event nobody can send look the same from the insights side.
 *
 * ─── Why there is no streak here, unlike Tier 1 ──────────────────────────────────────
 *
 * Tier 1 streaks over spending days because insights hand back real history. A destination
 * check has none — it is a point-in-time read of served HTML — and inventing a streak would
 * mean persisting yesterday's answer, which is a new table and the data-plane gate this
 * design exists to avoid. Two properties replace it:
 *
 *   1. only a SUCCESSFUL fetch can produce a finding. 403, timeout, non-2xx and SSRF-refused
 *      are `unverifiable`, logged and never paged. Transience lives entirely in the fetch.
 *   2. a 200 whose HTML carries no pixel is deterministic, not flaky. Re-reading it tomorrow
 *      would return the same answer.
 *
 * ─── Measured against real production, 2026-08-18 ────────────────────────────────────
 *
 * A read-only probe of all 21 connected ad accounts, which is where every "NOT a finding"
 * rule below comes from rather than from imagination:
 *
 *   6 accounts with ACTIVE ads · 46 ad destinations collapsing to 6 DISTINCT urls
 *   41 of 84 ACTIVE ads carried no destination url at all  → on-Facebook lead forms
 *   1 destination was www.facebook.com/profile.php?id=…    → a Page, not a website
 *   1 of 4 real sites answered 403 to a plain fetch        → bot protection
 *   every pixel-less account ran ONLY LINK_CLICKS/MESSAGES/OUTCOME_ENGAGEMENT
 *
 * A check that alerted on any of those would have paged a human about correct configuration
 * on its very first run.
 */

import { isConversionOptimisedObjective } from './metaTrackingMonitor';

/**
 * Upper bound on destinations fetched per ad account per sweep.
 *
 * Generous on purpose: the whole production portfolio deduped to SIX distinct urls, so this
 * is a runaway guard rather than a rationing decision. What it must never do is silently
 * shrink the check — anything past the cap is reported in `urlsNotChecked`.
 */
export const MAX_DESTINATION_URLS_CHECKED = 20;

/** Meta-owned destinations. A page pixel can never live on one, so it is not a finding. */
const META_OWNED_HOSTS = new Set([
  'facebook.com', 'fb.com', 'fb.me', 'messenger.com', 'm.me',
  'instagram.com', 'instagr.am', 'whatsapp.com', 'wa.me', 'threads.net',
]);

/** App-store destinations measure through app events, never a page pixel. Mirrors the same
 *  list in `metaTrackingPreflight`, which keeps its copy private. */
const APP_STORE_HOSTS = new Set([
  'apps.apple.com', 'itunes.apple.com', 'play.google.com', 'apps.microsoft.com',
]);

/**
 * Is this destination a web page whose HTML could carry a pixel at all?
 *
 * Deliberately a SUPERSET of `metaTrackingPreflight`'s private `isUnmeasurableByDesign`,
 * which excludes app stores but NOT Meta-owned hosts. A live ACTIVE ad pointing at
 * `www.facebook.com/profile.php?id=…` was found in the 2026-08-18 probe; fetching it returns
 * 400, which that gate would read as `unverifiable` and therefore BLOCK. That is a real
 * (separate) false-block in the launch gate — recorded, not silently fixed from here, because
 * changing what a money gate blocks is not a side effect this change gets to have.
 */
export function isCheckableDestination(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return !META_OWNED_HOSTS.has(host) && !APP_STORE_HOSTS.has(host);
}

export interface DestinationAd {
  adId: string;
  adName?: string;
  campaignId?: string;
  campaignName?: string;
  /** Campaign objective. Judged through `isConversionOptimisedObjective`, so an objective
   *  Meta invents tomorrow is judged rather than silently skipped. */
  objective?: string;
  effectiveStatus?: string;
  /** EVERY destination on the ad. A carousel has one per card, so a single bad card is a
   *  hole in the attribution — the same rule `adUtmAuditService` already applies to UTMs. */
  destinationUrls: string[];
}

export interface DestinationObservation {
  url: string;
  /**
   * Only `unverifiable` is load-bearing here.
   *
   * `preflightMetaTrackingGate` folds ownership INTO its `measured`, which cannot separate
   * "no pixel at all" from "someone else's pixel" — and those two have different owners and
   * different fixes. So the ownership decision is re-made below from `detectedPixelIds`, and
   * this field is used only to route genuine read failures.
   */
  status: 'measured' | 'unmeasured' | 'unverifiable';
  /** Pixel ids found in the served HTML, label stripped. */
  detectedPixelIds: string[];
  error?: string;
}

export type DestinationFindingReason = 'no_pixel' | 'foreign_pixel';

export interface DestinationFinding {
  adId: string;
  adName?: string;
  campaignName?: string;
  url: string;
  reason: DestinationFindingReason;
  detectedPixelIds: string[];
}

export type DestinationNotApplicableReason =
  | 'no_destination'
  | 'non_conversion_objective'
  | 'not_a_website';

export type DestinationCoverageVerdict = {
  /** The only state that pages anyone: paid, conversion-optimised traffic to a page that
   *  cannot report back to the account paying for it. */
  alerting: DestinationFinding[];
  /** Read failures and accounts with nothing to compare against. Logged, never paged. */
  unverifiable: Array<{ adId: string; url: string; error?: string }>;
  /** Correct configuration that merely has no page to check. Never a fault. */
  notApplicable: Array<{ adId: string; url?: string; reason: DestinationNotApplicableReason }>;
  /** Ad+destination pairs that carry a pixel the account owns. */
  okCount: number;
};

/**
 * The destinations worth fetching for one account: conversion-optimised ads only, real web
 * pages only, deduplicated, capped — and explicit about anything the cap dropped.
 */
export function collectCheckableUrls(
  ads: DestinationAd[],
): { urls: string[]; urlsNotChecked: string[] } {
  const seen: string[] = [];
  for (const ad of Array.isArray(ads) ? ads : []) {
    if (!isConversionOptimisedObjective(ad?.objective)) continue;
    for (const url of Array.isArray(ad?.destinationUrls) ? ad.destinationUrls : []) {
      if (!isCheckableDestination(url)) continue;
      if (!seen.includes(url)) seen.push(url);
    }
  }
  return {
    urls: seen.slice(0, MAX_DESTINATION_URLS_CHECKED),
    urlsNotChecked: seen.slice(MAX_DESTINATION_URLS_CHECKED),
  };
}

/**
 * Judge each ad against what its destinations actually served.
 *
 * Ordering is the design. Every "not a finding" case is decided BEFORE anything can alert,
 * so a new failure mode can only ever make this quieter, never noisier.
 */
export function evaluateDestinationCoverage(
  ads: DestinationAd[],
  observations: Record<string, DestinationObservation>,
  ownedPixelIds: string[],
): DestinationCoverageVerdict {
  const verdict: DestinationCoverageVerdict = {
    alerting: [], unverifiable: [], notApplicable: [], okCount: 0,
  };
  const owned = new Set(
    (Array.isArray(ownedPixelIds) ? ownedPixelIds : []).filter(Boolean).map(String),
  );
  const seenObservations = observations && typeof observations === 'object' ? observations : {};

  for (const ad of Array.isArray(ads) ? ads : []) {
    if (!ad || typeof ad.adId !== 'string') continue;

    // An engagement or traffic campaign is not trying to convert, so a page with no pixel is
    // correct rather than broken. Every pixel-less real account in the probe was exactly this.
    if (!isConversionOptimisedObjective(ad.objective)) {
      verdict.notApplicable.push({ adId: ad.adId, reason: 'non_conversion_objective' });
      continue;
    }

    const urls = (Array.isArray(ad.destinationUrls) ? ad.destinationUrls : [])
      .filter((u): u is string => typeof u === 'string' && u.trim() !== '');

    // No destination at all is an on-Facebook lead form — there is no lander to instrument.
    // This was HALF of all ACTIVE ads in production, so getting it wrong would have buried
    // every real finding under noise.
    if (!urls.length) {
      verdict.notApplicable.push({ adId: ad.adId, reason: 'no_destination' });
      continue;
    }

    for (const url of urls) {
      if (!isCheckableDestination(url)) {
        verdict.notApplicable.push({ adId: ad.adId, url, reason: 'not_a_website' });
        continue;
      }

      const observation = seenObservations[url];

      // An unobserved url must NEVER count as healthy. Defaulting the other way would let a
      // sweep that fetched nothing at all report a clean bill of health for every account.
      if (!observation) {
        verdict.unverifiable.push({ adId: ad.adId, url, error: 'destination was not checked' });
        continue;
      }
      if (observation.status === 'unverifiable') {
        verdict.unverifiable.push({ adId: ad.adId, url, error: observation.error });
        continue;
      }

      // Nothing to compare against. A page carrying tracking while the paying account owns no
      // pixel at all is a CONNECTION problem, not a page problem, and paging the person who
      // owns the page would send it to the wrong desk.
      if (!owned.size) {
        verdict.unverifiable.push({
          adId: ad.adId, url, error: 'ad account has no pixels to compare against',
        });
        continue;
      }

      const detected = (Array.isArray(observation.detectedPixelIds)
        ? observation.detectedPixelIds : []).map(String).filter(Boolean);

      if (!detected.length) {
        verdict.alerting.push({
          adId: ad.adId, adName: ad.adName, campaignName: ad.campaignName,
          url, reason: 'no_pixel', detectedPixelIds: [],
        });
        continue;
      }
      if (detected.some((id) => owned.has(id))) {
        verdict.okCount++;
        continue;
      }
      // Instrumented, and reporting to somebody else. A naive "is there any tracking?" check
      // passes this — which is exactly how `hireemma.ai` ran against a pixel its own ad
      // account did not own.
      verdict.alerting.push({
        adId: ad.adId, adName: ad.adName, campaignName: ad.campaignName,
        url, reason: 'foreign_pixel', detectedPixelIds: detected,
      });
    }
  }

  return verdict;
}

/**
 * Ads requested per page.
 *
 * NOT 200. Haven's account answered a 200-row request with *"Please reduce the amount of
 * data you're asking for"* during the 2026-08-18 probe — the nested `creative{…}` expansion
 * makes each row expensive, so the page size that works for a bare list does not work here.
 */
export const DESTINATION_ADS_PAGE_SIZE = 50;

/** Paging backstop. An account needing more than this has bigger problems than this check. */
export const MAX_AD_PAGES = 10;

export interface DestinationFetchDeps {
  fetchImpl?: typeof fetch;
  /** HTML boundary, forwarded to the ENG-941 checker so tests never touch the network. */
  fetchHtml?: (url: string) => Promise<string>;
}

export type DestinationInputs = {
  status: 'ok' | 'fetch_error';
  ads: DestinationAd[];
  ownedPixelIds: string[];
  observations: Record<string, DestinationObservation>;
  /** Destinations past the cap. Surfaced so a reduced check cannot pass for a complete one. */
  urlsNotChecked: string[];
  error?: string;
};

/**
 * The reads §G needs: every ACTIVE ad's destinations, the pixels the paying account owns,
 * and what each distinct destination actually served.
 *
 * `effective_status=['ACTIVE']` is applied at Meta rather than here. An ad paused at ANY
 * level is not spending, and this check is only ever about money currently leaving.
 *
 * Fetching is delegated wholesale to `preflightMetaTrackingGate` (ENG-941) — the SSRF guard,
 * the manual redirect follower, the inert-JavaScript stripper and the pixel detector are all
 * security-sensitive and already reviewed. A second copy of any of them would be the ENG-683
 * mistake repeated.
 */
export async function fetchDestinationInputs(
  adAccountId: string,
  accessToken: string,
  deps?: DestinationFetchDeps,
): Promise<DestinationInputs> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const apiVersion = process.env.META_API_VERSION || 'v25.0';
  const empty = { ads: [], ownedPixelIds: [], observations: {}, urlsNotChecked: [] };

  const readJson = async (url: string): Promise<any> => {
    const response = await fetchImpl(url);
    const body: any = await response.json();
    if (!response.ok || body?.error) {
      throw new Error(body?.error?.message || `HTTP ${response.status}`);
    }
    return body;
  };

  const ads: DestinationAd[] = [];
  const ownedPixelIds: string[] = [];

  try {
    const { MetaService } = await import('./metaService');

    const params = new URLSearchParams({
      fields: 'id,name,effective_status,campaign{id,name,objective},' +
        'creative{link_url,object_story_spec,asset_feed_spec}',
      effective_status: JSON.stringify(['ACTIVE']),
      limit: String(DESTINATION_ADS_PAGE_SIZE),
    });
    let url: string =
      `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/ads?${params}` +
      `&access_token=${encodeURIComponent(accessToken)}`;

    for (let page = 0; page < MAX_AD_PAGES && url; page++) {
      const body = await readJson(url);
      for (const row of Array.isArray(body?.data) ? body.data : []) {
        const campaign = row?.campaign ?? {};
        ads.push({
          adId: String(row?.id ?? ''),
          adName: row?.name,
          campaignId: campaign?.id != null ? String(campaign.id) : undefined,
          campaignName: campaign?.name,
          objective: campaign?.objective,
          effectiveStatus: row?.effective_status,
          destinationUrls: MetaService.extractCreativeDestinationUrls(row?.creative),
        });
      }
      url = typeof body?.paging?.next === 'string' ? body.paging.next : '';
    }

    // Losing this read is NOT survivable: with no owned pixels to compare against, every
    // destination becomes unjudgeable, and reporting that as "nothing found" would look
    // exactly like a healthy account.
    const pixelBody = await readJson(
      `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/adspixels` +
      `?fields=id&limit=100&access_token=${encodeURIComponent(accessToken)}`,
    );
    for (const row of Array.isArray(pixelBody?.data) ? pixelBody.data : []) {
      if (row?.id != null) ownedPixelIds.push(String(row.id));
    }
  } catch (error: any) {
    return { status: 'fetch_error', ...empty, error: error?.message || 'request failed' };
  }

  const { urls, urlsNotChecked } = collectCheckableUrls(ads);
  const observations: Record<string, DestinationObservation> = {};

  if (urls.length) {
    try {
      const { preflightMetaTrackingGate } = await import('./metaTrackingPreflight');
      const gate = await preflightMetaTrackingGate(
        urls, ownedPixelIds, deps?.fetchHtml ? { fetchHtml: deps.fetchHtml } : {},
      );
      for (const result of gate.results ?? []) {
        observations[result.url] = {
          url: result.url,
          status: result.status,
          detectedPixelIds: (result.mechanisms ?? []).map((m) => m.replace(/^PIXEL:/, '')),
          error: result.error,
        };
      }
    } catch (error: any) {
      // The Meta reads succeeded, so the account IS judgeable — just not today. Returning
      // `ok` with no observations makes every destination `unverifiable`, which is logged
      // and pages nobody. Failing the whole account here would discard the ad list too.
      console.warn(
        `[Tracking Monitor] ${adAccountId}: §G destination fetch failed — ${error?.message}`,
      );
    }
  }

  return { status: 'ok', ads, ownedPixelIds, observations, urlsNotChecked };
}
