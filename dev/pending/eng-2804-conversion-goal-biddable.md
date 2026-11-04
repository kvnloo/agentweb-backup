## ENG-2804: call_google_ads_api supports CAMPAIGN/CUSTOMER_CONVERSION_GOAL biddable changes (2026-11-04)

- New entity types `CAMPAIGN_CONVERSION_GOAL` and `CUSTOMER_CONVERSION_GOAL` (LIST, UPDATE `biddable`) with GAQL read-back; drift returns `success:false`.
- Lets Emma demote codeless / Universal Analytics goals that refuse `CONVERSION_ACTION UPDATE` (MUTATE_NOT_ALLOWED).
- Post-merge operator step: Kraftersland campaign 24035153990, set biddable=false on CONTACT~WEBSITE, DEFAULT~WEBSITE, REQUEST_QUOTE~WEBSITE.
