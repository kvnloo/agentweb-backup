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

import {
  AdPlatform,
  UTM_KEYS,
  UtmKey,
  existingUtmKeys,
} from "../utils/adUtm";

/**
 * The reads the audit needs, abstracted away from any one platform. A wiring
 * adapter implements this over a real platform service. Deliberately contains
 * NO write method — the audit cannot mutate through a port it was never given.
 */
export interface AdReadPort {
  listCampaigns(
    userId: string,
    accountId: string,
  ): Promise<Array<{ id: string; name: string }>>;

  listAdDestinations(
    userId: string,
    accountId: string,
    campaignId: string,
  ): Promise<
    Array<{
      adId: string;
      /** Meta link_url / Google finalUrl / LinkedIn landingPage. */
      destinationUrl?: string;
      /** Meta url_tags / Google finalUrlSuffix; undefined elsewhere. */
      appendField?: string;
    }>
  >;
}

/** One row of the AC3 report. */
export interface CampaignAuditReport {
  campaignId: string;
  name: string;
  /** True iff every ad under the campaign carries all REQUIRED_KEYS. */
  tagged: boolean;
  /** Required keys missing from at least one ad, in canonical order. */
  missingKeys: UtmKey[];
  /** Ad IDs that are not fully tagged (missing a required key or malformed). */
  untaggedAdIds: string[];
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
 * The UTM keys effectively present on one ad — the union of its destination
 * URL's query keys and its append field's keys (platforms merge the two at
 * delivery). `malformed` is true when a present destination URL fails to parse;
 * such an ad degrades to untagged rather than crashing the whole audit.
 */
function keysForAd(ad: {
  destinationUrl?: string;
  appendField?: string;
}): { keys: Set<UtmKey>; malformed: boolean } {
  const keys = new Set<UtmKey>();
  let malformed = false;

  if (ad.destinationUrl) {
    try {
      for (const k of existingUtmKeys(ad.destinationUrl)) keys.add(k);
    } catch {
      malformed = true;
    }
  }

  if (ad.appendField) {
    for (const k of appendFieldUtmKeys(ad.appendField)) keys.add(k);
  }

  return { keys, malformed };
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
): Promise<CampaignAuditReport[]> {
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new Error(`adUtmAudit: unsupported platform "${platform}"`);
  }

  const campaigns = await port.listCampaigns(userId, accountId);
  const reports: CampaignAuditReport[] = [];

  for (const campaign of campaigns) {
    const ads = await port.listAdDestinations(userId, accountId, campaign.id);

    const untaggedAdIds: string[] = [];
    const missing = new Set<UtmKey>();

    for (const ad of ads) {
      const { keys, malformed } = keysForAd(ad);
      const missingForAd = REQUIRED_KEYS.filter((k) => !keys.has(k));
      const adTagged = !malformed && missingForAd.length === 0;

      if (!adTagged) {
        untaggedAdIds.push(ad.adId);
        for (const k of missingForAd) missing.add(k);
      }
    }

    reports.push({
      campaignId: campaign.id,
      name: campaign.name,
      tagged: untaggedAdIds.length === 0,
      // Canonical order, deterministic regardless of ad iteration order.
      missingKeys: REQUIRED_KEYS.filter((k) => missing.has(k)),
      untaggedAdIds,
    });
  }

  return reports;
}
