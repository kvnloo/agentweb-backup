## ENG-2896: atomic multi-file LP update MCP tool (2026-11-10)

- New aw_-callable MCP tool `update_landing_page_files` wraps PUT /update-files: up to 20 files, one commit, draft/agentweb-preview by default, main rejected.
- `expected_base_sha` (route + commitFilesToRepoMain) gives optimistic concurrency: mismatch -> 409, nothing written; a concurrent push between check and ref update surfaces as a conflict on retry instead of a silent rebase.
- No schema/persistence change; auth is the existing authorizeLandingPageAccess edit check; read-only keys denied via the existing scope gate.
