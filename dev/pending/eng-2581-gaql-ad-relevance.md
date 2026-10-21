## ENG-2581: Gateway repairs GAQL quality_info.ad_relevance (2026-10-19)

The agent tool gateway rewrites `quality_info.ad_relevance` to `creative_quality_score` (or drops it when already selected) for `call_google_ads_reporting_api`; split from the ENG-1246 burn-in.
