# Cycle 103 — `emma_get_session` GET starts billed continuation

**UTC:** 2026-09-11T22:28:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 102: `getSession` L8730 can `setImmediate` a media
continuation. Is that an obscure portal reload, or an MCP
**read** Hermes already has — so a drain-time `tools/call` on
the old instance starts `generate_image` via loopback?

## Finding

**Listed MCP `emma_get_session` is a GET that is not a read.**
`apiTools.ts` L274–288 mcpFetchs `GET /api/agent-mode/session/:id`
with **no** `internal: true`. Tests list it for external clients
(`mcp.apiTools.test.ts` L71). The handler’s own comment calls
getSession a “passive READ” (L8719) then fires
`scheduleAutoMediaContinuation` if the owner looks and a media
deferral is < 1 hour old (`BACKSTOP_STALENESS_MS` L1234).
Hermes polling a session during overlap can start billed
generation on the **dying** instance. Q-014’s leaf is that
continuation, not a fifth `listen()`.

### The listed read

`routes/agentMode.ts` L162–164: `GET /session/:sessionId` →
`getSession`. `emma_get_session` has no `internal` flag (unlike
`generate_image` L2077 today). Workflow tools tell agents to
poll it (`workflowTools.test.ts` L148–160).

`getSession` L8724–8737: `genuineOwnerView` (not admin/delegate)
and `!activeSessionGenerations.has` → `setImmediate`
continuation. MCP `ctx()` is the OAuth/API-key user, not a
delegate, so Hermes **is** genuineOwnerView. Staleness default
1 hour — a deferred batch from this deploy window still matches.

GET stays 200 during drain (cycle 97: only scheduled chats 503).
Loopback mcpFetch hits **this** PORT (cycle 58). `setImmediate`
is not cancelled by `disableCron` (cycle 102). Then `tryClaim`
L1350 re-fills the Set.

Do not hide `emma_get_session` from Q-001. Do not land A-019
instead of Q-014. A-019 `tryClaim` refuse still stops the
side-effect chain after the GET returns. Splitting
`imageGeneration.ts` into HTTP would miss this scheduler
entirely — it lives in the GET handler. Hermes/OMP: a get
session tool does not spawn a background image job.

## Queue effect

A-019 stays **park** (this is why `tryClaim` is in the first
slice, not only `/generate`). A-006 stays **discard**. Q-001
stays **ready** (runbook already uses `/mcp`; do not rewrite it
because a read has a write). Q-014 stays **ready**.

## Next

Cycle 104: cheapest remaining. Candidate: `emma_send_message`
POST `/generate` during drain (apiTools send_message mcpFetch) —
tracked? tryClaim? Do not un-ready Q-001 / Q-014 / Q-003.
Unsubscribe after `2026-09-12T06:00:00Z`.
