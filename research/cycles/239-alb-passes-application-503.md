# Cycle 239 — ALB passes Application 503 through; it does not rewrite it to 502

**Date:** 2026-09-12T06:55:00Z
**Question:** Cycle 238: this tree cannot rewrite a JSON 503
(zero `error_page` in `.platform`). ALB sits in front of nginx
(`app.ts` L151). Zero `HealthCheckPath`. Does the load balancer
pass Application 503 through, or can a listener/rule turn drain
503 into 502 before nginx?
**Answer:** **ALB passes Application 503 through.** AWS: “The
load balancer forwards valid HTTP responses from targets to the
client, including HTTP errors.” ALB-generated **502** is TCP
RST / malformed response / target gone — the same class as
cycle 107’s nginx 502 after `server.close` (connect refused), not
a rewrite of Node’s JSON 503. ALB-generated **503** is “no
registered / healthy targets,” which this tree never reaches
while `/` and `/health` stay 200 (cycle 108 / 234). Listener
actions are only `forward` / `redirect` / `fixed-response` —
there is no “if upstream is 503, emit 502” action. This tree
declares **zero** listener rules. The only git `aws:elbv2:`
knob is `IdleTimeout: 600`. Do **not** add listener rules or
`fixed-response` from A-019. Do not set `HealthCheckType: ELB`.
Do not 503 `/health`. Do not add `HealthCheckPath`. Do not add
A-021.

## Evidence

### Topology is ALB → nginx → Node on one EB instance

```151:166:backend/src/app.ts
// Prod topology is ALB -> nginx -> Node, all on the same EB instance, with nginx
// proxying to Node over loopback. The EB-platform-managed nginx config for the general
// proxy location isn't in this repo (only .platform/nginx/conf.d/elasticbeanstalk/
// websocket.conf's /socket.io/ location is, as an analogous example of the same directive
// — it does not itself govern the routes below), so this is confirmed against live prod
// rather than static config: nginx sets `X-Forwarded-For: $proxy_add_x_forwarded_for`,
// which APPENDS nginx's own
// connecting address (the ALB's private IP) to whatever X-Forwarded-For it received —
// and the ALB itself already sets X-Forwarded-For to the real client IP before that.
// So by the time Express sees the request: the socket is loopback (hop 1, nginx) and
// X-Forwarded-For is "<real client>, <ALB private IP>" (hop 2 is the ALB). Trusting 2
// hops skips both and leaves the real client as `req.ip` — confirmed by spoofing
// X-Forwarded-For against live prod and reading the raw header chain Node received:
// exactly 2 trailing hops, no CDN/WAF in front. nginx's own $remote_addr is always one
// of a small set of internal ALB addresses, but that set churns across AZs, so this is
// keyed on a numeric hop count, never an IP allowlist.
```

No CDN/WAF in front (ENG-493). Hermes therefore hits ALB, then
unvendored platform nginx, then Node. Cycle 238 already: this
tree’s nginx does not intercept 503. The remaining hop is ALB.

### This tree has no listener that could remap 503

```5:6:backend/.ebextensions/timeout.config
  aws:elbv2:loadbalancer:
    IdleTimeout: 600
```

DeregistrationDelay is **intentionally not declared** (ENG-823);
`ensure_deregistration_delay` in `eb-deploy.sh` after verify.
`rg` of `backend/.ebextensions` and `.github/scripts` for
`aws:elbv2:listener`, `ListenerRule`, `fixed-response`,
`HealthCheckPath`, `Matcher`, `HttpCode`, `DefaultProcess` is
empty. `IgnoreHealthCheck: false` (`rolling.config` L4) is
`aws:elasticbeanstalk:command` (cycle 227), not a listener.
Zero `HealthCheckType` (cycle 230: default ASG check is **EC2**).

`eb-deploy.sh` L322–346 `describe-target-groups` /
`describe-target-health` reads `TargetHealth.State`. It does
not rewrite HTTP statuses. A lagging/unhealthy probe is
deploy-verify (cycle 109), not drain.

### AWS 502 is not “Application 503, remapped”

[ALB troubleshooting](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html):

- **Target HTTP errors** are forwarded: `HTTPCode_Target_5XX_Count`.
- **ALB 502** (`HTTPCode_ELB_502_Count`): TCP RST on connect,
  target FIN/RST while a request is outstanding, malformed
  headers, deregistration delay elapsed on an in-flight
  request. Cycle 107’s post-`server.close` nginx 502 (upstream
  refused) is this class one hop down; ALB would 502 the same
  way if nginx were gone.
- **ALB 503**: no registered targets, or all `unused`. That is
  “target yanked,” not Node `res.status(503).json(...)`.
- [Listener actions](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-action-types.html)
  are `forward`, `redirect`, or `fixed-response`.
  `fixed-response` **drops** the request and returns a static
  code. It cannot inspect an upstream 503 and rewrite it.

A-019 copies `runScheduledChats` L13032:

```13028:13033:backend/src/controllers/agentModeController.ts
  async runScheduledChats(req: Request, res: Response) {
    // Reject immediately when this instance is draining — the agent-engine will
    // retry in 5 seconds and the ALB will route that call to the new instance.
    if (!isCronEnabled()) {
      return res.status(503).json({ message: 'Instance draining — retry on new instance' });
    }
```

That comment already assumes ALB **routes** the retry to a new
instance. It does not claim ALB rewrites this 503. Scheduled-chat
503 is live today. If ALB remapped Application 503 to 502, that
endpoint would already be the 502 face. It is not.

Keep `/health` 200 so the target stays registered (cycle 234:
503 `/health` would make ALB generate 502/503 *before* Node
can 503 `/mcp`). Do not set `HealthCheckType: ELB` (after
close, `/health` 502 would become ASG unhealthy). Do not add
`HealthCheckPath` (cycle 108). Do not add `aws:elbv2:listener`
next to `.platform` (ENG-836: `aws:elbv2:` is resource
config; `eb-config-conflict.sh` L87).

Hermes / Oh My Pi: no ALB hop. AgentWeb’s cutting-edge SDLC is
Node JSON 503 through pass-through nginx **and** pass-through
ALB, then Immutable’s new instance on retry — not a listener
`fixed-response` as a composition bus.

## First-slice correction (A-019 stays ready)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** treat ALB as rewriting Application 503 to 502.
- Do **not** add `aws:elbv2:listener` / `fixed-response` from
  A-019.
- Do **not** 503 `/health`. Do **not** set
  `HealthCheckType: ELB`. Do **not** add `HealthCheckPath`.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: `app.ts` L169–176 names two ALB attributes
(`routing.http.xff_header_processing.mode` must stay `append`;
`routing.http.xff_client_port.enabled` must stay disabled)
that are **not in git**. Same class as cycle 119’s unnamed
nginx.conf. Does A-019 need to pin those attributes, or is that
ENG-493 / a later ops item (not A-019)? Do not add `aws:elbv2:`
resource config next to `.platform` (ENG-836). Do not 503
`/health`. Do not add A-021. Do not un-ready Q-001 / Q-014 /
Q-003. Do not revive A-006. Do not mint a timer unless Kevin asks.
