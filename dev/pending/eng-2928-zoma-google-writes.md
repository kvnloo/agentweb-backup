## ENG-2928: Zoma Google Ads — keywords, negatives, RSA, PMax assets and asset groups (2026-11-10)

The Zoma Google toolkit (`backend/src/mcp/googleToolkitWrites.ts`) now covers KEYWORD ADD /
UPDATE status / REMOVE / ADD_NEGATIVE (ad group or campaign level), AD CREATE
(RESPONSIVE_SEARCH_AD, 3-15 headlines <=30 chars, 2-4 descriptions <=90) / UPDATE status,
ASSET_GROUP CREATE / UPDATE status, and ASSET UPLOAD (IMAGE/LOGO from https or a
`zoma_prepare_upload` file, TEXT, YouTube VIDEO). PERFORMANCE_MAX CAMPAIGN CREATE now requires
and forwards `brand_business_name` + `brand_logo_asset_resource_name`, the gap vs Emma's
`call_google_ads_api` that made Zoma-created PMax campaigns unservable. Everything dispatches
through the Emma handler; guarded writes keep preview + single-use token, PAUSED creates and
independent GAQL read-back. ASSET UPLOAD is non-spending, so it has no token but keeps the write
gate, key scope, read-back and metering. New Emma/service path: `ASSET_GROUP UPDATE` status
(`googleAdsService.updateAssetGroup`, creative-addition gate on ENABLED) and TEXT assets in
`uploadAsset`. GAQL read shapes are exercised with an HTTP-level fake only, not yet against live
Google Ads.
