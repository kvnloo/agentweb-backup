## ENG-2823: Zoma Google Ads toolkit on a provider-pluggable template (2026-11-05)

- The Zoma layer now runs on ad-platform providers (`backend/src/mcp/zomaProviders.ts`): Meta is
  provider #1 (same resolution rules and messages), Google Ads provider #2. Account resolution
  (`resolveProviderAccount`), the preview → confirm token guard (`mcp/zomaWriteGuard.ts`, extracted
  unchanged from `metaToolkitWrites.ts`), setup status, and metering are shared.
- Google Ads is dark behind `ZOMA_GOOGLE_ADS_ENABLED=true`. With it off, the toolkit lists, accepts
  and reports exactly what it did before. With it on, `call_google_ads_api` (curated reads + guarded
  writes) and `call_google_ads_reporting_api` are listed and routed; `zoma_status` shows a Google
  Ads line with a connect link; either platform is enough to finish setup.
- `emma/googleAdsTools.ts` now holds the Google handler objects Emma registers (mirrors
  `emma/metaTools.ts`); the toolkit dispatches through them, so the tracking pre-flight, PAUSED
  defaults and ENG-592 read-back stay in the path.
- Google writes: budgets in major currency units (refused, not rounded, past the currency's
  precision), echoed as micros. Optional ceiling `GOOGLE_TOOLKIT_SPEND_CEILING`
  (`{"maxDailyBudget": <micros>, "maxChangeRatio": <n>}`; malformed = refuse all budget writes).
  Shared budgets are disclosed with how many campaigns they cap; attaching a non-shared budget that
  a campaign already uses is refused before Google is called.
- Usage events now carry `dimensions.platform` (`meta` | `google_ads`). This is a new key in the
  existing dimensions map. No table, key or index changed.
- Same residual as Meta: preview tokens are single-use per process (no durable claim store).
