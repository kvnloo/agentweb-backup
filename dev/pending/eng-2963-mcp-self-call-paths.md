## ENG-2963: MCP tools can no longer be steered to other routes through their arguments (2026-11-12)

Tools on Emma's MCP server call the REST API on the caller's behalf (`mcpFetch`), and many built the URL path from caller
arguments without escaping them. Reproduced on the test environment: `execute_task` with `task_id: "../agent-mode/sessions?"`
created a chat instead of running a task; the same trick could resume a paused Smartlead push (found by the review of the
Smartlead MCP tools).

**Fix**
- Every caller-supplied id that goes into a self-call path is now escaped with `encodeURIComponent` (94 places across the MCP
  tools, Emma's tools and the coding agent; ids that were already escaped, such as `requireListId`, are left alone).
- `mcpFetch` refuses, before sending anything, a path whose part before `?` does not start with `/api/` or contains a `.` or `..`
  segment, an empty segment or a percent-encoded dot (`%2e`, which URL normalisation turns into a dot segment), and any path with a
  raw backslash, `#` or control character anywhere (query included). An escaped slash (`%2F`) stays allowed: Express keeps it inside
  one path parameter, and ids with slashes (knowledge-base file keys, client names) need it. (An independent review caught that
  refusing `%2F` broke `delete_knowledge_base_file`; there is now a test through the real tool.)

**Also:** regenerated the MCP inventory snapshot, which main's ENG-2961 change (`manage_crm_sequence` external activation actions)
had left stale; no tool definition changed here.

**Testing:** `mcp.selfCallPath.test.ts` (the guard, mcpFetch sends nothing on a refused path, the reproduced `execute_task` value
is escaped into one segment, a `?` stays inside its id, the real knowledge-base delete still works); breakage checks: removing the guard, the escaping, the `%2e` rule or the raw-`#` rule, or bringing back the `%2F` rule, each fails a test.
MCP, tool and coding-agent suites pass (170 suites).

**Rollback:** revert; no data, table or environment change.
