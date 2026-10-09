## ENG-1083: Enforce API key scopes at the MCP boundary (2026-10-07)

- `aw_` API keys: `tools:read` permits only `readOnly` tools; `tools:execute` permits all tools. Unknown/non-readOnly tools need `tools:execute` (fail closed). Denials return HTTP 403 JSON-RPC error -32003 naming the missing scope.
- Grandfathering: legacy records with no `scopes` array get both scopes; default key creation already grants both, so existing integrations are unaffected. No stored data changed.
- Rollback: revert this commit. Post-deploy smoke: create a `["tools:read"]` key, confirm a write tool returns 403 and a read tool succeeds.
