## ENG-2865: meta/zoma toolkit enforces aw_ key scopes (2026-11-07)

`/api/meta-toolkit` now applies the main-MCP `tools:read` / `tools:execute` boundary
(`mcp/server/apiKeyScopes.ts`) to `aw_` keys. Writes (guarded Meta CREATE/UPDATE, creative
uploads, Google Ads guarded writes, `zoma_prepare_upload`) need `tools:execute`; reads need
`tools:read`. Denied calls are 403 before any upstream call or metering. Legacy keys without
`scopes`, OAuth and Zoma-token callers are unchanged. Rollback: revert.
