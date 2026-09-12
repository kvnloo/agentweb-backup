# Cycle 227 — `IgnoreHealthCheck: false` is not a Wait SIGTERM

**Date:** 2026-09-12T05:44:00Z
**Question:** After A-019
`server.close`, `/health` can
fail while still
`Terminating:Wait`. File-level
only: can
`IgnoreHealthCheck: false`
health-check-restart SIGTERM
the process in the cycle 225
window? Do not 503 `/health`.

**Answer:** **No.**
`IgnoreHealthCheck: false` is
`aws:elasticbeanstalk:command`
— Immutable **deploy** waits
for the *new* instance Green
(`rolling.config` L2–4). Cycle
108 already: it does not fail
the old target on drain. After
A-019, unawaited `server.close`
502s `/health` as a **side
effect** (cycle 107) while
`completeAction` can still be
in flight (cycle 223: drain
does not join close). That is
not a process SIGTERM. Do not
503 `/health` during the wait.
Do not add `HealthCheckPath`
from A-019. Do not add A-021.

## Evidence

The knob is a **command**
option, next to Immutable and
the 900s deploy Timeout — not
a runtime health URL:

```1:7:backend/.ebextensions/rolling.config
option_settings:
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Immutable
    IgnoreHealthCheck: false
    # 15 min: drain ceiling (10 min) + 5 min buffer.
    # Must stay above the force-exit timeout in server.ts (13 min).
    Timeout: 900
```

Cycle 97 / 108: this waits for
the **new** instance before
removing the old. It is not a
restart of a
`Terminating:Wait` process.

`/` and `/health` are always
200 with **no drain case**:

```547:553:backend/src/app.ts
app.get("/", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});
```

`healthEndpoint.test.ts`
L51–75 pins that body; zero
`isCronEnabled`. During the
four-way wait they stay 200 so
mcpFetch still has PORT
(ENG-1189, `server.ts`
L404–413). Cycle 108: failing
`/health` *during that wait*
would yank the instance while
loopback still needs the
listen. A-019 refuse is at
`disableCron`, not `/health`.

After the wait, A-019 starts
unawaited `server.close`
(`server.ts` L440) **before**
drain resolves (`agentModeService.shutdown`
+ `flushTelemetry` still
awaited). Cycle 107: nginx
then 502s `/health` too. Drain
does not join that close
(cycle 223), so `/health` can
already 502 **while**
`completeAction` /
`readInstanceId` run — the
cycle 225 window. ALB
unhealthy / nginx 502 is
traffic, not
`process.exit(0)`.

Zero `HealthCheckPath` /
`UnhealthyThresholdCount` /
`HealthCheckInterval` in git
(cycle 108; still true). The
only other health
`option_settings` is
`04-disk-alarm.config`
L13–27: enhanced-health
`ConfigDocument` publishes
`RootFilesystemUtil` and
enables ELB/Application **4xx**
rules, “preserving the env's
existing health rules.” It
does not name `/health`, a
restart, or SIGTERM.

`underlying_health_verdict`
(`eb-deploy.sh` L270–375) is
deploy-verify only (cycle
109). Zero `backend/src`
callers. `dev.md` L1853’s
**health-check restart** is a
named InService SIGTERM source
(ENG-201) whose unit/path is
the same live-AWS-only class
as Sunday `TimeoutStopSec`
(cycle 116). This tree does
not prove it fires on an
instance already in
`Terminating:Wait`.

Cycle 226 still stands: L18–19
is not a withheld-SIGTERM
pin; deploy and health-check
restart remain named sources.
This cycle only names that
`IgnoreHealthCheck: false` is
**not** the Wait-window
restart.

Hermes / Oh My Pi: process
exit *is* the health fail.
AgentWeb’s cutting-edge SDLC
is in-process refuse (A-019)
plus ASG Wait (A-020), not an
ALB threshold and not a fifth
`listen()` with its own
health.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown`
then unawaited
`server.close`. Add:

- Do **not** treat
  `IgnoreHealthCheck: false`
  as a runtime restart that
  SIGTERMs `Terminating:Wait`.
- Do **not** 503 `/health`
  during the four-way wait
  (cycle 108 / ENG-1189).
- Do **not** add
  `HealthCheckPath` from
  A-019.
- After close, `/health` 502
  is expected; do not keep the
  listen up to stay Green for
  the hook.

Cycle 225 still stands: if
SIGTERM arrives after drain
resolves, `process.exit(0)`
can cut CONTINUE;
HeartbeatTimeout is the
fail-safe. Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the
architecture item after
#2+#3. This cycle only names
the deploy-command knob is
not a Wait SIGTERM. Not A-006.

## Next cycle

File-level only: A-019 HTTP
503 on POST `/mcp`
`tools/call` is 5xx during
the wait while `/health` is
still 200.
`04-disk-alarm.config` only
names **4xx** rules. Can
default enhanced-health 5xx
rules mark the instance
Severe and replace it during
`Terminating:Wait`? Do not
503 `/health`. Do not add
A-021. Do not un-ready Q-001
/ Q-014 / Q-003. Do not
revive A-006.
