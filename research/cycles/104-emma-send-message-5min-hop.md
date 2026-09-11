# Cycle 104 — `emma_send_message` is a 5 min hop around `/generate`

**UTC:** 2026-09-11T22:30:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 103: listed `emma_get_session` GET starts a continuation.
Q-001’s other listed tool is `emma_send_message`. Does that POST
`/generate` during drain sit on `track()`, on `tryClaim`, or
on a third clock — and does mcpFetch abort cancel the inner
turn the way Q-014’s image leaf does not?

## Finding

**Listed `emma_send_message` mcpFetchs `POST /api/agent-mode/generate`
with no `timeoutMs` → default 5 min.** The inner handler
`tryClaim`s (cycle 101) and **does** `requestCancel` on
`req.on('close')`. Inbound MCP CallTool is still untracked
(cycle 69). So Q-001 is two maps and two clocks in one process:
untracked CallTool → 5 min loopback → Set waiter that drain
holds for 10 min. Abort at 5 min can empty the Set. Q-014’s
image hop does not cancel the leaf (cycle 79). Do not HTTP-split
either hop.

### The listed write

`apiTools.ts` L183–218: `emma_send_message`, not `internal`.
Listed in `mcp.apiTools.test.ts` L71 with `emma_get_session`.
`mcpFetch` L213–216: POST `/api/agent-mode/generate`, **no**
`timeoutMs`. `httpClient.ts` L205: default 5 minutes.
`emma_answer_question` L260–269 is the same path, same default.
v0 tools pass 25 min (L1543); this one does not.

### Inner cancel vs image leaf

`generateResponse` L9094–9104: client disconnect →
`requestCancel(sessionId)` + worker `cancelSession`. mcpFetch
abort closes that POST, so the 5 min hop can stop the turn.
`drainActiveSessionGenerations` then sees the Set drop.

Cycle 79: `emmaApi` generate-image has no abort listener;
`generateImage` has no `AbortSignal`; meter still fires. Q-014
CallTool wrap would wait a leaf that ignore-aborts. Q-001’s
send_message hop is the opposite: abort is wired.

Nginx `/mcp` is 600s (cycle 76). Drain ceiling is 10 min.
send_message’s 5 min is the *tightest* clock on the Hermes
operator path. A fifth `listen()` would need this abort
contract copied; Hermes/OMP: one process, one timeout.

Do not add `timeoutMs` from this cycle. Do not rewrite
`HERMES_MCP_OAUTH.md`. Wrap CallTool after #2 still; A-019
`tryClaim` refuse still stops new `/generate` during drain.

## Queue effect

A-006 stays **discard**. Q-001 stays **ready**. Q-014 stays
**ready** (different hop, different abort). A-019 unchanged.

## Next

Cycle 105: cheapest remaining. Candidate: `emma_send_message`
after `server.close` — loopback “fetch failed” (ENG-1189) while
Hermes is already on the new instance. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
