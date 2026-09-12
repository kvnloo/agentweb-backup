# Cycle 234 — Hermes can see A-019 503 while `/health` stays 200

**Date:** 2026-09-12T06:34:00Z
**Question:** Cycle 233: Sunday-without-hook still
`disableCron`s; Wait is the park. Without Wait, the dying
instance is still an ALB target until kill (DeregistrationDelay
600s vs ENG-764 3m19s). Can Hermes still see A-019 POST
`/mcp` `tools/call` 503 on that target after `disableCron` and
before SIGKILL, or does ALB/nginx 502 first?
**Answer:** **503 is visible while the listen is up.** `/`
and `/health` stay 200 until `server.close` (`app.ts` L547–553;
`healthEndpoint.test.ts` L51–75 always-200, no drain case).
ALB therefore keeps the target. `disableCron()` is first in
`runDrain` and does not close the listen (cycle 108 / ENG-1189:
mcpFetch still needs it). After A-019, POST `/mcp` `tools/call`
503s on that still-registered target — same class as
`runScheduledChats` L13031–13032. Nginx 502 is **after**
`server.close` (cycle 107: connect refused). DeregistrationDelay
600s (`deploy.yml` L217; `ensure_deregistration_delay` after
verify, `eb-deploy.sh` L897) starts when the target is
**deregistered**, not at `disableCron`. ENG-764 3m19s is
shorter than 600s, so Sunday-without-hook can SIGKILL during
the wait and turn *in-flight* sockets into 502; **new** POSTs
before close are still 503. Do not 503 `/health`. Do not set
`HealthCheckType: ELB`. Do not add A-021.

## Evidence

### Health stays 200 through disableCron

```547:553:backend/src/app.ts
app.get("/", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});
```

Cycle 108: ALB health cannot stop Hermes during drain. Zero
`HealthCheckPath` in git. Always-200 is why loopback mcpFetch
can finish. A-019 refuse is admission on `/mcp` / `/generate`,
not a health-check fail. Cycle 230: default ASG check is EC2,
not ELB. Cycle 227: after close, `/health` 502 is a side
effect of `server.close`, not of `disableCron`.

### 502 is the later face

Cycle 107: after close, new Hermes `/mcp` is nginx **502 now**
(upstream refused), not a 600s 504. `proxy_connect_timeout`
does not wait on ECONNREFUSED. A-019 503 is *before* that
close so Hermes on the dying instance sees Application 5xx with
the listen still bound.

`websocket.conf` only special-cases `/socket.io/`. `/mcp` is
unvendored platform nginx (cycle 118–119). Same upstream: 503
from Node is proxied as 503; 502 is no upstream.

### 600s is not the Sunday-without-hook clock

`ensure_deregistration_delay` (`eb-deploy.sh` L781–791 / L897)
is post-verify ALB API, because `.ebextensions` silently dropped
the option twice (ENG-823). `deploy.yml` L217 sets 600s.
Comment L786: AWS default without that repair is **20s**.
Sunday never calls `eb-deploy.sh` (cycle 110) but the last
merge’s 600s stays on the **target group** (ALB survives ASG
swap; cycle 113). Delay counts **after deregister**, not from
`disableCron`. ENG-764 3m19s is Immutable overlap until the old
instance is **removed** — shorter than 600s — so the delay
does not keep Sunday-without-hook alive for a 10 min drain.

Hermes / Oh My Pi: one process; SIGTERM *is* health fail.
AgentWeb’s cutting-edge SDLC is `/health` 200 + in-process 503
so the billed CallTool gets a retryable Application face on
the dying target, then Immutable’s new instance takes the
retry. Not a fifth `listen()`. Not 503 `/health` to “help”
ALB (that would 502 Hermes before Node can 503).

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown` then unawaited `server.close`.
Keep `/health` 200 until close. Add:

- Do **not** 503 `/health` so ALB will drain faster (would
  replace A-019 503 with ALB/nginx 502).
- Do **not** treat DeregistrationDelay 600s as a Sunday-without-hook
  drain budget (it starts at deregister; 3m19s overlap is the
  no-Wait clock).
- Do **not** set `HealthCheckType: ELB`.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded. A-020 stays park.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: agent-engine retries `/run-scheduled-chats`
503 in 5s (comment L13029–13030). Does any in-repo Hermes /
MCP SDK client retry POST `/mcp` HTTP 503 onto the **new**
instance, or is A-019 503 a one-shot fail for that CallTool
(cycle 220: Q-001 fixture is httpx, no `Protocol.request`)? Do
not copy `mcpClientService` 3600000. Do not add A-021. Do not
un-ready Q-001 / Q-014 / Q-003. Do not revive A-006. Do not
mint a timer unless Kevin asks.
