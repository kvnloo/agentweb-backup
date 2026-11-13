## ENG-2398: Google Ads read-back for device bid modifiers and asset-group retag (2026-11-13)

- `setDeviceBidAdjustments` reads back each campaign criterion / ad-group bid modifier and throws `GoogleAdsReadBackError` (`bid_modifier`) on mismatch or missing row; proto3-omitted 0 treated as 0 (-100% exclusion).
- `retagAssetGroupUtm` reads back `asset_group.final_urls` after the full-array write.
- Coverage guard: both removed from EXEMPT; classified `updateResponsiveSearchAdContent` (verified) and `updateConversionGoalBiddable` (drift-returned exemption), which had made the guard red on main.
