## ENG-3070: admin read of a named client's Meta change history (2026-11-16)

New admin-only tool `read_client_meta_activity` (`backend/src/mcp/server/apiTools.ts`) calls `GET /api/client-health/:client/meta-activity`, served by `readClientMetaActivity` in `backend/src/services/clientHealthService.ts`. It reads one page of the Meta `activities` edge for the named client's ad account through the existing `executeActivityLogRead` (`backend/src/mcp/metaToolkitDiagnostics.ts`). Nothing is written to Meta. The tool is not listed on the public MCP surface.

The client lookup and the account/token pairing were lifted out of `assessClientHealth` into `findClientMatches` and `resolveClientMetaAccount`; `assessClientHealth` calls both and still takes the first name match. The new read refuses instead when a name matches more than one client.

Every failure returns `success: false` with a `reason`: `not_admin`, `client_not_found`, `ambiguous_client`, `no_meta_connection`, `credential_pair_mismatch`, `invalid_argument`, `meta_read_failed`. A failed Meta read is never returned as an empty history. A connected account that has an id but no token of its own is not read with the shared token.

`before` and `after` are Meta's own `extra_data.old_value` / `new_value`, passed through unchanged; their inner shape per event type was not checked against a live account.
