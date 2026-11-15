## ENG-2917: Zoma optimization-event check for existing ad sets (2026-11-15)

- New read-only Zoma toolkit tool `meta_optimization_event_check` (in `backend/src/mcp/metaToolkitHealth.ts`, beside `meta_account_health` / `meta_learning_phase`). Per ad set it returns the optimization event, 7-day spend, and how many of those conversions Meta attributed to the ad set. Verdicts: `ok`, `low_volume` (fewer than 50 in 7 days), `no_events` (spend with none), `not_judged`.
- One Graph read: `act_<id>/adsets` with `insights.date_preset(last_7d){spend,actions}` nested in `fields`, through the existing `readToolkitMetaAccountGraph` seam. No agentModeService change, no storage.
- Evidence is ad-set insights on purpose. The pixel `/stats?aggregation=event` edge serves about 24 hours and cannot be widened (see `metaOptimisationCoverage.ts`), so it cannot back a weekly count, and a pixel-wide count lets a busy sibling ad set vouch for a dead one.
- Counting reuses `resolveOptimisationEvent` + `INSIGHTS_FAMILY_BY_OPTIMISATION` and `collapseActions` (family maximum, never a sum of aliases).
- `not_judged` rows carry no `events_7d`. No delivery, a custom event (`OTHER` / custom conversion) and events with no insights family (`SEARCH`, `CONTENT_VIEW`, ...) are not counted, so "could not count" never reads as zero.
- Not proven live: the nested-insights field expansion against a real account, and whether 200 ad sets with nested insights trips Meta's "reduce the amount of data" error on a large account (`campaign_id` narrows the read). Authenticated prod probe waits on the ENG-2405 fixture.
