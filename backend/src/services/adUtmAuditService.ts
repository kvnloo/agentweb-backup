/**
 * adUtmAuditService — ENG-239 AC3.
 *
 * "Existing campaigns are not silently modified; a report/tool lists campaigns
 * lacking UTMs so the team can opt in per client."
 *
 * This service is the report side of that AC. It is STRICTLY READ-ONLY: it never
 * mutates a campaign, an ad, or a destination URL. It only reads, so running it
 * can never be the thing that "silently modifies" an existing campaign — which is
 * exactly what the AC forbids.
 *
 * Because the platform services (metaService / googleAdsService /
 * linkedInAdsService) are owned by other work in flight, this file does not touch
 * them. Instead it defines an injectable read port (`AdReadPort`) describing the
 * two reads the audit needs, and audits against that port. The wiring step
 * connects each real platform service to the port (see the header note below for
 * the exact read methods each platform must expose).
 *
 * ── What each platform service must expose for the port adapter ──────────────
 *   Meta (metaService.ts):
 *     - listCampaigns(userId, accountId) -> [{ id, name }]
 *         from the Graph API `act_<accountId>/campaigns` (fields id,name).
 *     - per ad: `link_url` (creative destination) -> destinationUrl
 *               `url_tags`  (creative append field) -> appendField
 *   Google (googleAdsService.ts):
 *     - listCampaigns(userId, accountId) -> [{ id, name }] via GAQL on `campaign`.
 *     - per ad: `finalUrls[0]` (ad_group_ad.ad.final_urls) -> destinationUrl
 *               `finalUrlSuffix` (ad_group_ad.ad.final_url_suffix) -> appendField
 *   LinkedIn (linkedInAdsService.ts):
 *     - listCampaigns(userId, accountId) -> [{ id, name }] via the campaigns
 *       endpoint (campaign group / campaign).
 *     - per ad: landingPage / contentLandingPage / card.landing_page -> destinationUrl
 *               appendField is undefined (LinkedIn has no native tracking field).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { AdPlatform, UTM_KEYS, UtmKey, readUtmKeys } from "../utils/adUtm";

/**
 * The reads the audit needs, abstracted away from any one platform. A wiring
 * adapter implements this over a real platform service. Deliberately contains
 * NO write method — the audit cannot mutate through a port it was never given.
 */
/**
 * A port read that MAY report its own completeness.
 *
 * Deliberately a union with the bare array: Meta's reads are paginated and bounded
 * (`metaService`'s drainCursor reports `truncated`), so that adapter can say whether it saw
 * everything. The Google and LinkedIn services expose no equivalent signal, so their adapters
 * keep returning a plain array and are left untouched — `truncated: undefined` therefore means
 * "this platform does not report completeness", which must never be rendered as "complete".
 * Widening the type rather than requiring an object keeps those two adapters unchanged, which
 * is the only way to be certain this change cannot regress them.
 */
export type PortRead<T> = T[] | { items: T[]; truncated?: boolean };

/** Normalise either shape. `truncated` stays undefined when the platform does not report it. */
export function readPortResult<T>(read: PortRead<T>): { items: T[]; truncated?: boolean } {
  return Array.isArray(read) ? { items: read } : { items: read.items ?? [], truncated: read.truncated };
}

export interface AdReadPort {
  listCampaigns(
    userId: string,
    accountId: string,
  ): Promise<PortRead<{ id: string; name: string }>>;

  listAdDestinations(
    userId: string,
    accountId: string,
    campaignId: string,
  ): Promise<
    PortRead<{
      adId: string;
      /**
       * EVERY destination URL on the ad. A Meta carousel has one per card, so an
       * ad is only tagged if all of them are — a single untagged card is a hole in
       * the attribution.
       */
      destinationUrls?: string[];
      /** Meta url_tags / Google finalUrlSuffix; undefined elsewhere. */
      appendField?: string;
    }>
  >;
}

/** One row of the AC3 report. */
export interface CampaignAuditReport {
  campaignId: string;
  name: string;
  /** True iff no ad needs action: none untagged, none unreadable. */
  tagged: boolean;
  /** Required keys missing from at least one ad, in canonical order. */
  missingKeys: UtmKey[];
  /** Ads DEFINITELY missing a required key. Safe to act on. */
  untaggedAdIds: string[];
  /**
   * Ads whose destination we could not read (no URL extracted, or an unparseable
   * one). Deliberately NOT reported as untagged: acting on a false positive means
   * swapping a Meta creative, which resets the ad's learning phase — so an
   * unreadable ad is surfaced for a human to look at, never auto-fixed.
   */
  unreadableAdIds: string[];
  /**
   * The ad read for THIS campaign stopped at a bound, so `untaggedAdIds` / `unreadableAdIds`
   * cover only part of it. A campaign that looks clean here may simply have had its untagged
   * ads never fetched — so `tagged: true` alongside this flag means "nothing found wrong in
   * what we read", not "nothing wrong".
   */
  adReadIncomplete?: true;
}

/**
 * The keys an ad must carry to count as tagged. `utm_content` is intentionally
 * NOT required: LinkedIn ships without it (no click-time macro, ad ID unknown at
 * create time), so requiring it would flag every LinkedIn ad as untagged.
 */
export const REQUIRED_KEYS: UtmKey[] = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
];

const VALID_PLATFORMS: readonly AdPlatform[] = ["meta", "google", "linkedin"];

