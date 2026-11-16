## ENG-3072: Zoma first-ad check covers Google Ads (2026-11-16)

- `verifyZomaFirstAds` used to drop every go-live approval whose platform was not Meta. It now
  picks the provider reads by the approval event's platform: the top-level `FirstAdDeps` reads
  are Meta's, `deps.google` are Google's (`googleFirstAdDeps`, three GAQL reads through
  `googleAdsService.queryReporting`). An event with no platform is still treated as Meta.
- The Google gateway never recorded `writeKind`, so a Google `UPDATE status=ENABLED` was stored
  as a plain `UPDATE` and classified `edit`. It now records `approve` for CAMPAIGN, AD_GROUP,
  AD and ASSET_GROUP (enabling a keyword stays `edit`) and `pause` for status=PAUSED.
- Not retroactive: Google updates recorded before this deploys carry no status, so an earlier
  Google go-live is not counted until the campaign is approved through Zoma again. Nothing is
  inferred from old events and there is no backfill.
- `zomaFirstAdLive.platform` on the user row can now hold `google_ads` as well as `meta`.
  For Google, `campaignId` and `approvedEntity.id` are resource names
  (`customers/<cid>/campaigns/<id>`) and `effectiveStatus` is Google's word (`ENABLED`, `PAUSED`).
- Lifetime impressions: `SELECT metrics.impressions FROM campaign WHERE campaign.resource_name = ...`
  with no date segment. Not checked against a live Google account.
