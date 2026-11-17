## ENG-3127: Zoma auto-selects the active Meta ad account (2026-11-16)

- `backend/src/mcp/metaToolkitGateway.ts`: when several usable Meta ad accounts are connected and the call has no `account_id`, `resolveMetaToolkitAdAccount` probes last-30-day spend (Graph insights) and runs against the one account with strictly highest spend > 0. Cached 10 min per user. A tie or no spend still refuses, and the refusal now lists every account as `name (id)`.
- `backend/src/mcp/zomaOnboarding.ts`: the ENG-3078 Page step in `zoma_status` now starts with "Reading your Meta campaigns and reports works. Creating new ads is blocked until this is fixed:".
- Tests: `backend/src/__tests__/eng3127.zomaActiveMetaAccount.test.ts`, updated `eng3078.zomaStatusPageAccess.test.ts`.
