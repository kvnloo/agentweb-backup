# Cycle 76 — Node setTimeout(0) loses to nginx/ALB 600s; Socket.IO does not

**UTC:** 2026-09-11T21:26:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 72: GET `/mcp` sets `res.setTimeout(0)` so Node never
idles out Hermes SSE. Cycle 75: drain is capped at 10 min. Does
that Node timeout-0 actually keep the stream, or does a proxy in
front already share the 10 min ceiling — and would a fifth
`listen()` inherit those proxies?

## Finding

**Node timeout 0 loses to nginx `proxy_read_timeout 600s` and ALB
`IdleTimeout: 600`. Those apply to `/mcp`. Socket.IO is the
exception (`/socket.io/` 3600s). A fifth `listen()` is behind
none of them unless it copies three deploy artifacts, one of
which cannot live in `.ebextensions` (ENG-823).**

### Two proxy clocks, one WebSocket override

`backend/.platform/nginx/conf.d/agent-mode-timeout.conf` L1–7:
**no `location` block** — `proxy_connect/send/read_timeout 600s`
for every upstream request. Filename says Agent Mode; the
snippet is global.

`backend/.platform/nginx/conf.d/elasticbeanstalk/websocket.conf`
L5–16: `location /socket.io/` overrides to **3600s**. Chatbot
Socket.IO is that path. GET `/mcp` is not.

`.ebextensions/timeout.config` L3–6: ALB `IdleTimeout: 600`
“matches the Nginx timeout.” L7–29 (ENG-823):
**DeregistrationDelay is intentionally not declared here** —
`.ebextensions` failed twice; `eb-deploy.sh`
`ensure_deregistration_delay()` (L796–790) talks to elbv2
directly. Partner-portal deploy skips it (L793–795).

Cycle 72’s `mcpServer.ts` L524–527 `setTimeout(0)` only silences
**Node**. Nginx/ALB still cut a quiet Hermes SSE at 10 min — the
same number as `DRAIN_CEILING_MS`. Q-014 `generate_image` POST
is on that 600s path too; an extra HTTP hop (A-006) spends the
same budget twice.

Hermes/OMP: one process, no nginx in front of the tool. AgentWeb
already special-cased Socket.IO; inbound MCP did not get a
location. Cutting-edge is that location (or `mcpShutdown` so the
proxy sees a close), not a second EB environment to copy
ENG-818 + ENG-823 into.

## Queue effect

A-006 stays **discard** (new citation: global nginx 600s + ALB
600s + deregistration via deploy script). Q-014 stays **ready**.
A-017 stays park (Socket.IO already has the 3600s location).

## Next

Cycle 77: cheapest remaining mapping. Do not un-ready Q-001 /
Q-014 / Q-003. Unsubscribe after `2026-09-12T06:00:00Z`.
