## ENG-2611: Classify Google Ads serving_chain state report as by_design (2026-10-21)

`call_google_ads_reporting_api` mode=serving_chain returns success:false with the JSON report when state is UNVERIFIED/BLOCKED_BY_*. That is the verifier working, so `classifyToolFailureType` now maps it to `by_design` instead of `bug` (5 prod rows since 10-07, ENG-1246 burn-in).
