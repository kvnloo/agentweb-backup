## ENG-2379: Compare identity check is catalog-aware; model-options serves the legacy alias map (2026-10-13)

### Identity gap closed
- `isSameServedModel` accepts a dated canonical slug for a bare id (`deepseek/deepseek-v4-flash` -> `...-20260731`) unless a REGISTERED MMDD sibling owns that date. An unregistered sibling (`deepseek-v4-flash-0731`, a different model and price) was therefore accepted if OpenRouter repointed the bare id. The daily catalog monitor only registers a new sibling after a human merge, so the window was real.
- Compare now re-checks any DATED served slug against the live OpenRouter catalog ids (`services/agentMode/openRouterCatalogIds.ts`: public `GET /api/v1/models`, 10 min cache, single-flight, 3 s timeout, stale list kept on failure, 60 s back-off). A listed sibling with the same MMDD => `model_mismatch`.
- Undated exact ids never touch the network. Catalog unreachable and no prior list => falls back to the registered-ids check (the old behaviour, never looser).
- Aliased models are unaffected: a legacy id is normalised to its current id first (`qwen3.8-max` -> `qwen3.8-max-0902`), and an MMDD-suffixed id is its own identity.
- Known conservative edge: if a bare id's own legitimate snapshot date equals a listed sibling's MMDD, Compare refuses it (fail closed).

### Alias map
- `GET /api/agent-mode/model-options` gains `legacyModelAliases: Record<string,string>`, a copy of `LEGACY_MODEL_ALIASES` (the map `normalizeModelId`/`resolveGenerationModel` use). Additive; old portals ignore it. Portal feature-detects it and can drop its hand-copied `LEGACY_MODEL_ALIAS_IDS`.

### Tests
- modelCompare.routes (real matcher, mocked catalog), openRouterCatalogIds, agentModeController.scheduledModelStamp (model-options).

### Review follow-ups
- Catalog/registry sibling ids are normalised before comparison (`:free`/`:nitro` suffix, trailing `/`, `openrouter/` prefix, case).
- Catalog list is stale-while-revalidate: an expired list is served at once and refreshed once in the background; only a cold start waits (<= 3 s). Timeout uses AbortController so it is testable.
- Tests pin: last-good list kept on empty/non-OK/failed refresh, abort at timeout, non-OK body ignored.
