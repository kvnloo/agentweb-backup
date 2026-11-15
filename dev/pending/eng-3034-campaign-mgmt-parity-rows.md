## ENG-3034: four base Campaign-management parity rows proven covered; two read rows split to ENG-3040 (2026-11-15)

- `ads_create_campaign`, `ads_create_ad_set`, `ads_create_ad` map to `call_meta_marketing_api` CREATE on CAMPAIGN / AD_SET / AD; `ads_activate_entity` maps to its guarded UPDATE (status=ACTIVE). Matrix data and one test file only; no tool, description or runtime path changed.
- `eng2303.metaToolkitWrites.test.ts` only exercised CAMPAIGN. `eng3034.campaignManagementParity.test.ts` now proves, for each of the three entities, that CREATE is dispatched PAUSED, that any other status on create is refused before preview, that a create which reads back ACTIVE is MISMATCH, and that activation needs its own preview token (a CREATE token does not activate).
- `ads_get_ad_accounts` and `ads_get_field_context` stay `gap`, owner ENG-3040. `zoma_status` lists connected ad accounts but nobody has compared that with what Meta's tool returns; no operation was found for field context.
- Totals from `summarizeParity`: covered 71 / gap 14 / n/a 3 (of 88). Main was 67 / 18 / 3.
