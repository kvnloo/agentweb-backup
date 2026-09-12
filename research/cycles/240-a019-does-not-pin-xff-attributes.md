# Cycle 240 — A-019 does not pin ALB XFF attributes; that is ENG-493

**Date:** 2026-09-12T07:10:00Z
**Question:** Cycle 239: ALB passes Application 503 through.
`app.ts` L169–176 names two ALB attributes
(`routing.http.xff_header_processing.mode` must stay `append`;
`routing.http.xff_client_port.enabled` must stay disabled) that
are **not in git**. Same class as cycle 119’s unnamed nginx.conf.
Does A-019 need to pin those attributes, or is that ENG-493 /
a later ops item (not A-019)?
**Answer:** **ENG-493 / later ops, not A-019.** Those keys are
AWS **defaults** (`append` / `false`). They are not Elastic
Beanstalk `aws:elbv2:loadbalancer` option_settings — that
namespace’s behavior knob in this tree is only `IdleTimeout`
(`timeout.config` L5–6). MCP `/mcp` has **zero** `req.ip`;
rate limit is `keyId` / `oauth:${userId}`. A-019 admission is
`isCronEnabled`, after `express.json()`. The in-process pin
is already `app.set('trust proxy', 2)` plus
`trustProxy.test.ts`. Do **not** add
`modify-load-balancer-attributes` from A-019. Do not add
`LoadBalancerAttributes` JSON next to `IdleTimeout` (not a
valid EB option). Do not add `aws:elbv2:` next to `.platform`
(ENG-836). Do not 503 `/health`. Do not add A-021.

## Evidence

### The comment already says nothing here enforces them

```168:177:backend/src/app.ts
// This is load-bearing on the ALB's own X-Forwarded-For handling, not just nginx's:
//   - routing.http.xff_header_processing.mode must stay "append" (the default). If it's
//     ever changed to "preserve", the ALB stops appending the real client IP and the
//     chain collapses to "<attacker-supplied XFF>, <ALB private IP>" — hop count 2 would
//     then resolve `req.ip` straight to an attacker-controlled value instead of skipping
//     past it, the exact spoofing class this fix (and its rework test) exists to prevent.
//   - routing.http.xff_client_port.enabled must stay disabled — enabling it appends
//     "ip:port" entries that `proxy-addr` doesn't parse as a plain address.
// Both are ALB load balancer attributes, not app code — nothing here enforces them.
app.set('trust proxy', 2);
```

`rg` of the repo for `xff_header_processing` / `xff_client_port`
hits only this comment (plus research). `timeout.config` still
declares only `IdleTimeout: 600`. `ensure_deregistration_delay`
pins a **target-group** attribute via
`modify-target-group-attributes` (`eb-deploy.sh` L796–860), not
load-balancer attributes.

AWS [LoadBalancerAttribute](https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_LoadBalancerAttribute.html):
`routing.http.xff_header_processing.mode` default **`append`**;
`routing.http.xff_client_port.enabled` default **`false`**.
That is the ENG-493 assumption. Drift would be a console
change, same class as ENG-823’s 20s deregistration default —
and the repair for that was deploy-script, not A-019.

### EB cannot name those keys next to IdleTimeout

[aws:elbv2:loadbalancer](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/command-options-general.html#command-options-general-elbv2loadbalancer)
options are AccessLogsS3*, `IdleTimeout`, `IpAddressType`,
`ManagedSecurityGroup`, `SecurityGroups`, `SharedLoadBalancer`.
**No** `xff_*`. **No** `LoadBalancerAttributes` JSON blob.
A later pin is `aws elbv2 modify-load-balancer-attributes` on
the LB ARN (cycle 119 class: live-AWS), not another line in
`timeout.config`. Putting unknown keys there is the ENG-823
silent-drop lesson. Do not add that call from A-019. Do not
pile it onto A-020 (second `put-lifecycle-hook`).

ENG-836: `aws:elbv2:` is resource config
(`eb-config-conflict.sh` L87). A-019 does not touch
`.platform` (cycle 238). Do not start.

### Drain 503 does not read XFF

`backend/src/mcp/` has zero `req.ip`. POST `/mcp`
(`mcpServer.ts` L298) rate-limits by API key / OAuth user:

```106:107:backend/src/mcp/server/mcpServer.ts
      const rateLimitResult = mcpRateLimiter.check(keyRecord.keyId, keyRecord.rateLimitPerMin);
      if (!rateLimitResult.allowed) {
```

```142:143:backend/src/mcp/server/mcpServer.ts
      const rateLimitResult = mcpRateLimiter.check(`oauth:${tokenRecord.userId}`, 60);
      if (!rateLimitResult.allowed) {
```

A-019 503 is `!isCronEnabled()` + `body.method === 'tools/call'`
after `express.json()`. Hermes OAuth is a bearer, not an IP
bucket. `trustProxy.test.ts` L51–54 pins hop count **2** for
auth login rate-limit — that is ENG-493, not MCP drain.

Hermes / Oh My Pi: no ALB XFF hop. AgentWeb’s cutting-edge SDLC
is in-process `trust proxy` 2 for `req.ip` consumers, and
in-process 503 for MCP drain — not a fifth `ensure_*` in
`eb-deploy.sh` as a composition bus.

## First-slice correction (A-019 stays ready)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** pin `routing.http.xff_header_processing.mode` or
  `routing.http.xff_client_port.enabled` from A-019.
- Do **not** add `modify-load-balancer-attributes` or a
  `LoadBalancerAttributes` JSON blob in `.ebextensions`.
- XFF drift is ENG-493 / later ops, same class as cycle 119.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: if a later ENG-493 ops item pins XFF, it would
copy `ensure_deregistration_delay` but call
`modify-load-balancer-attributes` on the **load balancer ARN**
(not the target group). Do not pile that onto A-019 or A-020.
Do not add it from this research PR. Do not 503 `/health`. Do
not add A-021. Do not un-ready Q-001 / Q-014 / Q-003. Do not
revive A-006. Do not mint a timer unless Kevin asks.
