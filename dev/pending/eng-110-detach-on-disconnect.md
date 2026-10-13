## ENG-110: Chats already survive a tab close / reload; add visibility so the UI can re-attach (2026-10-12)

### FACTS (paste into ENG-110 / ENG-2424)
- The premise "closing or reloading the tab cancels an in-flight /generate" is FALSE on the current stack. `POST /api/agent-mode/generate` registers `req.on('close', ...)` (agentModeController.ts, "Cancel generation immediately when the client disconnects") AFTER `express.json()` has consumed the body. On Node >= 16 the request stream is already closed then, so that listener never fires on a client abort; only `res.on('close')` and the socket do. Reproduced with a plain Express server + a client that destroys its socket mid-request on Node 20.19.2 and 22.23.3 (req 'close' never; res 'close' + socket 'close' fire; Node 14.6.0 does fire req 'close').
- Production Node is not pinned in the repo (no .nvmrc, no `engines`; CI uses 22.x; EB platform decides) but every supported EB Node (>= 18) is >= 16, so the listener is dead in production.
- Nothing else cancels: no `res.on('close')`/'aborted'/AbortSignal in the /generate path; nginx (`.platform/nginx/conf.d/agent-mode-timeout.conf`, 600s proxy timeouts) and the ALB (IdleTimeout 600, `.ebextensions/timeout.config`) only close sockets, which the handler ignores; the portal has no beforeunload/pagehide/unmount stop and aborts the fetch only in `handleStop`, which also calls `POST /session/:id/stop` (the real canceller).
- Therefore a running chat keeps running to completion and persists its reply when the tab is closed/reloaded TODAY. What was missing is visibility: after a reload the UI could not tell the chat was still running.
- The dead listener also exists in the conversable-share generate (cancel, never fires) and `/verified-generate` (sets `clientDisconnected`, never true; harmless: `res.json` on a closed socket is a no-op). The SSE GET listener (`/progress`) is a bodyless GET and does fire (verified).
- Do not "repair" these to `res.on('close')` without a product decision: it would make every reload kill the run.

### What this PR adds
- `GET /api/agent-mode/generating` (auth) returns `{ sessionIds }` for the CALLER's sessions only (cap module's per-user map intersected with the session lock Set; added on claim, removed in `finally`).
- `GET /session/:id` gains an additive owner-only `isGenerating`; admins/delegates and share views never get it.
- State is in-memory per instance: during an Immutable deploy overlap another instance's runs are invisible, and a run on the old instance dies with it (accepted). No table/attribute/index.
- No behaviour switch: nothing is changed about cancellation. A comment at the dead listener records the fact. A real-socket test (`agentModeController.generateDisconnect.socket.test.ts`) pins it: client aborts, worker is not cancelled, reply persisted once, lock + slot released, `/generating` lists the run while in flight; explicit Stop cancels.
- Cost note: an abandoned run holds its cap slot until it finishes (<= cap x 600s per user) — this is already today's behaviour.
