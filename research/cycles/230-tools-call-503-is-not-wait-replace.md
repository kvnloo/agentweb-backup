# Cycle 230 — A-019 `tools/call` 503 is not a Wait replacement

**Date:** 2026-09-12T06:12:00Z
**Question:** A-019 HTTP 503 on POST `/mcp` `tools/call` is 5xx
during the four-way wait while `/health` is still 200.
`04-disk-alarm.config` only names **4xx** rules. Can default
enhanced-health 5xx rules mark the instance Severe and
**replace** it during `Terminating:Wait`?
**Answer:** **No.** 503 is counted as Application 5xx (color).
It does not tell Auto Scaling to replace an instance that is
already in `Terminating:Wait`. 4xx is named in git because it
is the **only** enhanced-health rule AWS lets you customize.
5xx cannot be ignored via `ConfigDocument`. Do not 503
`/health`. Do not add `HealthCheckPath`. Do not set
`HealthCheckType: ELB`. Do not add A-021.

## Evidence

### 4xx in `04-disk-alarm.config` is not “5xx off”

```12:27:backend/.ebextensions/04-disk-alarm.config
option_settings:
  aws:elasticbeanstalk:healthreporting:system:
    ConfigDocument: |
      {
        "Version": 1,
        "CloudWatchMetrics": {
          "Instance": { "RootFilesystemUtil": 60 },
          "Environment": {}
        },
        "Rules": {
          "Environment": {
            "ELB": { "ELBRequests4xx": { "Enabled": true } },
            "Application": { "ApplicationRequests4xx": { "Enabled": true } }
          }
        }
      }
```

AWS [enhanced health rules](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/health-enhanced-rules.html):
the **only** customizable rules are application / ELB **4xx**.
“You can't configure enhanced health to ignore other HTTP errors
in addition to 4xx.” Omitting `ApplicationRequests5xx` does not
disable it. The comment on L5–6 (“preserving the env's existing
health rules”) is turning **4xx on** (and publishing
`RootFilesystemUtil`), not replacing the 5xx defaults.

A-019 POST `/mcp` `tools/call` **503** is therefore Application
5xx in the health agent’s web-server logs. Same HTTP class as
today’s drain already:

```13028:13033:backend/src/controllers/agentModeController.ts
  async runScheduledChats(req: Request, res: Response) {
    // Reject immediately when this instance is draining — the agent-engine will
    // retry in 5 seconds and the ALB will route that call to the new instance.
    if (!isCronEnabled()) {
      return res.status(503).json({ message: 'Instance draining — retry on new instance' });
    }
```

`server.ts` L384–387: `disableCron()` first so that endpoint 503s
during the wait. A-019 copies that pattern onto `/mcp`. If 5xx
were a Wait-window replace, scheduled-chat 503 would already be
it. It is not.

GET `/mcp` **405** (cycle 212) is 4xx. This ConfigDocument
**enables** `ApplicationRequests4xx`. That is why GET must stay
405 not 503: 405 is the optional-SSE skip **and** it stays out of
the un-customizable 5xx bucket.

### Color is not ASG replace

Zero `HealthCheckType`, `HealthCheckPath`,
`UnhealthyThresholdCount`, `HealthCheckInterval` in git (cycle
108; `.github/scripts` empty too). AWS default Auto Scaling
health check for an EB group is **EC2 instance status**, not
application 5xx and not ELB unless you ship

```
Resources:
  AWSEBAutoScalingGroup:
    Type: AWS::AutoScaling::AutoScalingGroup
    Properties:
      HealthCheckType: ELB
```

([EB HealthCheckType](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environmentconfig-autoscaling-healthchecktype.html)).
This tree does not. ALB target health stays on `/` and `/health`,
which stay 200 until `server.close` (`healthEndpoint.test.ts`
L51–75; `app.ts` L547–553). POST `/mcp` 503 does not fail that
probe.

`Terminating:Wait` is already the replace (`asgLifecycleGuard.ts`
L14–15). Enhanced health coloring Severe on the dying instance
does not issue a second Terminate. `CompleteLifecycleAction`
then HeartbeatTimeout 900s CONTINUE remain the fail-safe
(cycle 225). `IgnoreHealthCheck: false` still waits for the
**new** instance (cycle 227).

Do **not** 503 `/health` to “keep 5xx ratio down” (fights
ENG-1189; would be the ALB fail). Do **not** add
`HealthCheckPath`. Do **not** set `HealthCheckType: ELB` from
A-019 (after close, `/health` 502 is a side effect — ELB type
would treat that as ASG unhealthy). Do not add A-021.

Hermes / Oh My Pi: process exit *is* the health fail. AgentWeb’s
cutting-edge SDLC is in-process refuse (A-019) plus ASG Wait
(A-020), not `HealthCheckType: ELB` and not a fifth `listen()`.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown` then unawaited `server.close`. Add:

- Do **not** treat `04-disk-alarm.config` naming 4xx as “5xx
  rules are off.” 5xx is not a ConfigDocument switch.
- Do **not** set `HealthCheckType: ELB` from A-019.
- 503 on `tools/call` may color Application 5xx; copy
  `runScheduledChats`. Do not 503 `/health`.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: during Immutable overlap, can Application 5xx
on the **dying** instance (A-019 + `runScheduledChats`) fail
`HealthCheckSuccessThreshold` (unset; default `Ok`) for the
**new** instance because environment rollup includes both?
`socialPosts.ts` L16–21 says MinSize=MaxSize=1 (comment, not
`.ebextensions`). Do not set `HealthCheckType: ELB`. Do not
503 `/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer unless
Kevin asks.
