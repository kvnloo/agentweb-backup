# Data context

**30d real + 60d synthetic** — pinned dataset `agentweb-evaluation-90d@1`.

| Window | Spend USD | Impressions | All clicks |
| --- | ---: | ---: | ---: |
| Latest 30d, actual seed | 1,030.24 | 12,992 | 493 |
| Full 90d, actual plus synthetic | 2,163.24 | 27,279 | 1,032 |

EXERCISE_DATA.csv is the analysis file for this workspace. `data_origin` identifies actual versus synthetic rows. The actual frozen window is July 16–August 14, 2026; it contains 22 delivery days. Older synthetic observations sit within May 17–July 15. The portal shifts all dates together so the final seed day appears as yesterday UTC; it does not fetch fresh Meta data. Missing delivery days are zero-delivery days within this exercise.

The older cohorts deterministically replay delivered actual rows 30 and 60 days earlier at 65% and 45% of their measured counts/spend, rounded to integer counts/cents. Single-impression rows are not replayed. This provides varying windows for workflow testing, not independent evidence of growth or seasonality.

Reach and frequency are modeled, never measured unique audience. Demographic, placement and device breakdowns are deterministic allocations, not observed segment performance. Do not use these synthetic metrics to claim a real audience or creative winner. Frequency is derived from impressions and modeled reach for the selected window; overlap modeling in the pending code revision is also synthetic.

CAMPAIGN_01 and CAMPAIGN_02 are explicitly PAUSED exercise conditions. This is not a conclusion inferred from zero spend or a claim about historical status. Configured status and effective delivery status are different concepts.

Some original creatives, including AD_15, were withheld for rights/privacy reasons. They have explicit “Creative unavailable” cards, not gray pixels or invented historical winners. You cannot infer the missing creative's message or visual design from its reported leads. Cleared images are in SOURCE_ARCHIVE/source_assets. Observe the original rights restrictions.

Reported leads are not verified qualified prospects. CompleteRegistration events are unverified pixel events, not proven new accounts. There is no revenue, lead identity, qualified-lead truth, approved future budget, or historical change log.

SOURCE_ARCHIVE preserves the original packet byte-for-byte for provenance. It includes an older April burst and the original Ryan instructions. Those archival totals and instructions describe that original packet, not this 90-day exercise. Follow this packet's START_HERE and EXERCISE_DATA instead; do not add the April burst to the synthetic 90d window.

Emma is a real AI service operating inside an isolated evaluation policy. Text/image generation can consume allowance. Meta delivery, review, reach and connector responses are simulated. External sends, publishing, real billing/spend and new connectors are denied. A simulated success is not a real-world launch, conversion, authorization or approval.
