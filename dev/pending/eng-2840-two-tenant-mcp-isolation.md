## ENG-2840: two-tenant isolation test for MCP tools, and two security fixes found on the way (2026-11-19)

**The test.** `backend/src/__tests__/mcp.twoTenantIsolation.test.ts` connects a real MCP client (in-memory transport) as tenant A to the real MCP
server (`createMcpServer`), through the real tool, `mcpFetch` (real service JWT), the real Express app and the real `db.ts`, onto an in-memory
DynamoDB (`helpers/inMemoryDynamo.ts`). Tenant B's rows carry unmistakable text (`BRAVO…`); for every covered tool it asserts that A's own read
works, that nothing of B's is returned in any outcome, that foreign-id attempts are refused and leave B's rows byte-identical, that
`userId` / `user_id` / `client_id` arguments cannot change whose data is used, and that a second user in A's org sees A's data.

**Adding a tool.** Add its name to `TWO_TENANT_COVERED_TOOLS` (`helpers/twoTenantWaveTools.ts`) and a spec to `SPECS` in the test. A coverage
guard fails when the two lists differ or a listed tool is not registered. Every wave of new MCP tools extends this list.

**Limits (so nobody reads it as more than it is).** The fake database ignores `FilterExpression`, `Limit` and `ExclusiveStartKey` and has no
batch operations or S3, so isolation that lives only in a database filter cannot be proven here. The caller's identity is built by hand (the
`aw_` key lookup is not exercised) and HTTP-layer scope checks in `mcpServer.ts` are not exercised. A foreign list answers 403 while a missing
one answers 404, so existence is distinguishable; this predates the test and is not asserted.

**Fixes.**
- Any caller could switch off the public-response sanitiser (ENG-2335) by adding a `client_id` argument to any tool. It now applies only when
  the caller's account is really an admin (looked up only when the argument is present; any failure means "not admin", so the answer is stripped).
- `create_html_template` saved a bare `data:` / `file:` / `ftp:` (and similar) link as the template body. It is now refused with a clear error
  before any fetch, rewrite or save. Text with spaces and real HTML are unchanged.

**Fake database.** Conditions on nested paths (`brandGuidelines.updatedAt`) were treated as one attribute with dots in its name, so `=` was
always false and `attribute_not_exists` always true. They now read nested values; the suites that use the fake were re-run.
