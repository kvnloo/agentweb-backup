# Cycle 83 — MCP CallTool is not serialized (SDK or AgentWeb)

**UTC:** 2026-09-11T21:50:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.
**Do not touch:** billing.

## Question

Cycle 81: two parallel Hermes `CallTool`s can both pass the quota
GET. Is that only “Express is concurrent,” or does some layer
already serialize `tools/call` per MCP session — AgentWeb mutex,
rate limiter in-flight cap, or the Streamable HTTP SDK?

## Finding

**Neither AgentWeb nor `@modelcontextprotocol/sdk` 1.25.2
serializes `CallTool`. Each POST gets its own `streamId`. The
rate limiter is a per-minute count, not an in-flight lock.
Cross-instance rehydrate is *designed* as one transport per
in-flight request.**

### Local session: one transport, N overlapping POSTs

`mcpServer.ts` L307–313 / L491–492: if `sessions.has(sessionId)`,
reuse `sessions.get(sessionId).transport` and
`await transport.handleRequest(...)`. Express awaits **this**
request; it does not queue the next POST to the same session.
`mcpServerCore.ts` L88–120 `setRequestHandler(CallToolRequestSchema)`
has no mutex. `registry.execute` (L106–155) is skill/anon/publish
gates, not a lock.

### SDK: new streamId per POST, then `onmessage` (no queue)

`@modelcontextprotocol/sdk` `webStandardStreamableHttp.ts`
`handlePostRequest` (v1.25.2, matches `backend/package.json`
`^1.25.2`):

- L678: `const streamId = crypto.randomUUID()` **per POST**.
- L691–706 (JSON mode) / L737–752 (SSE): map that stream, then
  `this.onmessage?.(message)` with **no await-queue / no
  “already in flight” reject**.
- Initialize is the only singleton (L633–637: reject re-init).

The transport is built for concurrent POSTs on one session
(multiple streams). AgentWeb does not wrap that.

### Rate limiter is count/min, not in-flight

`mcpRateLimiter.check` (`rateLimiter.ts` L72+): sliding 60s
window of timestamps. API keys: `keyRecord.rateLimitPerMin`
(`mcpServer.ts` L106). OAuth (Hermes / Q-001): **60/min per
userId** (L142). That admits 60 overlapping `generate_image`
CallTools in one second as long as the minute count holds.
Internal `MCP_ACCESS_TOKEN` (L127–133) is **not** rate-limited.

### Rehydrate face is more concurrent, by comment

`mcpSessionRehydration.ts` L16–18: JSON-response mode, transport
created / used / closed **within the request** — “one transport
per in-flight rehydrated request, never cached.” Two CallTools
that miss the local Map (ENG-114, cycle 67) get **two** primed
servers. `mcpSessionStore` is metadata + `touch` (L48–54) — no
claim. Cycle 67 already: do not copy that table onto generate
locks (Harsha).

Hermes/OMP: the **agent loop** is the concurrency bound. AgentWeb
MCP is a Streamable HTTP **server** whose SDK already fans out.
Q-014 lists `generate_image`; it does not add a session mutex.
A fifth `listen()` would still be N HTTP POSTs. Do not Redis-ify.
Do not put `tryClaimSessionGeneration` on `/mcp` (wrong lock,
cycle 80).

## Queue effect

A-006 stays **discard** (new citation: SDK + rehydrate already
admit N in-flight CallTools; a fifth process is not a
serializer). Q-014 stays **ready**. A-017 stays park.

## Next

Cycle 84: cheapest remaining mapping. Candidate:
`incrementExtraCostUsage` is a third counter (CRM enrichment)
that `checkTokenUsage` never reads; images do not write it.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
