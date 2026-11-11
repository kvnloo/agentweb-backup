## ENG-2892: Own-account KB file write MCP tools (2026-11-10)

New `aw_`-key MCP tools in `backend/src/mcp/server/apiTools.ts`, next to the KB read tools:
`create_knowledge_base_file`, `update_knowledge_base_file_content`, `delete_knowledge_base_file`.
They wrap the existing routes (`/api/emma/create-knowledge-base`, `/attach-knowledge-base-files`,
`/update-knowledge-base-file`, `DELETE /api/tasks/:taskId/knowledge-base/files/:fileKey`); no new
storage or schema.

- Ownership is enforced in the tool, not left to the routes: the delete route also admits admins and
  org editors, and `GET /api/tasks/:id` admits org viewers. The tool reads the task and acts only when
  `task.userId` is the key's runtime identity. A foreign KB/file, a route 403 and a missing one all
  answer `Knowledge base or file not found`. Only file keys recorded on the caller's own task are ever
  sent to the delete route (the route itself will delete any GCS key in its bucket if asked).
- Text only: `.txt`/`.md`/`.markdown`, control characters rejected as binary, 1 MiB cap.
- Every write is read back from the task record (key + size, plus sha256 of the written text); a
  size mismatch reports failure. Delete re-reads the task and confirms the key is gone.
- Update is replace-only and refuses a file that does not exist (the underlying route would silently
  create it).
- All three are classified `write` in `toolAnnotationPolicy.ts`, so `tools:read` keys are denied.

Known, not from this change: `mcp.publicToolInventory.test.ts` already fails on `main` because
`export_lead_list`, `list_lead_list_exports` (ENG-2867) and `inspect_client_usage` are unclassified.
