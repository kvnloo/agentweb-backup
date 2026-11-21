## ENG-3069: admin read of a managed client's Meta budgets and spend for an exact window (2026-11-16)

- New admin-only, read-only MCP tool `read_client_meta_budgets` and route `GET /api/client-health/:clientEmail/meta-budgets?since&until` (`backend/src/services/clientMetaBudgetsService.ts`). Uses the ENG-3070 helpers `findClientMatches` and `resolveClientMetaAccount` with the same refusals as `read_client_meta_activity`; a failed Meta read is reported as `meta_read_failed`, never as zero spend.
