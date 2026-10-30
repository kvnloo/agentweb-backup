## ENG-2716: CRM enrich-v3 pre-run cost estimate + confirmation token (2026-10-28)

Added pure `estimateEnrichmentCost` (calibrated to Opiner 112 leads -> $31.60), `POST /api/crm/lists/:listId/leads/enrich-v3/estimate`, and optional `confirmEstimateToken` check on enrich-v3 (409 on stale token; missing token rejected only when `ENRICH_V3_REQUIRE_COST_CONFIRMATION=true`). Dark until portal confirm dialog ships.
