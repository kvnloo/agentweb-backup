## ENG-2822: Meta Page access gates ad creation only, not reads (2026-11-05)

`describeMetaAdsCapability` no longer sets `ads_capable:false` when Page access is missing; it reports `can_create_ads:false` + the Page-specific warning. Connected Accounts keeps such accounts active with that reason, and the generic "permission not granted" label now uses `capability_warning`.
