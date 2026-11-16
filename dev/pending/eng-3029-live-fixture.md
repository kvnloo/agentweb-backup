## ENG-3029: Artificial Analysis jest fixture is now a live capture; Grok rows match again (2026-11-16)

- Step 2 of 2. `backend/src/services/agentMode/__tests__/fixtures/artificialAnalysisLanguageModelsFree.json` is no longer the documented example. It is 7 rows, verbatim, from the first response page uploaded by workflow run 43771490745 (2026-11-15). The rows cover: scored and unscored, `performance_v3` null and present, cost block null and present, all-null pricing, an integer score.
- The live rows showed one parser defect. The current endpoint names Grok's lab `SpaceXAI`; the retired one sent a slug that normalized to `xai`. Every `x-ai/*` registry entry therefore reported "AA unmatched" and kept its old score. `refreshScores` now maps that one creator name to `xai` (`AA_CREATOR_ALIASES` in `modelCatalogRefresh.ts`).
- Not changed: `Alibaba` (registry provider `qwen`) and `Kimi` (`moonshot`) also do not match by name. Those entries carry hand-picked variant scores and did not match on the old endpoint either, so matching them is a separate decision.
- The fixture is one trimmed page of four. Rows on pages 2 to 4 were never captured.
