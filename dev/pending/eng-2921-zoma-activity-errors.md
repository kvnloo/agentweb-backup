## ENG-2921: Zoma account activity log + error explainer (2026-11-10)

- Slice 1 of ENG-2921: toolkit/MCP tools `ads_account_get_activity_logs` (read-only, `act_<id>/activities`, since/until/limit/after cursor) and `ads_get_errors` (static Meta error-code table; no Graph call, no ad account needed).
- tools:read scope only; no write metering. Arguments are allow-listed; credentials are server-resolved and account-bound.
- Deferred: `ads_get_help_article` and x-business-use-case-usage backoff — later slices.
- Rollback: revert; no persistence changes, no Graph mutations.
