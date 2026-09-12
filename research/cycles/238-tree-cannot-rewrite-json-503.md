# Cycle 238 — this tree cannot rewrite a JSON 503; do not add `error_page`

**Date:** 2026-09-12T06:46:00Z
**Question:** Cycle 237: JSON 503 is enough for SDK `send()`.
This tree’s `.platform` has zero `error_page` /
`proxy_intercept_errors`. Can unvendored platform nginx still
rewrite that JSON 503 into HTML/502 before Hermes sees it
(cycle 119: cannot name that nginx.conf)?
**Answer:** **Not from this tree.** Vendored `.platform/nginx`
is four files: timeouts, buffers, body size, `/socket.io/` —
zero `error_page` / `proxy_intercept_errors` / `proxy_next_upstream`
(cycle 107, still true). `rg` of `backend/` for those
directives is empty. The catch-all `/mcp` proxy is
EB-platform-managed and **not in git** (`app.ts` L152–155).
Stock nginx does not intercept an upstream 503 unless
`error_page` is set; cycle 107 already: this tree never remaps
nginx statuses. A live platform intercept cannot be named here
(cycle 119) and is not an A-019 body-shape change. Do **not**
add `error_page` (would replace JSON 503 with nginx HTML and
could 502 Hermes before Node’s drain face). Do not add
`.platform/nginx/nginx.conf` (full override; ENG-836
instance-only still, but not this PR). Do not add A-021.

## Evidence

### Vendored nginx never intercepts

```1:7:backend/.platform/nginx/conf.d/agent-mode-timeout.conf
proxy_connect_timeout 600s;
proxy_send_timeout 600s;
proxy_read_timeout 600s;
```

```1:12:backend/.platform/nginx/conf.d/proxy_buffers.conf
proxy_buffer_size 64k;
proxy_buffers 64 64k;
proxy_busy_buffers_size 128k;
proxy_max_temp_file_size 0;
```

`websocket.conf` is `/socket.io/` only. `client_max_body_size.conf`
is a size cap. Cycle 107: refused upstream is **502** after
`server.close`; the 600s is not that clock; **zero** `error_page`.
A-019 503 is **before** close, so the upstream is still bound
and nginx should proxy the JSON 503 as 503.

### Unvendored catch-all is not a named intercept

`app.ts` L152–155: the general proxy location is not in this
repo; confirmed against live prod for X-Forwarded-For, not
for `error_page`. Cycle 119: no `.platform/nginx/nginx.conf`;
AWS docs default upstream 5000; filename live-AWS-only.
`eb-config-conflict.sh` L190–193: every `*.platform/*` is
**instance** config. Adding `error_page` would be
instance-only (cycle 121) and still forbidden by cycle 107.

If a future live-AWS dump showed platform `error_page 503`,
Hermes `send()` would still `text()` whatever body nginx
returned and throw `StreamableHTTPError(status)` (cycle 237)
— status is the face. A-019’s job is to emit Application 503
**from Node** while the listen is up. Intercepting it is an
ops lie, not a reason to emit SSE.

Hermes / Oh My Pi: no nginx hop. AgentWeb’s cutting-edge SDLC
is Node JSON 503 through pass-through nginx, then Immutable’s
new instance on retry — not `error_page` as a composition
bus.

## First-slice correction (A-019 stays ready)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** add `error_page` / `proxy_intercept_errors` /
  `proxy_next_upstream` from A-019.
- Do **not** add `.platform/nginx/nginx.conf` from A-019.
- Do **not** treat an unnamed platform intercept as a reason
  to 404 or SSE-shape the drain.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: ALB in front of nginx (`app.ts` L151). Zero
`HealthCheckPath`. Does the load balancer pass Application 503
through, or can a listener/rule turn drain 503 into 502 before
nginx? Do not set `HealthCheckType: ELB`. Do not 503 `/health`.
Do not add A-021. Do not un-ready Q-001 / Q-014 / Q-003. Do
not revive A-006. Do not mint a timer unless Kevin asks.
