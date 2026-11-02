## ENG-2496: `AW-ZomaDeviceAuth` now has a `create-tables` definition (2026-10-27)

- **What it is.** Zoma's device-flow login (`mcp/zomaDeviceStore.ts`) stores pending device codes, hashed Zoma API tokens and the setup timeline in `AW-ZomaDeviceAuth`. The table was created by hand in production and no script created it, so `createTablesDrift` failed on `main` and a fresh environment had no such table.
- **What changes.** `create-tables.ts` gets `createZomaDeviceAuthTable`: primary key `pk` (S), no sort key, no GSI, pay-per-request, TTL on `ttl`. It only creates the table when it is missing; the existing production table is left as it is. A TTL failure is a warning and never stops later tables.
- **Data-plane note.** Adds a definition only. Nothing runs until `create-tables` is run, and then only against environments that lack the table. It has no deletion protection or point-in-time recovery, unlike the attempt-usage table; add them if wanted.
