## ENG-3033: Zoma ads_boost_ig_post, a guarded write created PAUSED (2026-11-15)

- New toolkit tool `ads_boost_ig_post` (`backend/src/mcp/metaToolkitBoost.ts`): turns an existing Instagram post into one campaign (OUTCOME_ENGAGEMENT), one ad set and one ad on the selected ad account. All three are created PAUSED; activation stays a separate `call_meta_marketing_api` UPDATE with its own preview.
- Uses the shared `zomaWriteGuard`: preview + single-use token, then confirm. The token store is the existing in-process one (no new persistence; the cross-instance residual is ENG-2862).
- The campaign, ad set and ad go through the same gate and dispatcher as `call_meta_marketing_api` CREATE (`previewToolkitMetaWrite` -> `dispatchToolkitConfirmedMetaWrite`). The only new Graph write is the creative (`AgentModeService.toolkitMetaBoostCreative`, `source_instagram_media_id`).
- Ownership before any write, and again at confirm: Instagram account on `act_<id>/instagram_accounts`, Page on `act_<id>/promote_pages`, post in `<ig id>/media` (first 1000 posts).
- `META_TOOLKIT_SPEND_CEILING` applies to the daily budget at preview.
- A boost that stops part-way returns `status: PARTIAL` with the ids already created (all PAUSED). There is no automatic rollback.
- Not exercised against live Meta. The ad set shape (`optimization_goal: POST_ENGAGEMENT`, `destination_type: ON_POST`) and the creative shape are from Meta's documentation and are untested against a real account.
