## ENG-2959: Google toolkit CAMPAIGN rename + AD_GROUP name/max CPC via guarded preview (2026-11-12)

- `call_google_ads_api` guarded writes now accept CAMPAIGN UPDATE `name` and AD_GROUP UPDATE `name`/`cpc_bid` (major units -> micros), each through the preview/confirm token flow with current-vs-new preview and read-back verification. `status` must still be sent alone; all other UPDATE fields stay refused.
