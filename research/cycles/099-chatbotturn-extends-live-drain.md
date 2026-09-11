# Cycle 99 — `chatbotTurn` already extends live drain; wrap preview

**UTC:** 2026-09-11T22:18:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 98: wrapping CallTool with `track()` after #2, without a
drain admission, would let new Hermes POSTs hold the 10 min
ceiling. Is that still hypothetical, or does this process already
`track()` an ingress that stays open during the four-way wait?

## Finding

**Already live: Emma `socket.on('message')` is
`cronJobRegistry.track('chatbotTurn', …)` with no `isCronEnabled`.
`io.close()` is *after* the four-way wait, so sockets still
accept turns while `drain()` watches a live `inFlight` map.
Nginx `/socket.io/` is 3600s — the client stays connected across
the overlap. The wrap-CallTool footgun is the chatbot path today.**

### The wrap that already shipped

`server.ts` L286–301 (ENG-1189): chatbot runs in-process (no
fork), can `executeTool` / mcpFetch, and was untracked, so they
wrapped it with `track('chatbotTurn')`. Comment: “pure addition,
not a behavior change.”

`chatSocketHandler.ts` L21–104: **zero** `isCronEnabled` /
`disableCron`. Token + ownership + usage only.

`gracefulShutdown.test.ts` L249–255 pins the wrap string. It
does **not** pin a drain admission.

### Open during the wait that `track()` extends

`runDrain` (`server.ts` L397–455): wait the four named units,
**then** `server.close`, **then** `io.close`. During the wait,
Socket.IO is still fully up. A new `'message'` → `track()` →
`inFlight.size` stays > 0 → cycle 98’s live `while` keeps
polling until `DRAIN_CEILING_MS`.

`.platform/nginx/conf.d/elasticbeanstalk/websocket.conf` L5–16:
`/socket.io/` `proxy_read_timeout 3600s`. Cycle 76: `/mcp` is on
the global 600s, not this location. Chat sockets outlive both the
3m19s overlap (cycle 96) and the 10 min drain.

Worker L443 still refuses new `runInWorker`. Chatbot is on the
**parent** (cycle 46). A fifth `listen()` would not see these
sockets unless it copied `chatSocketHandler` + the 3600s
location + the ASG hook.

Hermes/OMP: one process, no Socket.IO pair. AgentWeb’s
cutting-edge SDLC is the worker pair (closed flag, then wait) on
this ingress too — not a second HTTP server. Do not add a
chatbot 503 from this cycle. Wrap CallTool after #2 must copy
worker `draining`, because `chatbotTurn` proves `track()`-only
already exists.

## Queue effect

A-006 stays **discard**. Q-014 stays **ready** (MCP still
untracked; this is the in-app preview of the wrap). A-017 stays
park (Socket.IO rooms, not drain admission).

## Next

Cycle 100: cheapest remaining. Candidate: `slackAgentTurn` /
`emmaEmailAgentTurn` — same unguarded `track()` on HTTP/email.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
