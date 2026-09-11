# Cycle 118 — git pins nginx 8080 only for `/socket.io/`; Node defaults 3001

**UTC:** 2026-09-11T23:11:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 117: Hermes inbound is nginx → `127.0.0.1:8080`; mcpFetch
skips nginx. `websocket.conf` L6 hardcodes 8080; Node defaults
`PORT` **3001** (`server.ts` L55). Is EB `PORT=8080` in this
tree, or can nginx and mcpFetch drift?

## Finding

**`PORT=8080` is not in this tree.** `.env.example` L1 is
`PORT=3001`. Tests pin mcpFetch to `http://localhost:3001`
(`mcp.httpClient.test.ts` L27 / L239). Zero `PORT=8080` in
`.ebextensions`, `deploy.yml`, or `option_settings`. The only
`proxy_pass` in git is `/socket.io/` → `127.0.0.1:8080`
(`websocket.conf` L6). Hermes `/mcp` is the **unvendored**
platform `nginx.conf` (cycle 106). Live EB almost certainly sets
`PORT=8080` (convention); that assignment is live-AWS-only,
same class as cycle 116 `TimeoutStopSec`.

If an operator copied `.env.example` onto the environment,
Node would listen 3001, nginx `/socket.io/` would still hit 8080,
mcpFetch would follow 3001, and inbound Hermes `/mcp` would
depend on a file this repo does not vendor. Production working
does not put `PORT=8080` in git. The other `8080` in backend src
is `GROWTH_GENIUS_CHAT_URL` default (`auth.ts` L40) — a chat
frontend, not this listen.

A fifth `listen()` would need a third `proxy_pass` this conf
does not have. Do not pin `PORT=8080` from this cycle instead
of Q-014. Hermes/OMP: one process, no proxy port. AgentWeb’s
cutting-edge SDLC is A-020 (ASG wait) plus A-019 while nginx
still fronts the **same** PORT mcpFetch uses — that sameness is
not proven in git.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Q-001 stays **ready**. Q-014 stays **ready**.

## Next

Cycle 119: cheapest remaining. Candidate: unvendored platform
`nginx.conf` is the only `/mcp` `proxy_pass` — can we name that
file from this tree at all, or is Hermes’s upstream port
live-AWS-only too?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
