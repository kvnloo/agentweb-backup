## ENG-3212: Google/X spend-ceiling refusals show currency, not micros (2026-11-27)

Google Ads and X Ads toolkit writes refused over-ceiling budgets with the shared core's raw
message, relabelled `(minor units)` → `(micros)`, e.g. `daily_budget 600000000 exceeds ... 500000000 (micros)`.
They now go through `spendCeilingRefusalMessage` (`backend/src/mcp/googleToolkitWrites.ts`), which
formats the same verdict with `formatMicros` as LinkedIn does: `daily_budget 600.00 USD exceeds this
account's max daily budget of 500.00 USD.` and `daily_budget change 100.00 USD -> 300.00 USD is 3.00x, ...`.
Display only — `evaluateMetaSpendCeiling`, units, policy parsing and thresholds are unchanged;
`SPEND_CEILING_INVALID` messages pass through as before. Test: `eng3212.ceilingRefusalDollars.test.ts`.