/**
 * UTM keys present in a platform append field (Meta `url_tags`, Google
 * `finalUrlSuffix`), which is a bare query string like
 * `utm_source=meta&utm_content={{ad.id}}`. Parsing is lenient and never throws;
 * matching is case-insensitive, mirroring `existingUtmKeys`.
 *
 * Note this checks the field as CONFIGURED, macro and all — it never waits for a
 * click to resolve `{{ad.id}}`/`{creative}` into a real value. That's a deliberate
 * reading of ENG-239 AC1 ("verifiable in the platform's ad settings"): the macro
 * text visible in Ads Manager IS the proof the tagging pipeline ran correctly: a
 * human (or this audit) can see it without ever firing a click. Requiring a
 * resolved click to call something "tagged" isn't how this tool works at all.
 */
function appendFieldUtmKeys(appendField: string): Set<UtmKey> {
  const present = new Set<UtmKey>();
  const raw = appendField.replace(/^[?&]+/, "");
  const params = new URLSearchParams(raw);
  for (const rawKey of params.keys()) {
    const lower = rawKey.toLowerCase() as UtmKey;
    if ((UTM_KEYS as readonly string[]).includes(lower)) {
      present.add(lower);
    }
  }
  return present;
}

/**
 * Evaluate one ad.
 *
 * The platforms MERGE the append field into every destination URL at delivery
 * (Meta url_tags, Google final_url_suffix), so a key counts as present on a URL if
 * it is on the URL OR in the append field. An ad is tagged only if EVERY one of its
 * destination URLs ends up carrying all REQUIRED_KEYS — one untagged carousel card
 * is a hole in the attribution.
 *
 * `unreadable` means we could not determine the ad's destinations at all (none
 * extracted, or one that will not parse). That is NOT the same as "untagged": we
 * report it separately so a human looks, because acting on a false "untagged"
 * means swapping a live Meta creative and resetting its learning phase.
 */
function evaluateAd(ad: {
  destinationUrls?: string[];
  appendField?: string;
}): { missing: UtmKey[]; unreadable: boolean } {
  const urls = (ad.destinationUrls ?? []).filter(Boolean);
  const appendKeys = appendFieldUtmKeys(ad.appendField ?? "");

  if (urls.length === 0) return { missing: [], unreadable: true };

  const missing = new Set<UtmKey>();
  for (const url of urls) {
    const urlKeys = readUtmKeys(url);
    if (!urlKeys) return { missing: [], unreadable: true };
    for (const key of REQUIRED_KEYS) {
      if (!urlKeys.has(key) && !appendKeys.has(key)) missing.add(key);
    }
  }
  return { missing: REQUIRED_KEYS.filter((k) => missing.has(k)), unreadable: false };
}

/**
 * Audit every campaign for a platform/account and report which lack UTMs.
 *
 * A campaign is `tagged` only if EVERY ad under it carries all of REQUIRED_KEYS.
 * A campaign with zero ads is reported as tagged: there is nothing to opt in and
 * nothing missing (the universal "every ad has all keys" holds vacuously over an
 * empty set), so flagging it would be a false positive that adds noise to the
 * report the team uses to decide which clients to opt in.
 *
 * Strictly read-only: only the port's two read methods are ever called.
 */
export async function auditCampaigns(
  platform: AdPlatform,
  userId: string,
  accountId: string,
  port: AdReadPort,
  /**
   * Optional out-param reporting whether every read behind this audit was complete.
   *
   * An out-param rather than a wider return type on purpose: `CampaignAuditReport[]` is
   * destructured at ~30 call sites, and rewriting all of them to unwrap an envelope is a large
   * mechanical edit whose main risk is silently weakening an assertion along the way. Callers
   * that do not care are unaffected; the one caller that renders a clean bill of health passes
   * an object and reads `incomplete` afterwards.
   *
   * `incomplete` is set only when a read said so. A platform that does not report completeness
   * leaves it untouched — absence means "not reported", never "verified complete".
   */
  completeness?: { incomplete?: boolean; campaignListIncomplete?: boolean },
): Promise<CampaignAuditReport[]> {
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(`adUtmAudit: unsupported platform "${platform}"`);
  }

  const { items: campaigns, truncated: campaignsTruncated } = readPortResult(
    await port.listCampaigns(userId, accountId),
  );
  if (campaignsTruncated && completeness) {
    // Campaigns we never saw cannot be audited, so no account-level conclusion is complete —
    // including "all clean", which is the claim this exists to stop.
    completeness.incomplete = true;
    completeness.campaignListIncomplete = true;
  }
  const reports: CampaignAuditReport[] = [];

  for (const campaign of campaigns) {
    const { items: ads, truncated: adsTruncated } = readPortResult(
      await port.listAdDestinations(userId, accountId, campaign.id),
    );
    if (adsTruncated && completeness) completeness.incomplete = true;

    const untaggedAdIds: string[] = [];
    const unreadableAdIds: string[] = [];
    const missing = new Set<UtmKey>();

    for (const ad of ads) {
      const { missing: missingForAd, unreadable } = evaluateAd(ad);
      if (unreadable) {
        unreadableAdIds.push(ad.adId);
      } else if (missingForAd.length > 0) {
        untaggedAdIds.push(ad.adId);
        for (const k of missingForAd) missing.add(k);
      }
    }

    reports.push({
      campaignId: campaign.id,
      name: campaign.name,
      // "No action needed" — nothing definitively untagged AND nothing we could not read.
      tagged: untaggedAdIds.length === 0 && unreadableAdIds.length === 0,
      // Canonical order, deterministic regardless of ad iteration order.
      missingKeys: REQUIRED_KEYS.filter((k) => missing.has(k)),
      untaggedAdIds,
      unreadableAdIds,
      ...(adsTruncated ? { adReadIncomplete: true as const } : {}),
    });
  }

  return reports;
}
