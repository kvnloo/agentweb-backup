# Cycle 231 — dying-instance 5xx does not fail the new Immutable instance

**Date:** 2026-09-12T06:18:00Z
**Question:** During Immutable overlap, can Application 5xx on
the **dying** instance (A-019 `tools/call` 503 +
`runScheduledChats` 503) fail `HealthCheckSuccessThreshold`
(unset; default `Ok`) for the **new** instance because
environment rollup includes both?
`socialPosts.ts` L16–21 says MinSize=MaxSize=1.
**Answer:** **No.** `HealthCheckSuccessThreshold` (unset in git;
AWS default `Ok`) is the bar the **new** Immutable instances
must pass. Elastic Beanstalk waits on that temporary ASG, then
terminates the old group. Dying-instance 5xx can color the old
row and the lagging environment rollup; it does not fail the
new instance’s Ok. The Min=Max=1 line is a **comment**, not an
`.ebextensions` pin (cycle 96). Do not 503 `/health`. Do not
set `HealthCheckSuccessThreshold: Warning` from A-019. Do not
add A-021.

## Evidence

### Git does not set the threshold

```1:7:backend/.ebextensions/rolling.config
option_settings:
  aws:elasticbeanstalk:command:
    DeploymentPolicy: Immutable
    IgnoreHealthCheck: false
    # 15 min: drain ceiling (10 min) + 5 min buffer.
    # Must stay above the force-exit timeout in server.ts (13 min).
    Timeout: 900
```

Zero `HealthCheckSuccessThreshold` in `backend/.ebextensions/`,
`.github/scripts/eb-deploy.sh`, or `deploy.yml`. AWS
[command options](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/command-options-general.html):
default **`Ok`**. `IgnoreHealthCheck: false` means: if the
**new** batch does not reach that bar inside Timeout 900s,
rollback by killing the **new** ASG; leave the original
instances (AWS
[immutable updates](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/environmentmgmt-updates-immutable.html),
[deployment policies](https://docs.aws.amazon.com/elasticbeanstalk/latest/dg/using-features.rolling-version-deploy.html)).

### Immutable health is the temporary group

AWS: create a **second, temporary** Auto Scaling group; “When
the **first** instance passes health checks” launch the rest;
“If the **new** instances don't pass health checks, Elastic
Beanstalk terminates them, leaving the original instances
untouched.” Enhanced health is required “to ensure that the
instances running the **new configuration** are serving requests
successfully.”

That is cycle 227 / 108: `IgnoreHealthCheck: false` waits for
the **new** instance Green before removing the old. A-019 503
runs on the old process after `disableCron()` (`server.ts`
L384–387). The new process still has cron enabled and
`/health` 200 (`app.ts` L547–553).

`socialPosts.ts` L16–21 “pinned at MinSize=MaxSize=1” is not in
`.ebextensions` (cycle 96). Git pins **overlap** (Immutable +
Sunday refresh), not a single instance. Dying 5xx therefore
always has a sibling new instance whose Ok is the command bar.

### Environment Red is the other direction (ENG-878)

`underlying_health_verdict` (`eb-deploy.sh` L249–270 / L293–299)
is GitHub **after** Ready on **this** version (cycle 109).
Comment L251–257: after Immutable **terminates the old
instance**, the rollup can sit Red while every remaining
instance is `Ok` and every target `healthy`. That is lag after
the old row is **gone**, not old 5xx failing the new row
during overlap.

The probe only runs once Status=Ready and Health is still
Grey/Red past `EB_HEALTH_SETTLE_SECONDS` (L730–748). During
overlap the environment is **Updating**, not Ready, so GitHub
does not consult dying-instance 5xx as a deploy fail. If a
Warning/Severe old row were still listed after Ready, verdict
would be `UNHEALTHY` (`ihealth != Ok`) — ENG-878’s documented
success path is “old already gone.” Do not copy that probe into
`runDrain` (cycle 109). Do not HTTP-split to host it.

Hermes / Oh My Pi: one process, no temporary ASG. AgentWeb’s
cutting-edge SDLC is in-process refuse on the old listen
(A-019) plus Immutable’s new-group health, not
`HealthCheckSuccessThreshold: Warning` to hide old 5xx.

## First-slice correction (A-019 stays ready)

Keep wait-then-`mcpShutdown` then unawaited `server.close`. Add:

- Do **not** set `HealthCheckSuccessThreshold` from A-019
  (would lower the bar for the **new** instance, not ignore
  the old).
- Do **not** 503 `/health` on either instance.
- Do **not** treat `socialPosts.ts` L16–21 as a live Min=Max=1
  pin.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: Sunday `InstanceRefreshEnabled` is **rolling on
the surviving ASG** (cycle 110), not a temporary Immutable
group. Can old-instance Application 5xx fail that rolling
batch’s health because they share one group? Do not disable
`InstanceRefreshEnabled`. Do not set
`HealthCheckSuccessThreshold`. Do not 503 `/health`. Do not
add A-021. Do not un-ready Q-001 / Q-014 / Q-003. Do not
revive A-006. Do not mint a timer unless Kevin asks.
