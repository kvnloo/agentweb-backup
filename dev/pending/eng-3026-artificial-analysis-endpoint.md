## ENG-3026: Frontier monitor reads the current Artificial Analysis endpoint (2026-11-15)

- Artificial Analysis retired `/api/v2/data/*` on 2026-11-04 (HTTP 410). The monitor and the catalog refresh now read `GET /api/v2/language/models/free` (`AA_MODELS_URL` in `backend/src/services/agentMode/modelCatalogRefresh.ts`), which any key tier may call. Docs: https://artificialanalysis.ai/data-api/docs.
- The list is paginated (200 rows per page). `fetchArtificialAnalysisModels` reads every page and throws rather than return a partial list.
- `model_creator` no longer has a `slug`, only `id` and `name`. Lab matching falls back to the normalised name (`aaCreator`). Labs whose name does not normalise to the OpenRouter prefix or the registry `provider` report "AA unmatched; score unchanged".
- A failed keyed read reports `Artificial Analysis failed: ...` only. The "ARTIFICIAL_ANALYSIS_API_KEY not set / is missing" lines appear only when the key is absent.
- The feed carries `intelligence_index_version`. When its major version differs from registry scores labelled `Intelligence Index v<n>`, the refresh emits an `AA INDEX VERSION` warning, which blocks the refresh PR auto-merge verdict until a human decides how to re-baseline.
- The jest fixture is the documented example from the published OpenAPI spec, not a live capture.
