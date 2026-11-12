## ENG-2973: zoma_status reports Google Ads explicitly unavailable when provider is off (2026-11-12)

`ZomaReadiness.google_ads` is now always present; with ZOMA_GOOGLE_ADS_ENABLED off it is `{ available: false, ..., reason: "google_ads_provider_disabled" }`. Flag-on shape gains `available: true`. Text rendering unchanged.
