## ENG-2950: Zoma Meta Ads MCP parity coverage matrix + CI check (2026-11-12)

Added `backend/src/mcp/zomaMetaParityMatrix.ts` (Meta tool -> Zoma tool/action, gap with owner, or n/a) and a jest check that every mapping exists in the advertised Zoma manifest. 83 rows from ENG-2913..2921: 62 covered, 21 gap. Pure data; no behavior change.
