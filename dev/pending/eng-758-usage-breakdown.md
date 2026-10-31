## ENG-758: Usage breakdown on get_account_status (2026-10-31)

- `get_account_status` takes optional `usage_month` (YYYY-MM). When set it reads the existing
  `/api/subscription/usage/itemized` ledger and returns `usage_breakdown`: token/call totals,
  per model, per day, and a session count (`exact: false` when daily aggregates lack session ids).
- No dollars leave the tool (ENG-1212 AC4); no new table, index, or persisted field.
- Pure aggregator: `backend/src/mcp/server/usageBreakdown.ts`.
