## ENG-2980: Zoma Meta experiment writes — eligibility, A/B create/update, lift create (2026-11-13)

- New `backend/src/mcp/metaToolkitExperimentWrites.ts`: `ads_experiment_check_eligibility` (read-only), `ads_experiment_abtest_create_test`, `ads_experiment_abtest_update_test`, `ads_experiment_lift_create_test` via the shared Zoma preview+confirm guard, account ownership for campaigns and study ids, future start_time (default +24h), field-by-field read-back.
- `agentModeService.toolkitMetaExperimentGraph` (allow-listed `act_<id>/ad_studies` + numeric node). Parity matrix rows flipped to covered.
