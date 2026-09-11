# Cycle 105 — `emma_send_message` POST is not retried after `server.close`

**UTC:** 2026-09-11T22:35:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 104: listed `emma_send_message` is a 5 min hop around
`/generate`. After the four-way wait, unawaited `server.close`
refuses new loopback (ENG-1189). Does that hop retry into the
closed listener — or fail once — and does Hermes already on the
new instance ever see that error?

## Finding

**Listed `emma_send_message` is POST, so ENG-1189’s retry does
not run.** `httpClient.ts` L116–118 / L126: only GET and PUT get
three attempts. POST is one fetch. Cycle 103’s listed
`emma_get_session` GET would retry three times into a listener
that `server.close` has already refused for the rest of this
process’s life (`server.ts` L411–413). Neither retry helps.
Hermes already on the new instance is a **different process**
and never sees the old session’s `isError`.

### POST vs GET on the same hop helper

`SELF_CALL_RETRYABLE_METHODS` is `GET`/`PUT` only.
`mcp.httpClient.test.ts` L163–176 pins POST
`/api/tasks/.../execute` at **one** `fetch` on `TypeError: fetch
failed`. `emma_send_message` L213–216 and `emma_answer_question`
L260–269 are the same method. `emma_get_session` L286 is GET →
`SELF_CALL_MAX_ATTEMPTS` 3, backoff 200 ms × 2^(n-1) (L117,
L139) ≈ 600 ms of retries that `server.close` cannot satisfy.

A genuine 5 min abort is `AbortError`, not this TypeError
(L106–108 / test L179). Cycle 104’s cancel-on-close and this
cycle’s connect-refused are different clocks.

### Pool is already empty after a real drain

`httpClient.ts` L15–19 `setGlobalDispatcher(new Agent({...}))`
does not set `keepAliveTimeout`. Undici default is **4e3 ms**
(`node_modules/undici/lib/dispatcher/client.js` L247).
`DRAIN_CEILING_MS` is 10 min (`shutdownConstants.ts` L8). After
any non-trivial four-way wait, the loopback pool is gone. The
first POST after close needs a **new** TCP connection.
`server.close` refuses that. Detail is typically
`ECONNREFUSED` / `fetch failed`, wrapped L134–136:

`MCP self-call POST /api/agent-mode/generate failed after 1
attempt(s) [correlationId=…]: …`

`mcpServerCore.ts` L164–173 returns that as `isError` text
`Error: ${error.message}` on the **old** Streamable HTTP
session. Memory store (cycle 95) dies with the process. Hermes
that already 404-reinited on the new instance (cycle 91/97)
never reads this string.

Do not add POST retry from this cycle. The test’s own comment
(L159–162) is duplicate risk if the inner `/generate` already
`tryClaim`ed. Wrap CallTool after #2 still; A-019 `tryClaim`
refuse still stops a hop that has not started. A fifth
`listen()` makes this an inter-process ECONNREFUSED with the
same one-attempt POST.

## Queue effect

A-006 stays **discard**. Q-001 stays **ready** (404 reinit, not
a POST retry). Q-014 stays **ready**. A-019 stays **park**.

## Next

Cycle 106: cheapest remaining. Candidate: inbound `/mcp`
keep-alive after `server.close` still delivers CallTool (Node
`close()` keeps existing sockets) so the old TCP connection can
fire a send_message whose **new** loopback then fetch-fails.
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
