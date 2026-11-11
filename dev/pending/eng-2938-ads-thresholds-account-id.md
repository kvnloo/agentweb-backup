## ENG-2938: get_ads_thresholds normalizes account ids and lists valid ones on miss (2026-11-11)

The tool now accepts act_/ACT_-prefixed, padded, numeric ids or the account name, returns a clear no-Meta-connected error, and on a true ownership miss lists the connected ids so the model self-corrects. Regression: eng918.getAdsThresholdsTool.test.ts (5 red -> green).
