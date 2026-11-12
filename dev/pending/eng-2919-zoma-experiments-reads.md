## ENG-2919: Zoma experiment read tools (2026-11-10)

- Slice 1 of ENG-2919: read-only toolkit/MCP tools `ads_experiment_list_tests`, `ads_experiment_abtest_get_test`, `ads_experiment_lift_get_test` over Meta ad studies (`act_<id>/ad_studies`, `/<study_id>`).
- Study reads first prove membership through the selected account's `ad_studies` edge (cursor pagination, never caller `next` URLs) and refuse a study of the other type. tools:read scope only; no write metering.
- Deferred: `ads_experiment_check_eligibility` and the delivery-changing create/update tools (preview+token) — later slices.
- Rollback: revert; no persistence changes, no Graph mutations.
