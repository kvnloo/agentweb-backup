/**
 * adUtmAuditAdapters — ENG-239 AC3, the wiring step.
 *
 * `adUtmAuditService` defines the audit against an injectable `AdReadPort` so it stays free of
 * any one platform's SDK. This file is the other half: one `AdReadPort` per platform, built on
 * the read methods the platform services expose.
 *
 * Deliberately thin — fetch and shape, nothing else. No UTM parsing, no tagged/untagged
 * decision: that logic lives once, in `adUtmAuditService`, and must not be duplicated per
 * platform where it could drift.
 *
 * Every method here is READ-ONLY. `AdReadPort` has no write method, so the audit cannot mutate
 * a campaign through it even by mistake — which is exactly what AC3 forbids ("existing campaigns
 * are not silently modified").
 *
 * THE INVARIANT THESE ADAPTERS EXIST TO UPHOLD: they must read destination URLs from exactly the
 * places the taggers write them, plus the places the platform inherits from. A missed location
 * means a healthy campaign is reported "untagged", and acting on that means swapping a live Meta
 * creative — which resets the ad's learning phase and costs a paying client money. The
 * extraction itself therefore lives next to each platform's write sites (in metaService /
 * googleAdsService / linkedInAdsService), where the two can be diffed against each other.
 */

import { AdReadPort } from "./adUtmAuditService";
import { metaService } from "./metaService";
import { googleAdsService } from "./googleAdsService";
import * as linkedInAdsService from "./linkedInAdsService";

// ─── Meta ────────────────────────────────────────────────────────────────────

/**
 * Meta's Marketing API token is a platform-level credential in Secrets Manager (not per-user) —
 * the same resolution every Meta caller in the backend uses.
 */
async function metaAccessToken(): Promise<string> {
  const { getMetaAccessToken } = await import("../utils/secretsManager");
  return getMetaAccessToken();
}

export const metaAdReadPort: AdReadPort = {
  async listCampaigns(_userId: string, accountId: string) {
    const token = await metaAccessToken();
    const campaigns = await metaService.listCampaigns(accountId, token);
    return (campaigns ?? []).map((c: any) => ({
      id: String(c.id),
      name: c.name ?? "",
    }));
  },

  async listAdDestinations(_userId: string, accountId: string, campaignId: string) {
    const token = await metaAccessToken();
    // The campaignId is pushed down to Meta's `filtering` param so we do not refetch the whole
    // account's ads once per campaign. We ALSO filter here: if Meta ever ignores the filter, an
    // unfiltered response must not attribute another campaign's ads to this one.
    const ads = await metaService.listAdsForUtmAudit(accountId, token, campaignId);
    return ads
      .filter((ad) => ad.campaignId === campaignId)
      .map((ad) => ({
        adId: ad.adId,
        destinationUrls: ad.destinationUrls,
        appendField: ad.urlTags, // Meta `url_tags`, appended to every link at delivery.
      }));
  },
};

// ─── Google ──────────────────────────────────────────────────────────────────

export const googleAdReadPort: AdReadPort = {
  async listCampaigns(userId: string, customerId: string) {
    // The campaign resource is authoritative: it includes campaigns with zero ads, which the
    // ad_group_ad query cannot see.
    const campaigns = await googleAdsService.listCampaigns(userId, customerId);
    return campaigns.map((c) => ({ id: String(c.id), name: c.name ?? "" }));
  },

  async listAdDestinations(userId: string, customerId: string, campaignId: string) {
    const ads = await googleAdsService.listAdsForUtmAudit(userId, customerId, campaignId);
    return ads
      .filter((ad) => ad.campaignId === campaignId)
      .map((ad) => ({
        adId: ad.adId,
        destinationUrls: ad.destinationUrls,
        // Already resolved most-specific-wins (ad suffix REPLACES campaign suffix) by the service.
        appendField: ad.appendField,
      }));
  },
};

// ─── LinkedIn ────────────────────────────────────────────────────────────────

/**
 * Resolve the LinkedIn Ads access token for a user's ad account, refreshing it when it is
 * expiring — the same resolution `agentModeService.getLinkedInAdsCredentials` performs, built
 * on the same primitives (org-shared account lookup, `refreshAccessToken`, `updateAccountTokens`).
 *
 * It is duplicated rather than imported because that method is private on agentModeService, and
 * importing a 473KB service into the audit path to reach it would be far worse. Extracting it
 * into a shared helper is the right follow-up, but it belongs in a commit that can also update
 * agentModeService's call site.
 */
async function linkedInAccessToken(userId: string, accountId: string): Promise<string> {
  const { getAccountsWithOwnerIncludingOrgShared, updateAccountTokens } = await import(
    "./connectedAccountsDb"
  );
  const accounts = await getAccountsWithOwnerIncludingOrgShared(userId);
  const account = accounts.find(
    (a: any) =>
      a.platform === "linkedin_ads" &&
      (a.config as any)?.account_type === "ad_account" &&
      (a.config as any)?.access_token &&
      a.account_id === accountId,
  );
  if (!account) {
    throw new Error(
      `LinkedIn Ads account "${accountId}" is not connected. Connect it in Settings before running the UTM audit.`,
    );
  }

  const cfg = account.config as any;
  const bufferMs = 5 * 60 * 1000;
  if (cfg.token_expires_at && cfg.token_expires_at > Date.now() + bufferMs) {
    return cfg.access_token;
  }
  if (!cfg.refresh_token) {
    throw new Error(
      "LinkedIn Ads access token expired and no refresh token is available. Reconnect the account.",
    );
  }

  const { getLinkedInAdsConfig } = await import("../config/integrations");
  const oauthConfig = await getLinkedInAdsConfig();
  const tokens = await linkedInAdsService.refreshAccessToken(
    cfg.refresh_token,
    oauthConfig.clientId,
    oauthConfig.clientSecret,
  );
  // Write back to the OWNER's record — for an org-shared account that is not the caller.
  await updateAccountTokens(
    (account as any).userId,
    "linkedin_ads" as any,
    {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: Date.now() + tokens.expires_in * 1000,
    },
    account.account_id,
  );
  return tokens.access_token;
}

export const linkedInAdReadPort: AdReadPort = {
  async listCampaigns(userId: string, accountId: string) {
    const token = await linkedInAccessToken(userId, accountId);
    const result = await linkedInAdsService.listCampaigns(token, accountId);
    if (!result.success) {
      // Never degrade to an empty list: the audit would read that as "no campaigns" and report
      // a clean bill of health for an account it never actually managed to read.
      throw new Error(`LinkedIn UTM audit: could not list campaigns — ${result.error}`);
    }
    return (result.data?.elements ?? []).map((c: any) => ({
      id: String(c.id),
      name: c.name ?? "",
    }));
  },

  async listAdDestinations(userId: string, accountId: string, campaignId: string) {
    const token = await linkedInAccessToken(userId, accountId);
    const ads = await linkedInAdsService.listAdsForUtmAudit(token, accountId, campaignId);
    return ads.map((ad) => ({
      adId: ad.adId,
      destinationUrls: ad.destinationUrls,
      // LinkedIn has no native append field — the UTMs are on the URL or nowhere.
      appendField: undefined,
    }));
  },
};
