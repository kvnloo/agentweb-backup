## ENG-2398: Google Ads read-back for remaining mutation paths (2026-10-11)

updateBudget/updateAdGroup/updateKeyword/updateAd verify requested fields by read-back; all removes (budget, campaign, criterion, ad group, keyword, ad, conversion action) verify REMOVED-or-gone. Mismatch throws GoogleAdsReadBackError (unsupported_field) -> tool success:false. Coverage test enumerates mutation methods; pattern doc docs/ad-api-read-back-pattern.md.
