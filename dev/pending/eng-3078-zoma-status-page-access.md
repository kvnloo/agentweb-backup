## ENG-3078: zoma_status shows a missing Facebook Page as the next step (2026-11-16)

- `backend/src/mcp/zomaOnboarding.ts`: when payment and an ad platform are ready, `getZomaReadiness` now sets `next_step` to the stored Page refusal (`getMetaAdsNoPagesMessage`, same text the ad write gate returns) for any usable Meta account whose `has_meta_pages` is `false`. `zoma_status` therefore no longer prints "All set" for that user.
- The Meta account summary carries `page_access: 'missing'` only in that case. Granted and never-probed accounts get no new field and the same text as before.
- Nothing is probed live and nothing is stored. `meta.ready`, `writes_enabled`, `assertZomaWriteReady` and the device-flow poll are unchanged.
- Tests: `backend/src/__tests__/eng3078.zomaStatusPageAccess.test.ts`.
