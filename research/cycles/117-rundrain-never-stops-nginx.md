# Cycle 117 — `runDrain` never stops nginx; stop order is live-AWS-only

**UTC:** 2026-09-11T23:08:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 116: journald is not the Node unit. Inbound Hermes hits
nginx first (cycle 107). On Sunday stop, does **nginx.service**
go down before Node, so Hermes 502s while `runDrain` still
holds PORT?

## Finding

**Git cannot prove nginx vs Node stop order.** It proves they
are different systemd units, and `runDrain` never stops nginx.
Sunday OS shutdown of both is the same live-AWS-only class as
cycle 116’s `TimeoutStopSec`.

`dev.md` L1934 names AL2023 **`nginx.service`**
(`PrivateTmp=true`, `ExecStartPre nginx -t`). That is not the
Node unit (`web.stdout.log`, cycle 116). `websocket.conf` L6
`proxy_pass http://127.0.0.1:8080` — Hermes inbound is ALB →
nginx :80 → 8080. mcpFetch is `http://localhost:${PORT}`
(`httpClient.ts` L94–96) and **skips nginx**.

`runDrain` waits on loopback **then** `server.close()`
(`server.ts` L404–440). Zero `systemctl`. `.platform/` is four
nginx *conf* fragments; the predeploy hook that broke nginx
(dev.md L1934–1938) was **removed**. No `After=` / `Requires=`
between `nginx.service` and the unnamed Node unit.

If nginx dies first: Hermes never reaches Node (502 at the
proxy or ALB) while PORT can still serve mcpFetch. That is a
**different** 502 from cycle 107 (nginx up, upstream refused).
A-019 refuse then covers loopback/new Node HTTP, not inbound
Hermes (already dead at :80).

If Node SIGTERM first: cycle 93 `mcpShutdown` then cycle 107
502 through still-up nginx.

A fifth `listen()` is a third unit `websocket.conf` does not
`proxy_pass` to (hardcoded 8080). Do not add `After=nginx`
from this cycle. Hermes/OMP: one process, no proxy. AgentWeb’s
cutting-edge SDLC is A-020 so Sunday is not an unordered dual-unit
stop, plus A-019 while nginx still fronts Node.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Q-001 stays **ready**. Q-014 stays **ready**.

## Next

Cycle 118: cheapest remaining. Candidate: `websocket.conf` L6
hardcodes `127.0.0.1:8080`; Node defaults `PORT` **3001**
(`server.ts` L55). Is EB `PORT=8080` in this tree, or can nginx
and mcpFetch drift?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
