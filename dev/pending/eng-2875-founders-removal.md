## ENG-2875: Emma brand-guidelines tool can remove founders (2026-11-09)

`update_brand_guidelines` now treats a provided `founders` array as the full membership list (merged by normalized name onto existing entries), so founders omitted by Emma are removed. Helper `mergeFounders` in `backend/src/emma/impl/brandMarketStrategy.ts`.
