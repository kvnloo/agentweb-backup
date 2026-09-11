# Cycle 119 — this tree cannot name the `/mcp` nginx.conf

**UTC:** 2026-09-11T23:16:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 118: `PORT=8080` is not in git; the only git `proxy_pass` is
`/socket.io/`. Unvendored platform `nginx.conf` is the remaining
`/mcp` hop. Can we name that file from this tree, or is Hermes’s
upstream port live-AWS-only too?

## Finding

**We cannot name it.** Production code already says the catch-all
is not here. `app.ts` L152–155 (ENG-493): “The EB-platform-managed
nginx config for the general proxy location **isn't in this repo**
(only `.platform/nginx/conf.d/elasticbeanstalk/websocket.conf`'s
`/socket.io/` location is … confirmed against live prod rather
than static config).” `trustProxy.test.ts` L9–10 confirms XFF
against a live nginx access log, not a conf path.

`.platform/nginx/` is still four files (cycle 117): three `http`
snippets (`agent-mode-timeout.conf`, `proxy_buffers.conf`,
`client_max_body_size.conf`) and one `server` `location`
(`/socket.io/`). There is **no** `.platform/nginx/nginx.conf`.
`dev.md` L6232–6235 (same AWS docs URL) names those two extend
dirs; the docs’ full-override path is `.platform/nginx/nginx.conf`,
which this tree does not ship. Tests pin the vendored four
(`nginxProxyBuffers.test.ts` L17–19; `nginxStartupTempPath.test.ts`
L23–31), never a platform catch-all filename.

AWS’s proxy page (that URL) also does **not** name
`00_application.conf`. It says the default proxy forwards :80 to
**port 5000**, and that `PORT` is how you change it. Node.js
platform docs say the platform **sets** `PORT` to the proxy’s
upstream. This tree: `server.ts` L55 `PORT || 3001`,
`package.json` L7 `node dist/server.js`, no Procfile, no
`option_settings` `PORT`. Three numbers, none of them a `/mcp`
`proxy_pass` in git: **3001** (example + mcpFetch tests), **8080**
(`/socket.io/` only), **5000** (docs default). Hermes `/mcp`
upstream filename **and** port are live-AWS-only.

What **is** in git for `/mcp` is the http-context 600s
(`agent-mode-timeout.conf` L5–7, cycle 76) — timeout, not
`proxy_pass`. Do not vendor `.platform/nginx/nginx.conf` from this
cycle instead of Q-014. Hermes/OMP: one process, no platform
proxy file to name.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Q-001 stays **ready**. Q-014 stays **ready**.

## Next

Cycle 120: cheapest remaining. Candidate: AWS docs default
upstream is **5000**; `websocket.conf` hardcodes **8080**; Node
defaults **3001**. Does any in-tree Node.js platform / solution
stack / saved EB config pick among those three, or is live
`PORT` still console-only?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
