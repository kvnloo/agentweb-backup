## ENG-2576: LinkedIn ESTIMATE_REACH percent-encodes parentheses in value URNs (2026-10-19)

`encodeTargetingCriteriaParam` used `encodeURIComponent`, which leaves `( ) ' ! *` literal. RestLi 2.0 treats `(`/`)` as structure, so values like `urn:li:staffCountRange:(11,50)` produced "Invalid query parameters". Production saw 4/4 failures from 10-13 to 10-15. Fix: `encodeRestLiValue` in `backend/src/services/linkedInAdsService.ts`.
