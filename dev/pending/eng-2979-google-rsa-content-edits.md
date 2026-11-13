## ENG-2979: Google toolkit RSA content edits via guarded preview (2026-11-12)

- `call_google_ads_api` AD UPDATE now accepts `headlines` / `descriptions` / `final_url` for RESPONSIVE_SEARCH_AD ads (status still sent alone). Preview shows current vs new; confirm mutates `customers/{cid}/ads/{adId}` (AdService) with an update_mask of only the changed fields; read-back verifies each field (MISMATCH/UNCONFIRMED never success). Non-RSA and foreign ads refused.
- Files: `backend/src/mcp/googleToolkitWrites.ts`, `googleToolkitManifest.ts`, `services/googleAdsService.ts` (`updateAd` + `updateResponsiveSearchAdContent`), `emma/impl/adsCrmApis.ts`.
