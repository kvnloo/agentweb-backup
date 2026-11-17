## ENG-1139: unit-economics all-in cost targets (2026-11-16)

AC3 comparison is live in `llmUnitEconomicsService`. Target = the tier's LIVE hard LLM threshold (read from `subscription_types` at report time) + a fixed overhead envelope (`TIER_OVERHEAD_ENVELOPE_USD`: Free $2, Starter $13, Pro $30, Super Premium $30). With caps Free $5 / Starter $80 / Pro $200 that is $7 / $93 / $230 / $230; the ticket's $7/$73/$180 table is stale.

- Super Premium has no policy row and enforcement does NOT alias it to Pro (it reports uncapped). Only the target borrows Pro's policy (`TARGET_POLICY_FALLBACK_TIER`); thresholds and the `uncapped_tier` alert are unchanged.
- Rows and tier aggregates carry `targetAllInUsd`, `varianceUsd`, `overTarget`; `GET /api/admin/usage/unit-economics?month=...&format=csv` is the monthly export (LLM, non-LLM vendor, admitted-work overrun, infrastructure, actual, target, variance).
- Alerts `tier_over_target` / `account_over_target` are aggregate counts only (no per-user issue). Credits are not added to the target, so top-ups show as variance.
- Admin-only; a source-scan test pins that no customer-facing file references these.
- Envelope rationale: the threshold already caps LLM spend, so the fixed envelope budgets what it cannot see (metered vendors, shared infrastructure, support) and scales with plan size. Change an envelope only with a new owner decision. A tier with no policy or no envelope has no target and raises the aggregate `tier_no_target` alert rather than reading as on target.
