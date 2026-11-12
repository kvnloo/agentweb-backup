## ENG-2916: Zoma account health + learning-phase reads (2026-11-10)

- New read-only Zoma toolkit tools `meta_account_health` (account_status, disable_reason, spend cap / amount spent / remaining in major units, warnings) and `meta_learning_phase` (per ad set learning_stage_info: LEARNING / SUCCESS / FAIL, optional campaign filter).
- Module `backend/src/mcp/metaToolkitHealth.ts`; gateway runs them on the ownership-resolved account and meters once; Graph read via `agentModeService.readToolkitMetaAccountGraph` (act_<id> node or `adsets` edge only).
- Remaining ENG-2916 Meta-parity reads (opportunity score, anomaly/benchmark/trend insights, ad entities) are later slices.
